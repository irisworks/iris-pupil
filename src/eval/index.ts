import {
  aggregateVerdicts,
  PupilError,
  type AssertionCheck,
  type JudgeConfig,
  type ManualScoringConfig,
  type Score,
  type ThresholdCheck,
  type ToolAssertionCheck,
  type Trajectory,
  type TrajectoryStep,
  Verdict,
} from "../core/types.js";
import type { JudgeProvider } from "../judge/types.js";
import { extractJsonPath } from "../driver/index.js";
import { formatBounds } from "../core/bounds.js";
import {
  evaluateToolAssertion,
  isToolAssertion,
  toolAssertionName,
  NO_TRACE_METRIC_MARKER,
} from "./toolAssertions.js";

export type AssertionEvaluationContext = Trajectory;
export type ThresholdEvaluationContext = Trajectory;

export function assertionName(assertion: AssertionCheck): string {
  if (isToolAssertion(assertion)) return toolAssertionName(assertion);
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
  assertion: Exclude<AssertionCheck, { type: "jsonpath" } | ToolAssertionCheck>,
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
    if (isToolAssertion(assertion)) {
      return evaluateToolAssertion(assertion, context);
    }
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

export async function evaluateJudge(
  judge: JudgeConfig | undefined,
  trajectory: Trajectory,
  provider: JudgeProvider | undefined,
): Promise<Score[]> {
  if (!judge?.enabled) return [];

  if (!provider) {
    return [
      {
        name: "judge",
        verdict: Verdict.Skip,
        reason: "LLM judge not configured",
        metadata: { judge },
      },
    ];
  }

  if (!judge.prompt || !judge.rubric) {
    const missing =
      !judge.prompt && !judge.rubric ? "prompt or rubric" : !judge.prompt ? "prompt" : "rubric";
    return [
      {
        name: "judge",
        verdict: Verdict.Skip,
        reason: `Judge enabled but scenario has no ${missing} configured`,
        metadata: { judge },
      },
    ];
  }

  try {
    const result = await provider.judge({
      prompt: judge.prompt,
      rubric: judge.rubric,
      output: trajectory.finalResponse?.text ?? "",
      model: judge.model,
    });
    return [{ name: "judge", verdict: result.verdict, reason: result.reason, metadata: { judge } }];
  } catch (error) {
    return [
      {
        name: "judge",
        verdict: Verdict.Skip,
        reason: `LLM judge call failed: ${error instanceof Error ? error.message : String(error)}`,
        metadata: { judge },
      },
    ];
  }
}

export function thresholdName(threshold: ThresholdCheck): string {
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
  if (normalized === "toolcalls" || normalized === "maxtoolcalls") {
    return "tool_calls";
  }
  if (normalized === "toolinvocations" || normalized === "maxtoolinvocations") {
    return "tool_invocations";
  }
  return metric;
}

/**
 * Metrics that only ever arrive from trace enrichment. When one is absent the
 * honest reading is "no evidence", not "the agent failed" — the same rule tool
 * assertions follow. Metrics the runner always computes itself (turns,
 * latency_ms) are deliberately absent: those really are missing if unset.
 */
const TRACE_DERIVED_METRICS = new Set([
  "cost_usd",
  "input_tokens",
  "output_tokens",
  "total_tokens",
  "tool_calls",
  "tool_invocations",
]);

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
    if (TRACE_DERIVED_METRICS.has(key)) {
      return {
        name: thresholdName(threshold),
        verdict: Verdict.Skip,
        reason: `Metric ${key} is missing; skipping (no trace evidence)`,
        metadata: { threshold, skipped: NO_TRACE_METRIC_MARKER },
      };
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

  const bounds = formatBounds(threshold.min, threshold.max);
  return thresholdScore(threshold, Verdict.Pass, value, `Expected ${key} ${bounds}`);
}

export function evaluateThresholds(
  thresholds: readonly ThresholdCheck[],
  context: ThresholdEvaluationContext,
): Score[] {
  return thresholds.map((threshold) => evaluateThreshold(threshold, context));
}
