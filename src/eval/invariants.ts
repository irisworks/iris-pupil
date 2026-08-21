import {
  Verdict,
  type InvariantCheck,
  type LoadedInvariant,
  type Score,
  type Trajectory,
} from "../core/types.js";
import { assertionName, evaluateAssertion, evaluateThreshold, thresholdName } from "./index.js";

export interface InvariantEvaluationOptions {
  /** From config.invariants.defaultMaxViolationRate. Used only when a check sets none of its own. */
  defaultMaxViolationRate?: number;
}

function evaluateSample(check: InvariantCheck, sample: Trajectory): Score {
  return check.assertion !== undefined
    ? evaluateAssertion(check.assertion, sample)
    : evaluateThreshold(check.threshold, sample);
}

function invariantName(source: string, innerName: string): string {
  return `invariant:${source}:${innerName}`;
}

// Mirrors the name the real per-sample evaluator would produce, so a check's
// Score name has the same shape whether it hits this zero-samples path or the
// normal path below (perSample[0]!.name). Reuses assertionName/thresholdName
// from ./index.js rather than re-deriving the naming convention here.
function checkLabel(check: InvariantCheck): string {
  return check.assertion !== undefined
    ? assertionName(check.assertion)
    : thresholdName(check.threshold);
}

/**
 * Deliberately mode-oblivious: this never learns whether `samples` came from
 * a driven run (length 1, see the runner) or a fetched trace population
 * (IRIS-164). Drive-mode strictness is not a special case here -- it falls
 * out of a single sample's violationRate always being 0 or 1.
 */
export function evaluateInvariant(
  loaded: LoadedInvariant,
  samples: readonly Trajectory[],
  options: InvariantEvaluationOptions = {},
): Score {
  if (samples.length === 0) {
    // No `metadata.skipped` marker here, so --require-trace never escalates this
    // skip. That's correct today: pupil run always supplies exactly one sample,
    // so zero samples can't happen in practice. Revisit once pupil observe
    // (IRIS-164) can produce a genuinely empty trace-window population -- at
    // that point a --require-trace run going green having checked nothing would
    // be the wrong outcome, and this branch will need a marker too.
    return {
      name: invariantName(loaded.source, checkLabel(loaded.check)),
      verdict: Verdict.Skip,
      reason: "No samples to evaluate",
      metadata: { check: loaded.check, source: loaded.source, sampleCount: 0, evaluatedCount: 0 },
    };
  }

  const perSample = samples.map((sample) => evaluateSample(loaded.check, sample));
  const evaluated = perSample.filter((score) => score.verdict !== Verdict.Skip);
  const name = invariantName(loaded.source, perSample[0]!.name);

  if (evaluated.length === 0) {
    const firstSkip = perSample[0]!;
    return {
      name,
      verdict: Verdict.Skip,
      reason: firstSkip.reason ?? "No evidence available",
      metadata: {
        check: loaded.check,
        source: loaded.source,
        sampleCount: samples.length,
        evaluatedCount: 0,
        ...(firstSkip.metadata.skipped !== undefined && { skipped: firstSkip.metadata.skipped }),
      },
    };
  }

  const violations = evaluated.filter((score) => score.verdict === Verdict.Fail).length;
  const violationRate = violations / evaluated.length;
  const maxViolationRate = loaded.check.maxViolationRate ?? options.defaultMaxViolationRate ?? 0;
  const verdict = violationRate <= maxViolationRate ? Verdict.Pass : Verdict.Fail;

  return {
    name,
    verdict,
    reason: `Violated in ${violations}/${evaluated.length} sample(s) (rate ${violationRate}, max ${maxViolationRate})`,
    value: violationRate,
    metadata: {
      check: loaded.check,
      source: loaded.source,
      sampleCount: samples.length,
      evaluatedCount: evaluated.length,
      violations,
      violationRate,
      maxViolationRate,
    },
  };
}

export function evaluateInvariants(
  loaded: readonly LoadedInvariant[],
  samples: readonly Trajectory[],
  options: InvariantEvaluationOptions = {},
): Score[] {
  return loaded.map((entry) => evaluateInvariant(entry, samples, options));
}
