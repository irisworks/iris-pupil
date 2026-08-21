import { describe, it, expect } from "vitest";
import { PupilError, Verdict, type LoadedInvariant, type Trajectory } from "../core/types.js";
import { buildObserveResult, resolvePopulationQuery } from "./index.js";

describe("resolvePopulationQuery", () => {
  const populations = { "checkout-prod": { since: "24h", tags: ["prod"] } };

  it("returns the named population's config as a query", () => {
    expect(resolvePopulationQuery(populations, "checkout-prod", {})).toEqual({
      since: "24h",
      tags: ["prod"],
    });
  });

  it("lets overrides win over the config", () => {
    expect(
      resolvePopulationQuery(populations, "checkout-prod", { since: "7d", limit: 10 }),
    ).toEqual({ since: "7d", tags: ["prod"], limit: 10 });
  });

  it("throws for an unknown population with no since override", () => {
    expect(() => resolvePopulationQuery(populations, "unknown", {})).toThrow(PupilError);
  });

  it("throws when no since is available from either config or overrides", () => {
    expect(() => resolvePopulationQuery({}, "unknown", { tags: ["prod"] })).toThrow(/since/);
  });

  it("lets overrides establish a query for a population absent from config, given a since", () => {
    expect(resolvePopulationQuery({}, "ad-hoc", { since: "1h" })).toEqual({ since: "1h" });
  });
});

function trajectory(overrides: Partial<Trajectory> = {}): Trajectory {
  return { source: "trace", steps: [], metrics: {}, metadata: {}, ...overrides };
}

describe("buildObserveResult", () => {
  const passingInvariant: LoadedInvariant = {
    source: "repo",
    check: { threshold: { metric: "tool_calls", max: 5 } },
  };

  it("evaluates invariants across the population and builds a RunResult", () => {
    const trajectories = [trajectory({ metrics: { tool_calls: 1 } })];
    const run = buildObserveResult({
      populationName: "checkout-prod",
      query: { since: "24h" },
      trajectories,
      invariants: [passingInvariant],
      requireTrace: false,
      target: { mode: "observed" },
    });

    expect(run.target).toEqual({ mode: "observed" });
    expect(run.results).toHaveLength(1);
    const [scenario] = run.results;
    expect(scenario.scenarioId).toBe("checkout-prod");
    expect(scenario.turns).toEqual([]);
    expect(scenario.verdict).toBe(Verdict.Pass);
    expect(scenario.metadata?.observe).toEqual({
      population: "checkout-prod",
      filters: { since: "24h" },
      traceCount: 1,
    });
    expect(run.verdict).toBe(Verdict.Pass);
    expect(run.summary).toEqual({ total: 1, passed: 1, failed: 0, needsReview: 0, errors: 0 });
  });

  it("fails the scenario when a population invariant is violated", () => {
    const trajectories = [trajectory({ metrics: { tool_calls: 10 } })];
    const run = buildObserveResult({
      populationName: "checkout-prod",
      query: { since: "24h" },
      trajectories,
      invariants: [passingInvariant],
      requireTrace: false,
      target: { mode: "observed" },
    });
    expect(run.results[0]?.verdict).toBe(Verdict.Fail);
  });

  it("skips every check for an empty population", () => {
    const run = buildObserveResult({
      populationName: "checkout-prod",
      query: { since: "24h" },
      trajectories: [],
      invariants: [passingInvariant],
      requireTrace: false,
      target: { mode: "observed" },
    });
    expect(run.results[0]?.verdict).toBe(Verdict.Pass);
    expect(run.results[0]?.metadata?.observe).toEqual({
      population: "checkout-prod",
      filters: { since: "24h" },
      traceCount: 0,
    });
  });
});
