import { describe, expect, it } from "vitest";
import {
  Verdict,
  type InvariantCheck,
  type LoadedInvariant,
  type ToolCall,
  type Trajectory,
} from "../core/types.js";
import { evaluateInvariant, evaluateInvariants } from "./invariants.js";

function trajectoryWithMetrics(metrics: Record<string, number>): Trajectory {
  return { source: "driven", steps: [], metrics, metadata: {} };
}

function trajectoryWithToolCalls(toolCalls?: readonly ToolCall[]): Trajectory {
  return {
    source: "driven",
    steps: [],
    metrics: {},
    metadata: {},
    ...(toolCalls !== undefined && { toolCalls }),
  };
}

function loaded(check: InvariantCheck, source: LoadedInvariant["source"] = "repo"): LoadedInvariant {
  return { check, source };
}

describe("evaluateInvariant with a single sample (drive mode shape)", () => {
  it("passes when the one sample satisfies the check", () => {
    const check: InvariantCheck = { threshold: { metric: "turns", max: 5 } };
    const score = evaluateInvariant(loaded(check), [trajectoryWithMetrics({ turns: 3 })]);
    expect(score.verdict).toBe(Verdict.Pass);
    expect(score.name).toBe("invariant:repo:threshold:turns");
  });

  it("fails when the one sample violates the check, even with a lenient maxViolationRate", () => {
    const check: InvariantCheck = {
      threshold: { metric: "turns", max: 0 },
      maxViolationRate: 0.9,
    };
    const score = evaluateInvariant(loaded(check, "scenario"), [
      trajectoryWithMetrics({ turns: 1 }),
    ]);
    // A single violated sample has violationRate 1, which exceeds any
    // maxViolationRate below 1 -- strictness falls out of n=1 arithmetic,
    // not a forced override.
    expect(score.verdict).toBe(Verdict.Fail);
    expect(score.metadata).toMatchObject({ violationRate: 1, maxViolationRate: 0.9 });
  });

  it("treats maxViolationRate: 1 as a deliberate drive-mode opt-out", () => {
    const check: InvariantCheck = {
      threshold: { metric: "turns", max: 0 },
      maxViolationRate: 1,
    };
    const score = evaluateInvariant(loaded(check), [trajectoryWithMetrics({ turns: 1 })]);
    expect(score.verdict).toBe(Verdict.Pass);
  });
});

describe("evaluateInvariant over a population", () => {
  it("computes violationRate from pass/fail samples", () => {
    const check: InvariantCheck = {
      threshold: { metric: "turns", max: 2 },
      maxViolationRate: 0.5,
    };
    const samples = [
      trajectoryWithMetrics({ turns: 1 }), // pass
      trajectoryWithMetrics({ turns: 3 }), // fail
      trajectoryWithMetrics({ turns: 1 }), // pass
      trajectoryWithMetrics({ turns: 3 }), // fail
    ];
    const score = evaluateInvariant(loaded(check), samples);
    expect(score.metadata).toMatchObject({ violations: 2, evaluatedCount: 4, violationRate: 0.5 });
    expect(score.verdict).toBe(Verdict.Pass); // rate equals the allowance: boundary passes
  });

  it("fails once the violation rate exceeds the allowance", () => {
    const check: InvariantCheck = {
      threshold: { metric: "turns", max: 2 },
      maxViolationRate: 0.4,
    };
    const samples = [
      trajectoryWithMetrics({ turns: 1 }),
      trajectoryWithMetrics({ turns: 3 }),
      trajectoryWithMetrics({ turns: 1 }),
      trajectoryWithMetrics({ turns: 3 }),
    ];
    const score = evaluateInvariant(loaded(check), samples);
    expect(score.verdict).toBe(Verdict.Fail);
  });

  it("excludes skipped samples from the denominator", () => {
    const check: InvariantCheck = { assertion: { type: "tool_not_called", tool: "legacy" } };
    const samples = [
      trajectoryWithToolCalls([]), // evaluated: pass
      trajectoryWithToolCalls([{ name: "legacy", index: 0 }]), // evaluated: fail
      trajectoryWithToolCalls(undefined), // no evidence: skipped
    ];
    const score = evaluateInvariant(loaded(check), samples);
    expect(score.metadata).toMatchObject({ sampleCount: 3, evaluatedCount: 2, violations: 1 });
    expect(score.verdict).toBe(Verdict.Fail); // rate 0.5 > default allowance 0
  });

  it("skips entirely when every sample lacks evidence, preserving the skip marker", () => {
    const check: InvariantCheck = { assertion: { type: "tool_not_called", tool: "legacy" } };
    const samples = [trajectoryWithToolCalls(undefined), trajectoryWithToolCalls(undefined)];
    const score = evaluateInvariant(loaded(check), samples);
    expect(score.verdict).toBe(Verdict.Skip);
    expect(score.metadata.skipped).toBe("no_tool_evidence");
  });

  it("skips with a clear reason when there are no samples at all", () => {
    const check: InvariantCheck = { threshold: { metric: "turns", max: 2 } };
    const score = evaluateInvariant(loaded(check), []);
    expect(score.verdict).toBe(Verdict.Skip);
    expect(score.reason).toBe("No samples to evaluate");
  });

  it("falls back to options.defaultMaxViolationRate when the check sets none", () => {
    const check: InvariantCheck = { threshold: { metric: "turns", max: 2 } };
    const samples = [trajectoryWithMetrics({ turns: 3 }), trajectoryWithMetrics({ turns: 1 })];
    const strict = evaluateInvariant(loaded(check), samples);
    const lenient = evaluateInvariant(loaded(check), samples, { defaultMaxViolationRate: 0.5 });
    expect(strict.verdict).toBe(Verdict.Fail); // default allowance 0, rate 0.5 violates it
    expect(lenient.verdict).toBe(Verdict.Pass); // rate 0.5 equals the configured default
  });
});

describe("evaluateInvariants", () => {
  it("evaluates every entry independently, preserving source in the name", () => {
    const scores = evaluateInvariants(
      [
        loaded({ threshold: { metric: "turns", max: 5 } }, "repo"),
        loaded({ threshold: { metric: "turns", max: 5 } }, "scenario"),
      ],
      [trajectoryWithMetrics({ turns: 3 })],
    );
    expect(scores.map((score) => score.name)).toEqual([
      "invariant:repo:threshold:turns",
      "invariant:scenario:threshold:turns",
    ]);
    expect(scores.every((score) => score.verdict === Verdict.Pass)).toBe(true);
  });
});
