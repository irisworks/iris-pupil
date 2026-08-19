import { describe, expect, it } from "vitest";
import { Verdict, type RunResult, type ScenarioResult } from "../core/types.js";
import { compareRuns, formatRunComparison } from "./compare.js";
import type { TargetIdentity } from "../core/types.js";

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

function runWithTarget(
  runId: string,
  results: ScenarioResult[],
  target?: TargetIdentity,
): RunResult {
  return { ...run(runId, results), target };
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

describe("target identity mismatch detection", () => {
  it("emits a hard mismatch when mode differs", () => {
    const base = runWithTarget("base", [], { mode: "driven" });
    const current = runWithTarget("current", [], { mode: "observed" });

    const comparison = compareRuns(base, current);

    expect(comparison.targetMismatch).toEqual([
      { field: "mode", severity: "hard", base: "driven", current: "observed" },
    ]);
    expect(comparison.hasRegressions).toBe(false);
  });

  it("emits a hard mismatch when fixtureSet differs", () => {
    const base = runWithTarget("base", [], { mode: "driven", fixtureSet: "stubbed" });
    const current = runWithTarget("current", [], { mode: "driven", fixtureSet: "live" });

    const comparison = compareRuns(base, current);

    expect(comparison.targetMismatch).toEqual([
      { field: "fixtureSet", severity: "hard", base: "stubbed", current: "live" },
    ]);
  });

  it("emits a hard mismatch when system differs", () => {
    const base = runWithTarget("base", [], { mode: "driven", system: "support-agent" });
    const current = runWithTarget("current", [], { mode: "driven", system: "travel-agent" });

    const comparison = compareRuns(base, current);

    expect(comparison.targetMismatch).toEqual([
      { field: "system", severity: "hard", base: "support-agent", current: "travel-agent" },
    ]);
  });

  it("emits a soft mismatch when environment differs", () => {
    const base = runWithTarget("base", [], { mode: "driven", environment: "staging" });
    const current = runWithTarget("current", [], { mode: "driven", environment: "production" });

    const comparison = compareRuns(base, current);

    expect(comparison.targetMismatch).toEqual([
      { field: "environment", severity: "soft", base: "staging", current: "production" },
    ]);
  });

  it("emits a soft mismatch when version differs", () => {
    const base = runWithTarget("base", [], { mode: "driven", version: "v2.3.1" });
    const current = runWithTarget("current", [], { mode: "driven", version: "v2.3.2" });

    const comparison = compareRuns(base, current);

    expect(comparison.targetMismatch).toEqual([
      { field: "version", severity: "soft", base: "v2.3.1", current: "v2.3.2" },
    ]);
  });

  it("emits a hard mismatch on fields set only by the tracked run, and flags unknown provenance, when a run predates target tracking", () => {
    const base = run("base", []);
    const current = runWithTarget("current", [], { mode: "driven", environment: "production" });

    const comparison = compareRuns(base, current);

    expect(comparison.targetMismatch).toEqual([
      { field: "mode", severity: "hard", base: undefined, current: "driven" },
    ]);
    expect(comparison.targetIdentityUnknown).toBe(true);
  });

  it("does not flag unknown provenance when both runs carry a target", () => {
    const base = runWithTarget("base", [], { mode: "driven" });
    const current = runWithTarget("current", [], { mode: "driven" });

    const comparison = compareRuns(base, current);

    expect(comparison.targetIdentityUnknown).toBe(false);
  });

  it("formats an info notice with no warning when both runs predate target tracking", () => {
    const base = run("base", []);
    const current = run("current", []);

    const output = formatRunComparison(compareRuns(base, current));

    expect(output).toContain("ℹ Target identity unknown");
    expect(output).not.toContain("⚠");
  });

  it("formats both a hard warning and the unknown-provenance notice when only one run predates tracking", () => {
    const base = run("base", []);
    const current = runWithTarget("current", [], { mode: "driven" });

    const output = formatRunComparison(compareRuns(base, current));

    expect(output).toContain("⚠ Comparison may be invalid");
    expect(output).toContain("ℹ Target identity unknown");
  });

  it("emits no mismatch when a field is absent on one target but present on the other", () => {
    const base = runWithTarget("base", [], { mode: "driven", environment: "staging" });
    const current = runWithTarget("current", [], { mode: "driven" });

    const comparison = compareRuns(base, current);

    expect(comparison.targetMismatch).toEqual([]);
  });

  it("emits a hard mismatch when a hard field is present on one side only", () => {
    const base = runWithTarget("base", [], { mode: "driven", fixtureSet: "stubbed" });
    const current = runWithTarget("current", [], { mode: "driven" });

    const comparison = compareRuns(base, current);

    expect(comparison.targetMismatch).toEqual([
      { field: "fixtureSet", severity: "hard", base: "stubbed", current: undefined },
    ]);
  });

  it("emits no mismatch when target fields match", () => {
    const identity = { mode: "driven" as const, environment: "staging" };
    const comparison = compareRuns(
      runWithTarget("base", [], identity),
      runWithTarget("current", [], identity),
    );

    expect(comparison.targetMismatch).toEqual([]);
  });

  it("does not affect hasRegressions", () => {
    const base = runWithTarget("base", [], { mode: "driven" });
    const current = runWithTarget("current", [], { mode: "observed" });

    const comparison = compareRuns(base, current);

    expect(comparison.hasRegressions).toBe(false);
    expect(comparison.targetMismatch[0].severity).toBe("hard");
  });

  it("formats hard mismatches as a prominent warning block before the scenario list", () => {
    const base = runWithTarget("base", [], { mode: "driven", fixtureSet: "stubbed" });
    const current = runWithTarget("current", [], { mode: "observed", fixtureSet: "live" });

    const output = formatRunComparison(compareRuns(base, current));

    expect(output).toContain("⚠ Comparison may be invalid");
    expect(output).toContain("mode: driven");
    expect(output).toContain("mode: observed");
    expect(output).toContain("Regression metrics may not be meaningful.");
  });

  it("formats soft mismatches as a cross-target warning", () => {
    const base = runWithTarget("base", [], {
      mode: "driven",
      environment: "staging",
      version: "v1",
    });
    const current = runWithTarget("current", [], {
      mode: "driven",
      environment: "production",
      version: "v2",
    });

    const output = formatRunComparison(compareRuns(base, current));

    expect(output).toContain("⚠ Cross-target comparison");
    expect(output).toContain("environment: staging");
    expect(output).toContain("environment: production");
    expect(output).not.toContain("Comparison may be invalid");
  });

  it("does not show the cross-target block when only hard mismatches exist", () => {
    const base = runWithTarget("base", [], { mode: "driven" });
    const current = runWithTarget("current", [], { mode: "observed" });

    const output = formatRunComparison(compareRuns(base, current));

    expect(output).toContain("⚠ Comparison may be invalid");
    expect(output).not.toContain("Cross-target");
  });
});
