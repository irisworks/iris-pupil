import {
  Verdict,
  type AssertionCheck,
  type Score,
  type ToolAssertionCheck,
  type ToolCall,
  type ToolNameMatch,
  type Trajectory,
} from "../core/types.js";
import { isRecord } from "../core/json.js";

export const NO_TOOL_EVIDENCE_REASON = "No tool call evidence available";

/** Marker read by the --require-trace policy pass in the runner. */
export const NO_TOOL_EVIDENCE_MARKER = "no_tool_evidence";

const TOOL_ASSERTION_TYPES = new Set([
  "tool_called",
  "tool_not_called",
  "tool_call_count",
  "tool_order",
  "tool_args",
]);

export function isToolAssertion(assertion: AssertionCheck): assertion is ToolAssertionCheck {
  return TOOL_ASSERTION_TYPES.has(assertion.type);
}

export function toolAssertionName(assertion: ToolAssertionCheck): string {
  if (assertion.type === "tool_order") {
    return `assertion:${assertion.type}:${assertion.tools.join(">")}`;
  }
  if (assertion.type === "tool_call_count" && assertion.tool === undefined) {
    return `assertion:${assertion.type}:*`;
  }
  return `assertion:${assertion.type}:${assertion.tool}`;
}

function globToRegExp(pattern: string): RegExp {
  // Escapes every regex metacharacter except * and ?, which become wildcards.
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

function toolMatcher(pattern: string, match: ToolNameMatch | undefined): (name: string) => boolean {
  if (match === "glob") {
    const regex = globToRegExp(pattern);
    return (name) => regex.test(name);
  }
  return (name) => name === pattern;
}

/**
 * Subset deep-match: every key in `expected` must match `actual`, extra keys in
 * `actual` are ignored. Arrays compare by exact position and length, because a
 * partial array match has no obvious correct meaning.
 */
export function subsetMatches(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((item, index) => subsetMatches(item, actual[index]));
  }
  if (isRecord(expected)) {
    if (!isRecord(actual)) return false;
    return Object.entries(expected).every(
      ([key, value]) => key in actual && subsetMatches(value, actual[key]),
    );
  }
  return Object.is(expected, actual);
}

function skipScore(assertion: ToolAssertionCheck): Score {
  return {
    name: toolAssertionName(assertion),
    verdict: Verdict.Skip,
    reason: NO_TOOL_EVIDENCE_REASON,
    metadata: { assertion, skipped: NO_TOOL_EVIDENCE_MARKER },
  };
}

function score(
  assertion: ToolAssertionCheck,
  verdict: Verdict.Pass | Verdict.Fail,
  value: unknown,
  reason: string,
): Score {
  return { name: toolAssertionName(assertion), verdict, reason, value, metadata: { assertion } };
}

function verdictFor(passed: boolean): Verdict.Pass | Verdict.Fail {
  return passed ? Verdict.Pass : Verdict.Fail;
}

function matchingCalls(
  calls: readonly ToolCall[],
  pattern: string,
  match: ToolNameMatch | undefined,
): ToolCall[] {
  const matches = toolMatcher(pattern, match);
  return calls.filter((call) => matches(call.name));
}

function evaluateToolCalled(
  assertion: ToolCalledAssertionCheckLocal,
  calls: readonly ToolCall[],
): Score {
  const found = matchingCalls(calls, assertion.tool, assertion.match);
  if (assertion.times !== undefined) {
    return score(
      assertion,
      verdictFor(found.length === assertion.times),
      found.length,
      `Expected ${assertion.tool} to be called exactly ${assertion.times} time(s), saw ${found.length}`,
    );
  }
  return score(
    assertion,
    verdictFor(found.length > 0),
    found.length,
    `Expected ${assertion.tool} to be called at least once, saw ${found.length}`,
  );
}

type ToolCalledAssertionCheckLocal = Extract<ToolAssertionCheck, { type: "tool_called" }>;
type ToolNotCalledLocal = Extract<ToolAssertionCheck, { type: "tool_not_called" }>;
type ToolCallCountLocal = Extract<ToolAssertionCheck, { type: "tool_call_count" }>;

function evaluateToolNotCalled(assertion: ToolNotCalledLocal, calls: readonly ToolCall[]): Score {
  const found = matchingCalls(calls, assertion.tool, assertion.match);
  return score(
    assertion,
    verdictFor(found.length === 0),
    found.length,
    `Expected ${assertion.tool} never to be called, saw ${found.length}`,
  );
}

function evaluateToolCallCount(assertion: ToolCallCountLocal, calls: readonly ToolCall[]): Score {
  const counted =
    assertion.tool === undefined
      ? [...calls]
      : matchingCalls(calls, assertion.tool, assertion.match);
  const count = counted.length;
  const label = assertion.tool ?? "any tool";

  if (assertion.min !== undefined && count < assertion.min) {
    return score(
      assertion,
      Verdict.Fail,
      count,
      `Expected ${label} count >= ${assertion.min}, saw ${count}`,
    );
  }
  if (assertion.max !== undefined && count > assertion.max) {
    return score(
      assertion,
      Verdict.Fail,
      count,
      `Expected ${label} count <= ${assertion.max}, saw ${count}`,
    );
  }

  const bounds = [
    assertion.min !== undefined ? `>= ${assertion.min}` : undefined,
    assertion.max !== undefined ? `<= ${assertion.max}` : undefined,
  ]
    .filter(Boolean)
    .join(" and ");
  return score(assertion, Verdict.Pass, count, `Expected ${label} count ${bounds}, saw ${count}`);
}

export function evaluateToolAssertion(
  assertion: ToolAssertionCheck,
  trajectory: Trajectory,
): Score {
  // Reads trajectory.toolCalls only — never steps, finalResponse, or snapshot —
  // so a trace-derived trajectory (pupil observe, IRIS-164) works unchanged.
  const calls = trajectory.toolCalls;
  if (calls === undefined) return skipScore(assertion);

  switch (assertion.type) {
    case "tool_called":
      return evaluateToolCalled(assertion, calls);
    case "tool_not_called":
      return evaluateToolNotCalled(assertion, calls);
    case "tool_call_count":
      return evaluateToolCallCount(assertion, calls);
    default:
      // tool_order and tool_args are added in Task 6.
      return skipScore(assertion);
  }
}
