import {
  aggregateVerdicts,
  PupilError,
  type AssertionCheck,
  type JudgeConfig,
  type ManualScoringConfig,
  type Score,
  type ThresholdCheck,
  type Trajectory,
  type TrajectoryStep,
  Verdict,
} from "../core/types.js";
import { extractJsonPath } from "../driver/index.js";

export type AssertionEvaluationContext = Trajectory;
export type ThresholdEvaluationContext = Trajectory;

function assertionName(assertion: AssertionCheck): string {
  if (assertion.type === "jsonpath") {
    return `assertion:${assertion.type}:${assertion.target}:${assertion.path}`;
  }
  return `assertion:${assertion.type}:${assertion.target}`;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  return JSON.stringify(value);
}

function normalizeText(value: unknown, caseSensitive: boolean): string {
  const text = stringify(value);
  return caseSensitive ? text : text.toLowerCase();
}

function currentStep(context: AssertionEvaluationContext): TrajectoryStep | undefined {
  if (context.currentStepIndex !== undefined) return context.steps[context.currentStepIndex];
  return context.steps.at(-1);
}

function stepResponse(step: TrajectoryStep): { text?: string; raw?: unknown } | undefined {
  return step.output ? { text: step.output.content, raw: step.output.raw } : undefined;
}

function currentResponse(
  context: AssertionEvaluationContext,
): { text?: string; raw?: unknown } | undefined {
  // A scoped step must never resolve to another step's answer: an output-less
  // step means "no evidence", which should fail an assertion, not silently
  // borrow the final response.
  if (context.currentStepIndex !== undefined) {
    const step = context.steps[context.currentStepIndex];
    return step ? stepResponse(step) : undefined;
  }
  const step = currentStep(context);
  return (step && stepResponse(step)) ?? context.finalResponse;
}

function legacyTurnView(step: TrajectoryStep | undefined): unknown {
  if (!step) return undefined;
  const { assertions = [], ...metadata } = step.metadata as {
    assertions?: unknown;
    [key: string]: unknown;
  };
  return {
    index: step.index,
    user: step.input?.content ?? "",
    response: stepResponse(step),
    startedAt: step.startedAt,
    completedAt: step.completedAt,
    latencyMs: step.latencyMs,
    error: step.error,
    assertions,
    metadata,
  };
}

function resolveTarget(target: string, context: AssertionEvaluationContext): unknown {
  const response = currentResponse(context);
  const step = currentStep(context);
  const turn = legacyTurnView(step);

  if (target === "response.text") return response?.text;
  if (target === "response.raw") return response?.raw;
  if (target === "turn") return turn;
  if (target === "result") return context.snapshot;
  if (target === "trajectory") return context;
  if (target.startsWith("turn.")) return extractJsonPath(turn, `$.${target.slice(5)}`);
  if (target.startsWith("result."))
    return extractJsonPath(context.snapshot, `$.${target.slice(7)}`);
  if (target.startsWith("trajectory.")) {
    return extractJsonPath(context, `$.${target.slice("trajectory.".length)}`);
  }
  if (target.startsWith("response.raw.")) {
    return extractJsonPath(response?.raw, `$.${target.slice("response.raw.".length)}`);
  }
  throw new PupilError(`Unsupported assertion target: ${target}`);
}

function passScore(assertion: AssertionCheck, value: unknown, reason: string): Score {
  return {
    name: assertionName(assertion),
    verdict: Verdict.Pass,
    reason,
    value,
    metadata: { assertion },
  };
}

function failScore(assertion: AssertionCheck, value: unknown, reason: string): Score {
  return {
    name: assertionName(assertion),
    verdict: Verdict.Fail,
    reason,
    value,
    metadata: { assertion },
  };
}

function evaluateTextAssertion(
  assertion: Exclude<AssertionCheck, { type: "jsonpath" }>,
  context: AssertionEvaluationContext,
): Score {
  const value = resolveTarget(assertion.target, context);
  const actual = normalizeText(value, assertion.caseSensitive);
  const expected = assertion.caseSensitive ? assertion.value : assertion.value.toLowerCase();

  if (assertion.type === "contains") {
    return actual.includes(expected)
      ? passScore(assertion, value, `Expected ${assertion.target} to contain ${assertion.value}`)
      : failScore(assertion, value, `Expected ${assertion.target} to contain ${assertion.value}`);
  }

  if (assertion.type === "not_contains") {
    return !actual.includes(expected)
      ? passScore(
          assertion,
          value,
          `Expected ${assertion.target} not to contain ${assertion.value}`,
        )
      : failScore(
          assertion,
          value,
          `Expected ${assertion.target} not to contain ${assertion.value}`,
        );
  }

  if (assertion.type === "equals") {
    return actual === expected
      ? passScore(assertion, value, `Expected ${assertion.target} to equal ${assertion.value}`)
      : failScore(assertion, value, `Expected ${assertion.target} to equal ${assertion.value}`);
  }

  const flags = assertion.caseSensitive ? "" : "i";
  const regex = new RegExp(assertion.value, flags);
  return regex.test(stringify(value))
    ? passScore(assertion, value, `Expected ${assertion.target} to match /${assertion.value}/`)
    : failScore(assertion, value, `Expected ${assertion.target} to match /${assertion.value}/`);
}

function evaluateJsonPathAssertion(
  assertion: Extract<AssertionCheck, { type: "jsonpath" }>,
  context: AssertionEvaluationContext,
): Score {
  const target = resolveTarget(assertion.target, context);
  const value = extractJsonPath(target, assertion.path);

  if (assertion.exists !== undefined) {
    const exists = value !== undefined;
    if (exists === assertion.exists) {
      return passScore(assertion, value, `Expected ${assertion.path} exists=${assertion.exists}`);
    }
    return failScore(assertion, value, `Expected ${assertion.path} exists=${assertion.exists}`);
  }

  if (Object.is(value, assertion.equals)) {
    return passScore(
      assertion,
      value,
      `Expected ${assertion.path} to equal ${stringify(assertion.equals)}`,
    );
  }
  return failScore(
    assertion,
    value,
    `Expected ${assertion.path} to equal ${stringify(assertion.equals)}`,
  );
}

export function evaluateAssertion(
  assertion: AssertionCheck,
  context: AssertionEvaluationContext,
): Score {
  try {
    if (assertion.type === "jsonpath") {
      return evaluateJsonPathAssertion(assertion, context);
    }
    return evaluateTextAssertion(assertion, context);
  } catch (error) {
    return {
      name: assertionName(assertion),
      verdict: Verdict.Fail,
      reason: error instanceof Error ? error.message : String(error),
      metadata: { assertion },
    };
  }
}

export function evaluateAssertions(
  assertions: readonly AssertionCheck[],
  context: AssertionEvaluationContext,
): Score[] {
  return assertions.map((assertion) => evaluateAssertion(assertion, context));
}

export function aggregateScores(scores: readonly Score[]): Verdict {
  return aggregateVerdicts(scores.map((score) => score.verdict));
}

export function manualScoreName(criterion: string): string {
  return `manual:${criterion}`;
}

export function evaluateManualScoring(manual: ManualScoringConfig | undefined): Score[] {
  if (!manual?.required) return [];

  return manual.criteria.map((criterion) => ({
    name: manualScoreName(criterion),
    verdict: Verdict.NeedsReview,
    reason: "Manual score required",
    metadata: {
      manual: {
        criterion,
        prompt: manual.prompt,
        rubric: manual.rubric,
      },
    },
  }));
}

export function evaluateJudge(judge: JudgeConfig | undefined): Score[] {
  if (!judge?.enabled) return [];

  return [
    {
      name: "judge",
      verdict: Verdict.Skip,
      reason: "LLM judge not configured",
      metadata: { judge },
    },
  ];
}

function thresholdName(threshold: ThresholdCheck): string {
  return `threshold:${threshold.metric}`;
}

function metricKey(metric: string): string {
  const normalized = metric.toLowerCase().replace(/[_-]/g, "");
  if (normalized === "maxturns" || normalized === "turns" || normalized === "turncount") {
    return "turns";
  }
  if (normalized === "maxlatencyms" || normalized === "latencyms") {
    return "latency_ms";
  }
  if (normalized === "maxcostusd" || normalized === "costusd") {
    return "cost_usd";
  }
  return metric;
}

function skippedThresholdScore(threshold: ThresholdCheck, reason: string): Score {
  return {
    name: thresholdName(threshold),
    verdict: Verdict.Skip,
    reason,
    metadata: { threshold },
  };
}

function thresholdScore(
  threshold: ThresholdCheck,
  verdict: Verdict.Pass | Verdict.Fail,
  value: number,
  reason: string,
): Score {
  return {
    name: thresholdName(threshold),
    verdict,
    reason,
    value,
    metadata: { threshold },
  };
}

export function evaluateThreshold(
  threshold: ThresholdCheck,
  context: ThresholdEvaluationContext,
): Score {
  const key = metricKey(threshold.metric);
  const value = context.metrics[key];

  if (value === undefined) {
    if (key === "cost_usd") {
      return skippedThresholdScore(threshold, "Cost metric is missing; skipping cost threshold");
    }
    return {
      name: thresholdName(threshold),
      verdict: Verdict.Fail,
      reason: `Metric ${key} is missing`,
      metadata: { threshold },
    };
  }

  if (threshold.max !== undefined && value > threshold.max) {
    return thresholdScore(threshold, Verdict.Fail, value, `Expected ${key} <= ${threshold.max}`);
  }
  if (threshold.min !== undefined && value < threshold.min) {
    return thresholdScore(threshold, Verdict.Fail, value, `Expected ${key} >= ${threshold.min}`);
  }

  const bounds = [
    threshold.min !== undefined ? `>= ${threshold.min}` : undefined,
    threshold.max !== undefined ? `<= ${threshold.max}` : undefined,
  ]
    .filter(Boolean)
    .join(" and ");
  return thresholdScore(threshold, Verdict.Pass, value, `Expected ${key} ${bounds}`);
}

export function evaluateThresholds(
  thresholds: readonly ThresholdCheck[],
  context: ThresholdEvaluationContext,
): Score[] {
  return thresholds.map((threshold) => evaluateThreshold(threshold, context));
}
