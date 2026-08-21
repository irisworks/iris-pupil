import { describe, expect, it } from "vitest";
import {
  aggregateVerdicts,
  Verdict,
  type AssertionCheck,
  type InvariantCheck,
  type LoadedInvariant,
  type RunResult,
} from "./types.js";

describe("aggregateVerdicts", () => {
  it("returns pass for an empty set of child verdicts", () => {
    expect(aggregateVerdicts([])).toBe(Verdict.Pass);
  });

  it("keeps pass when all child verdicts pass", () => {
    expect(aggregateVerdicts([Verdict.Pass, Verdict.Pass])).toBe(Verdict.Pass);
  });

  it("uses conservative precedence for mixed verdicts", () => {
    expect(aggregateVerdicts([Verdict.Pass, Verdict.NeedsReview])).toBe(Verdict.NeedsReview);
    expect(aggregateVerdicts([Verdict.NeedsReview, Verdict.Fail])).toBe(Verdict.Fail);
    expect(aggregateVerdicts([Verdict.Fail, Verdict.Error])).toBe(Verdict.Error);
  });
});

describe("core domain types", () => {
  it("supports text and jsonpath assertions", () => {
    const assertions: AssertionCheck[] = [
      {
        type: "contains",
        target: "response.text",
        value: "booked",
        caseSensitive: false,
      },
      {
        type: "jsonpath",
        target: "response.raw",
        path: "$.calendar.eventId",
        exists: true,
      },
    ];

    expect(assertions).toHaveLength(2);
  });

  it("models assertion and threshold invariant wrappers with their source", () => {
    const invariants: LoadedInvariant[] = [
      {
        source: "repo",
        check: {
          assertion: { type: "tool_not_called", tool: "deprecated.legacy_search" },
          maxViolationRate: 0,
        },
      },
      {
        source: "scenario",
        check: {
          threshold: { metric: "tool_invocations", max: 4 },
          maxViolationRate: 0.02,
        },
      },
    ];

    const first: InvariantCheck | undefined = invariants[0]?.check;
    expect(first).toMatchObject({ assertion: { type: "tool_not_called" } });
    expect(invariants[1]?.source).toBe("scenario");
  });

  it("models a reusable run result", () => {
    const run: RunResult = {
      runId: "run-1",
      verdict: Verdict.Pass,
      startedAt: "2026-07-13T00:00:00.000Z",
      completedAt: "2026-07-13T00:00:01.000Z",
      metadata: {},
      results: [],
      summary: {
        total: 0,
        passed: 0,
        failed: 0,
        needsReview: 0,
        errors: 0,
      },
    };

    expect(run.verdict).toBe(Verdict.Pass);
  });

  it("accepts a RunResult with a full target identity", () => {
    const run: RunResult = {
      runId: "run-1",
      verdict: Verdict.Pass,
      startedAt: "2026-08-06T00:00:00.000Z",
      completedAt: "2026-08-06T00:01:00.000Z",
      metadata: {},
      results: [],
      summary: { total: 0, passed: 0, failed: 0, needsReview: 0, errors: 0 },
      target: {
        system: "support-agent",
        environment: "staging",
        version: "v2.3.1",
        mode: "driven",
        fixtureSet: "live",
      },
    };

    expect(run.target?.system).toBe("support-agent");
    expect(run.target?.mode).toBe("driven");
  });

  it("accepts a RunResult without target (legacy compatibility)", () => {
    const run: RunResult = {
      runId: "run-2",
      verdict: Verdict.Pass,
      startedAt: "2026-08-06T00:00:00.000Z",
      completedAt: "2026-08-06T00:01:00.000Z",
      metadata: {},
      results: [],
      summary: { total: 0, passed: 0, failed: 0, needsReview: 0, errors: 0 },
    };

    expect(run.target).toBeUndefined();
  });
});
