import { describe, expect, it } from "vitest";
import { Verdict, type RunResult, type ScenarioResult } from "../core/types.js";
import { compareRuns, formatRunComparison } from "./compare.js";

function scenario(overrides: Partial<ScenarioResult> & { scenarioId: string }): ScenarioResult {
  const { scenarioId, ...rest } = overrides;
  return {
    scenarioId,
    scenarioName: overrides.scenarioName ?? scenarioId,
    verdict: overrides.verdict ?? Verdict.Pass,
    scores: [],
    turns: [],
    startedAt: "2026-07-27T00:00:00.000Z",
    completedAt: "2026-07-27T00:00:01.000Z",
    metrics: overrides.metrics ?? { turns: 1, latency_ms: 1000 },
    ...rest,
  };
}

function run(runId: string, results: ScenarioResult[]): RunResult {
  return {
    runId,
    verdict: results.some((result) => result.verdict !== Verdict.Pass)
      ? Verdict.Fail
      : Verdict.Pass,
    results,
    startedAt: "2026-07-27T00:00:00.000Z",
    completedAt: "2026-07-27T00:00:01.000Z",
    summary: {
      total: results.length,
      passed: results.filter((result) => result.verdict === Verdict.Pass).length,
      failed: results.filter((result) => result.verdict === Verdict.Fail).length,
      needsReview: results.filter((result) => result.verdict === Verdict.NeedsReview).length,
      errors: results.filter((result) => result.verdict === Verdict.Error).length,
    },
    metadata: {},
  };
}

describe("run comparison", () => {
  it("classifies scenarios deterministically", () => {
    const base = run("base", [
      scenario({ scenarioId: "removed" }),
      scenario({ scenarioId: "regressed" }),
      scenario({ scenarioId: "fixed", verdict: Verdict.Fail }),
      scenario({ scenarioId: "still", verdict: Verdict.Error }),
      scenario({ scenarioId: "unchanged" }),
    ]);
    const current = run("current", [
      scenario({ scenarioId: "new" }),
      scenario({ scenarioId: "regressed", verdict: Verdict.Fail }),
      scenario({ scenarioId: "fixed" }),
      scenario({ scenarioId: "still", verdict: Verdict.Fail }),
      scenario({ scenarioId: "unchanged" }),
    ]);

    const comparison = compareRuns(base, current, { latencyRegressionThresholdMs: 100 });

    expect(comparison.scenarios.map((item) => [item.scenarioId, item.status])).toEqual([
      ["fixed", "fixed"],
      ["new", "new"],
      ["regressed", "regressed"],
      ["removed", "removed"],
      ["still", "still_failing"],
      ["unchanged", "unchanged"],
    ]);
    expect(comparison.summary).toMatchObject({
      fixed: 1,
      new: 1,
      regressed: 1,
      removed: 1,
      still_failing: 1,
      unchanged: 1,
    });
    expect(comparison.hasRegressions).toBe(true);
  });

  it("treats skip and pass transitions as unchanged", () => {
    const base = run("base", [
      scenario({ scenarioId: "pass-to-skip", verdict: Verdict.Pass }),
      scenario({ scenarioId: "skip-to-pass", verdict: Verdict.Skip }),
    ]);
    const current = run("current", [
      scenario({ scenarioId: "pass-to-skip", verdict: Verdict.Skip }),
      scenario({ scenarioId: "skip-to-pass", verdict: Verdict.Pass }),
    ]);

    const comparison = compareRuns(base, current);

    expect(comparison.scenarios.map((item) => [item.scenarioId, item.status])).toEqual([
      ["pass-to-skip", "unchanged"],
      ["skip-to-pass", "unchanged"],
    ]);
    expect(comparison.hasRegressions).toBe(false);
    expect(comparison.summary).toMatchObject({ unchanged: 2, regressed: 0, fixed: 0 });
  });

  it("uses a 20 percent latency band by default", () => {
    const base = run("base", [
      scenario({ scenarioId: "small-noise", metrics: { latency_ms: 1001, turns: 1 } }),
      scenario({ scenarioId: "large-regression", metrics: { latency_ms: 1001, turns: 1 } }),
    ]);
    const current = run("current", [
      scenario({ scenarioId: "small-noise", metrics: { latency_ms: 1002, turns: 1 } }),
      scenario({ scenarioId: "large-regression", metrics: { latency_ms: 1202, turns: 1 } }),
    ]);

    const comparison = compareRuns(base, current);
    const smallNoise = comparison.scenarios.find((item) => item.scenarioId === "small-noise");
    const largeRegression = comparison.scenarios.find(
      (item) => item.scenarioId === "large-regression",
    );

    expect(smallNoise?.regression).toBe(false);
    expect(smallNoise?.metrics.find((metric) => metric.metric === "latency_ms")).toMatchObject({
      delta: 1,
      regression: false,
      threshold: 200.2,
    });
    expect(largeRegression?.regression).toBe(true);
    expect(largeRegression?.metrics.find((metric) => metric.metric === "latency_ms")).toMatchObject(
      {
        delta: 201,
        regression: true,
        threshold: 200.2,
      },
    );
    expect(comparison.summary.metricRegressions).toBe(1);
  });

  it("allows callers to override the latency percentage band", () => {
    const base = run("base", [
      scenario({ scenarioId: "latency", metrics: { latency_ms: 1000, turns: 1 } }),
    ]);
    const current = run("current", [
      scenario({ scenarioId: "latency", metrics: { latency_ms: 1151, turns: 1 } }),
    ]);

    const defaultComparison = compareRuns(base, current);
    const customComparison = compareRuns(base, current, { latencyRegressionThresholdPct: 0.15 });

    expect(defaultComparison.hasRegressions).toBe(false);
    expect(customComparison.hasRegressions).toBe(true);
    expect(customComparison.scenarios[0]?.metrics[0]).toMatchObject({
      delta: 151,
      regression: true,
      threshold: 150,
    });
  });

  it("flags latency increases beyond threshold and records metric deltas", () => {
    const base = run("base", [
      scenario({ scenarioId: "slow", metrics: { latency_ms: 1000, turns: 1 } }),
    ]);
    const current = run("current", [
      scenario({ scenarioId: "slow", metrics: { latency_ms: 1251, turns: 2 } }),
    ]);

    const comparison = compareRuns(base, current, { latencyRegressionThresholdMs: 250 });
    const slow = comparison.scenarios[0];

    expect(slow.status).toBe("unchanged");
    expect(slow.regression).toBe(true);
    expect(slow.metrics).toEqual([
      {
        metric: "latency_ms",
        before: 1000,
        after: 1251,
        delta: 251,
        regression: true,
        threshold: 250,
      },
      {
        metric: "turns",
        before: 1,
        after: 2,
        delta: 1,
        regression: false,
        threshold: undefined,
      },
    ]);
    expect(comparison.summary.metricRegressions).toBe(1);
  });

  it("formats comparison output in scenario id order", () => {
    const comparison = compareRuns(
      run("base", [scenario({ scenarioId: "b" }), scenario({ scenarioId: "a" })]),
      run("current", [
        scenario({ scenarioId: "b", metrics: { latency_ms: 1001, turns: 1 } }),
        scenario({ scenarioId: "a" }),
      ]),
    );

    expect(formatRunComparison(comparison)).toContain(
      [
        "Comparison base -> current",
        "Summary: regressed=0 fixed=0 still_failing=0 new=0 removed=0 unchanged=2 metric_regressions=0",
        "UNCHANGED a: pass -> pass",
        "  metric latency_ms: 1000 -> 1000 (delta 0)",
        "  metric turns: 1 -> 1 (delta 0)",
        "UNCHANGED b: pass -> pass",
      ].join("\n"),
    );
  });
});
