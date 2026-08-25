import { describe, expect, it } from "vitest";
import { Verdict, type ToolAssertionCheck, type ToolCall, type Trajectory } from "../core/types.js";
import {
  applyTraceRequirement,
  evaluateToolAssertion,
  NO_JUDGE_VERDICT_MARKER,
  NO_TOOL_EVIDENCE_MARKER,
  NO_TOOL_EVIDENCE_REASON,
  NO_TRACE_METRIC_MARKER,
} from "./toolAssertions.js";

function trajectoryWith(toolCalls?: readonly ToolCall[]): Trajectory {
  return {
    source: "driven",
    steps: [],
    metrics: {},
    metadata: {},
    ...(toolCalls !== undefined && { toolCalls }),
  };
}

const calls: ToolCall[] = [
  { name: "search", index: 0 },
  { name: "search", index: 1 },
  { name: "calendar.create", index: 2, args: { title: "Standup", tz: "UTC", id: 9 } },
];

describe("tool_called", () => {
  it("passes when the tool was called at least once", () => {
    const assertion: ToolAssertionCheck = { type: "tool_called", tool: "calendar.create" };
    expect(evaluateToolAssertion(assertion, trajectoryWith(calls)).verdict).toBe(Verdict.Pass);
  });

  it("fails when the tool was never called", () => {
    const assertion: ToolAssertionCheck = { type: "tool_called", tool: "email.send" };
    expect(evaluateToolAssertion(assertion, trajectoryWith(calls)).verdict).toBe(Verdict.Fail);
  });

  it("fails when a trace exists but shows no tool calls at all", () => {
    const assertion: ToolAssertionCheck = { type: "tool_called", tool: "calendar.create" };
    const score = evaluateToolAssertion(assertion, trajectoryWith([]));
    expect(score.verdict).toBe(Verdict.Fail);
  });

  it("skips when there is no tool call evidence", () => {
    const assertion: ToolAssertionCheck = { type: "tool_called", tool: "calendar.create" };
    const score = evaluateToolAssertion(assertion, trajectoryWith(undefined));
    expect(score.verdict).toBe(Verdict.Skip);
    expect(score.reason).toBe(NO_TOOL_EVIDENCE_REASON);
    expect(score.metadata.skipped).toBe("no_tool_evidence");
  });

  it("honours an exact times count", () => {
    const once: ToolAssertionCheck = { type: "tool_called", tool: "search", times: 1 };
    const twice: ToolAssertionCheck = { type: "tool_called", tool: "search", times: 2 };
    expect(evaluateToolAssertion(once, trajectoryWith(calls)).verdict).toBe(Verdict.Fail);
    expect(evaluateToolAssertion(twice, trajectoryWith(calls)).verdict).toBe(Verdict.Pass);
  });

  it("matches a glob pattern when match is glob", () => {
    const assertion: ToolAssertionCheck = {
      type: "tool_called",
      tool: "calendar.*",
      match: "glob",
    };
    expect(evaluateToolAssertion(assertion, trajectoryWith(calls)).verdict).toBe(Verdict.Pass);
  });

  it("does not treat a glob pattern as a substring match by default", () => {
    const assertion: ToolAssertionCheck = { type: "tool_called", tool: "calendar" };
    expect(evaluateToolAssertion(assertion, trajectoryWith(calls)).verdict).toBe(Verdict.Fail);
  });
});

describe("tool_not_called", () => {
  it("passes when the tool was never called", () => {
    const assertion: ToolAssertionCheck = { type: "tool_not_called", tool: "email.send" };
    expect(evaluateToolAssertion(assertion, trajectoryWith(calls)).verdict).toBe(Verdict.Pass);
  });

  it("passes when a trace exists and shows no tool calls", () => {
    const assertion: ToolAssertionCheck = { type: "tool_not_called", tool: "email.send" };
    expect(evaluateToolAssertion(assertion, trajectoryWith([])).verdict).toBe(Verdict.Pass);
  });

  it("fails when the tool was called", () => {
    const assertion: ToolAssertionCheck = { type: "tool_not_called", tool: "search" };
    expect(evaluateToolAssertion(assertion, trajectoryWith(calls)).verdict).toBe(Verdict.Fail);
  });

  it("skips without evidence rather than passing vacuously", () => {
    const assertion: ToolAssertionCheck = { type: "tool_not_called", tool: "email.send" };
    expect(evaluateToolAssertion(assertion, trajectoryWith(undefined)).verdict).toBe(Verdict.Skip);
  });
});

describe("tool_call_count", () => {
  it("counts duplicates for a named tool", () => {
    const assertion: ToolAssertionCheck = {
      type: "tool_call_count",
      tool: "search",
      min: 2,
      max: 2,
    };
    expect(evaluateToolAssertion(assertion, trajectoryWith(calls)).verdict).toBe(Verdict.Pass);
  });

  it("counts every call when no tool is named", () => {
    const assertion: ToolAssertionCheck = { type: "tool_call_count", max: 3 };
    const score = evaluateToolAssertion(assertion, trajectoryWith(calls));
    expect(score.verdict).toBe(Verdict.Pass);
    expect(score.value).toBe(3);
  });

  it("fails when the count exceeds max", () => {
    const assertion: ToolAssertionCheck = { type: "tool_call_count", tool: "search", max: 1 };
    expect(evaluateToolAssertion(assertion, trajectoryWith(calls)).verdict).toBe(Verdict.Fail);
  });
});

describe("tool_order", () => {
  it("passes on a subsequence with unrelated calls in between", () => {
    const assertion: ToolAssertionCheck = {
      type: "tool_order",
      tools: ["search", "calendar.create"],
    };
    expect(evaluateToolAssertion(assertion, trajectoryWith(calls)).verdict).toBe(Verdict.Pass);
  });

  it("fails when the order is reversed", () => {
    const assertion: ToolAssertionCheck = {
      type: "tool_order",
      tools: ["calendar.create", "search"],
    };
    expect(evaluateToolAssertion(assertion, trajectoryWith(calls)).verdict).toBe(Verdict.Fail);
  });

  it("requires two distinct calls when a tool is listed twice", () => {
    const twice: ToolAssertionCheck = { type: "tool_order", tools: ["search", "search"] };
    const thrice: ToolAssertionCheck = {
      type: "tool_order",
      tools: ["search", "search", "search"],
    };
    expect(evaluateToolAssertion(twice, trajectoryWith(calls)).verdict).toBe(Verdict.Pass);
    expect(evaluateToolAssertion(thrice, trajectoryWith(calls)).verdict).toBe(Verdict.Fail);
  });

  it("fails when a listed tool never appears", () => {
    const assertion: ToolAssertionCheck = {
      type: "tool_order",
      tools: ["search", "email.send"],
    };
    expect(evaluateToolAssertion(assertion, trajectoryWith(calls)).verdict).toBe(Verdict.Fail);
  });

  it("skips without evidence", () => {
    const assertion: ToolAssertionCheck = { type: "tool_order", tools: ["search"] };
    expect(evaluateToolAssertion(assertion, trajectoryWith(undefined)).verdict).toBe(Verdict.Skip);
  });
});

describe("tool_args", () => {
  it("passes on a subset match, ignoring extra keys", () => {
    const assertion: ToolAssertionCheck = {
      type: "tool_args",
      tool: "calendar.create",
      equals: { title: "Standup" },
    };
    expect(evaluateToolAssertion(assertion, trajectoryWith(calls)).verdict).toBe(Verdict.Pass);
  });

  it("fails when a listed value differs", () => {
    const assertion: ToolAssertionCheck = {
      type: "tool_args",
      tool: "calendar.create",
      equals: { title: "Retro" },
    };
    expect(evaluateToolAssertion(assertion, trajectoryWith(calls)).verdict).toBe(Verdict.Fail);
  });

  it("fails when a listed key is absent", () => {
    const assertion: ToolAssertionCheck = {
      type: "tool_args",
      tool: "calendar.create",
      equals: { attendees: ["a@example.com"] },
    };
    expect(evaluateToolAssertion(assertion, trajectoryWith(calls)).verdict).toBe(Verdict.Fail);
  });

  it("passes when any call to the tool matches", () => {
    const multi: ToolCall[] = [
      { name: "calendar.create", index: 0, args: { title: "Retro" } },
      { name: "calendar.create", index: 1, args: { title: "Standup" } },
    ];
    const assertion: ToolAssertionCheck = {
      type: "tool_args",
      tool: "calendar.create",
      equals: { title: "Standup" },
    };
    expect(evaluateToolAssertion(assertion, trajectoryWith(multi)).verdict).toBe(Verdict.Pass);
  });

  it("fails when the tool was never called", () => {
    const assertion: ToolAssertionCheck = {
      type: "tool_args",
      tool: "email.send",
      equals: { to: "a@example.com" },
    };
    expect(evaluateToolAssertion(assertion, trajectoryWith(calls)).verdict).toBe(Verdict.Fail);
  });

  it("matches nested objects by subset", () => {
    const nested: ToolCall[] = [
      { name: "calendar.create", index: 0, args: { event: { title: "Standup", tz: "UTC" } } },
    ];
    const assertion: ToolAssertionCheck = {
      type: "tool_args",
      tool: "calendar.create",
      equals: { event: { title: "Standup" } },
    };
    expect(evaluateToolAssertion(assertion, trajectoryWith(nested)).verdict).toBe(Verdict.Pass);
  });

  it("skips without evidence", () => {
    const assertion: ToolAssertionCheck = {
      type: "tool_args",
      tool: "calendar.create",
      equals: { title: "Standup" },
    };
    expect(evaluateToolAssertion(assertion, trajectoryWith(undefined)).verdict).toBe(Verdict.Skip);
  });

  it("fails when an array value has the same elements in a different order", () => {
    const reordered: ToolCall[] = [
      {
        name: "calendar.create",
        index: 0,
        args: { attendees: ["b@example.com", "a@example.com"] },
      },
    ];
    const assertion: ToolAssertionCheck = {
      type: "tool_args",
      tool: "calendar.create",
      equals: { attendees: ["a@example.com", "b@example.com"] },
    };
    expect(evaluateToolAssertion(assertion, trajectoryWith(reordered)).verdict).toBe(Verdict.Fail);
  });

  it("fails when an array value is only a prefix of the expected array", () => {
    const shorter: ToolCall[] = [
      { name: "calendar.create", index: 0, args: { attendees: ["a@example.com"] } },
    ];
    const assertion: ToolAssertionCheck = {
      type: "tool_args",
      tool: "calendar.create",
      equals: { attendees: ["a@example.com", "b@example.com"] },
    };
    expect(evaluateToolAssertion(assertion, trajectoryWith(shorter)).verdict).toBe(Verdict.Fail);
  });
});

describe("evaluateToolOrder glob matching", () => {
  const calls = [
    { name: "calendar.create", index: 0 },
    { name: "search.web", index: 1 },
    { name: "calendar.delete", index: 2 },
  ];

  it("matches an ordered subsequence using glob patterns", () => {
    const score = evaluateToolAssertion(
      { type: "tool_order", tools: ["calendar.*", "search.*"], match: "glob" },
      { source: "driven", steps: [], metrics: {}, metadata: {}, toolCalls: calls },
    );

    expect(score.verdict).toBe(Verdict.Pass);
  });

  it("fails when the glob-matched tools appear out of order", () => {
    const score = evaluateToolAssertion(
      { type: "tool_order", tools: ["search.*", "calendar.create"], match: "glob" },
      { source: "driven", steps: [], metrics: {}, metadata: {}, toolCalls: calls },
    );

    expect(score.verdict).toBe(Verdict.Fail);
  });
});

describe("applyTraceRequirement", () => {
  const skipped = {
    name: "assertion:tool_called:calendar.create",
    verdict: Verdict.Skip,
    reason: NO_TOOL_EVIDENCE_REASON,
    metadata: {
      assertion: { type: "tool_called", tool: "calendar.create" },
      skipped: NO_TOOL_EVIDENCE_MARKER,
    },
  };

  it("clears the skip marker when it escalates a skip to a failure", () => {
    const [escalated] = applyTraceRequirement([skipped], true);

    expect(escalated?.verdict).toBe(Verdict.Fail);
    expect(escalated?.metadata.skipped).toBeUndefined();
  });

  it("keeps the assertion metadata intact while escalating", () => {
    const [escalated] = applyTraceRequirement([skipped], true);

    expect(escalated?.metadata.assertion).toEqual({ type: "tool_called", tool: "calendar.create" });
  });

  it("leaves the marker in place when requireTrace is off", () => {
    const [untouched] = applyTraceRequirement([skipped], false);

    expect(untouched?.verdict).toBe(Verdict.Skip);
    expect(untouched?.metadata.skipped).toBe(NO_TOOL_EVIDENCE_MARKER);
  });

  it("escalates a trace-derived metric skip as well as a tool assertion skip", () => {
    const metricSkip = {
      name: "threshold:tool_calls",
      verdict: Verdict.Skip,
      reason: "Metric tool_calls is missing; skipping (no trace evidence)",
      metadata: { threshold: { metric: "tool_calls", max: 5 }, skipped: NO_TRACE_METRIC_MARKER },
    };

    const [escalated] = applyTraceRequirement([metricSkip], true);

    expect(escalated?.verdict).toBe(Verdict.Fail);
    expect(escalated?.metadata.skipped).toBeUndefined();
  });

  it("never escalates an unconfigured-provider judge skip, which is a config gap rather than a trace gap", () => {
    const judgeSkip = {
      name: "judge",
      verdict: Verdict.Skip,
      reason: "LLM judge not configured",
      metadata: { judge: { enabled: true } },
    };

    const [untouched] = applyTraceRequirement([judgeSkip], true);

    expect(untouched?.verdict).toBe(Verdict.Skip);
  });

  it("escalates a judge skip caused by a broken scenario or a failed provider call", () => {
    const judgeSkip = {
      name: "judge",
      verdict: Verdict.Skip,
      reason: "Judge enabled but scenario has no rubric configured",
      metadata: { judge: { enabled: true }, skipped: NO_JUDGE_VERDICT_MARKER },
    };

    const [escalated] = applyTraceRequirement([judgeSkip], true);

    expect(escalated?.verdict).toBe(Verdict.Fail);
    expect(escalated?.metadata.skipped).toBeUndefined();
    expect(escalated?.reason).toBe(
      "Judge enabled but scenario has no rubric configured (failing because --require-trace is set)",
    );
  });
});
