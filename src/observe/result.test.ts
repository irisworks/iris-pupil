import { describe, it, expect } from "vitest";
import { Verdict, type LoadedInvariant, type Trajectory } from "../core/types.js";
import { buildObserveResult } from "./result.js";

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

  it("records evaluatedCount as the max evaluatedCount across scores", () => {
    const trajectories = [
      trajectory({ metrics: { tool_calls: 1 } }),
      trajectory({ metrics: { tool_calls: 2 } }),
    ];
    const run = buildObserveResult({
      populationName: "checkout-prod",
      query: { since: "24h" },
      trajectories,
      invariants: [passingInvariant],
      requireTrace: false,
      target: { mode: "observed" },
    });
    expect(run.results[0]?.metrics).toMatchObject({ traceCount: 2, evaluatedCount: 2 });
  });

  it("stamps metadata under sourceMetadataKey when provided", () => {
    const run = buildObserveResult({
      populationName: "checkout-prod",
      query: { since: "24h" },
      trajectories: [],
      invariants: [passingInvariant],
      requireTrace: false,
      target: { mode: "observed" },
      sourceMetadataKey: "langfuse",
    });
    expect(run.metadata).toEqual({ langfuse: { populationSource: true } });
  });

  it("leaves metadata empty when sourceMetadataKey is omitted", () => {
    const run = buildObserveResult({
      populationName: "checkout-prod",
      query: { since: "24h" },
      trajectories: [],
      invariants: [passingInvariant],
      requireTrace: false,
      target: { mode: "observed" },
    });
    expect(run.metadata).toEqual({});
  });
});
