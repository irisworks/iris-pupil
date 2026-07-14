import { describe, expect, it } from "vitest";
import { aggregateVerdicts, Verdict, type AssertionCheck, type RunResult } from "./types.js";

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
});
