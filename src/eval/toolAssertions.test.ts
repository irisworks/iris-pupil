import { describe, expect, it } from "vitest";
import { Verdict, type ToolAssertionCheck, type ToolCall, type Trajectory } from "../core/types.js";
import { evaluateToolAssertion, NO_TOOL_EVIDENCE_REASON } from "./toolAssertions.js";

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
