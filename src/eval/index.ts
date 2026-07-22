import {
  aggregateVerdicts,
  PupilError,
  type AssertionCheck,
  type Score,
  type ScenarioResult,
  type TurnRecord,
  Verdict,
} from "../core/types.js";
import { extractJsonPath } from "../driver/index.js";

export interface AssertionEvaluationContext {
  response?: {
    text?: string;
    raw?: unknown;
  };
  turn?: TurnRecord;
  result?: ScenarioResult;
}

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

function resolveTarget(target: string, context: AssertionEvaluationContext): unknown {
  if (target === "response.text") return context.response?.text;
  if (target === "response.raw") return context.response?.raw;
  if (target === "turn") return context.turn;
  if (target === "result") return context.result;
  if (target.startsWith("turn.")) return extractJsonPath(context.turn, `$.${target.slice(5)}`);
  if (target.startsWith("result.")) return extractJsonPath(context.result, `$.${target.slice(7)}`);
  if (target.startsWith("response.raw.")) {
    return extractJsonPath(context.response?.raw, `$.${target.slice("response.raw.".length)}`);
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
