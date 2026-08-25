import { describe, expect, it } from "vitest";
import {
  Verdict,
  type AssertionCheck,
  type TextAssertionCheck,
  type Trajectory,
} from "../core/types.js";
import {
  aggregateScores,
  evaluateAssertion,
  evaluateAssertions,
  evaluateJudge,
  evaluateManualScoring,
  evaluateThreshold,
  evaluateThresholds,
} from "./index.js";
import { NO_JUDGE_VERDICT_MARKER } from "./toolAssertions.js";

const context: Trajectory = {
  source: "driven",
  steps: [
    {
      index: 0,
      input: { role: "user", content: "Book a meeting" },
      output: {
        role: "assistant",
        content: "I booked the meeting for Tuesday.",
        raw: {
          status: "ok",
          calendar: { eventId: "evt_123", attendees: ["john@example.com"] },
        },
      },
      startedAt: "2026-07-31T00:00:00.000Z",
      completedAt: "2026-07-31T00:00:01.000Z",
      latencyMs: 1000,
      metadata: {},
    },
  ],
  finalResponse: {
    text: "I booked the meeting for Tuesday.",
    raw: {
      status: "ok",
      calendar: { eventId: "evt_123", attendees: ["john@example.com"] },
    },
  },
  metrics: { turns: 1, latency_ms: 1000 },
  metadata: {},
  snapshot: {
    scenarioId: "scenario-1",
    scenarioName: "Scenario 1",
    verdict: Verdict.Pass,
    scores: [],
    turns: [],
    startedAt: "2026-07-31T00:00:00.000Z",
    completedAt: "2026-07-31T00:00:01.000Z",
    metrics: { turns: 1 },
  },
};

function trajectory(metrics: Record<string, number>): Trajectory {
  return { ...context, metrics };
}

const STEP_TEXTS = ["first answer", "second answer", "third answer"];

function multiStepTrajectory(): Trajectory {
  return {
    source: "driven",
    steps: STEP_TEXTS.map((content, index) => ({
      index,
      input: { role: "user" as const, content: `ask ${index}` },
      output: { role: "assistant" as const, content, raw: { step: `step-${index}` } },
      metadata: {},
    })),
    finalResponse: { text: STEP_TEXTS.at(-1), raw: { step: "step-2" } },
    metrics: { turns: 3 },
    metadata: {},
  };
}

function textAssertion(overrides: Partial<TextAssertionCheck>): AssertionCheck {
  return {
    type: "contains",
    target: "response.text",
    value: "booked",
    caseSensitive: false,
    ...overrides,
  };
}

describe("assertion evaluator", () => {
  it("evaluates contains assertions", () => {
    expect(evaluateAssertion(textAssertion({ value: "booked" }), context).verdict).toBe(
      Verdict.Pass,
    );
    expect(evaluateAssertion(textAssertion({ value: "cancelled" }), context).verdict).toBe(
      Verdict.Fail,
    );
  });

  it("evaluates not_contains assertions", () => {
    expect(
      evaluateAssertion(textAssertion({ type: "not_contains", value: "cancelled" }), context)
        .verdict,
    ).toBe(Verdict.Pass);
    expect(
      evaluateAssertion(textAssertion({ type: "not_contains", value: "booked" }), context).verdict,
    ).toBe(Verdict.Fail);
  });

  it("evaluates equals assertions with case sensitivity", () => {
    expect(
      evaluateAssertion(
        textAssertion({
          type: "equals",
          value: "i booked the meeting for tuesday.",
          caseSensitive: false,
        }),
        context,
      ).verdict,
    ).toBe(Verdict.Pass);
    expect(
      evaluateAssertion(
        textAssertion({
          type: "equals",
          value: "i booked the meeting for tuesday.",
          caseSensitive: true,
        }),
        context,
      ).verdict,
    ).toBe(Verdict.Fail);
  });

  it("evaluates regex assertions", () => {
    expect(
      evaluateAssertion(textAssertion({ type: "regex", value: "book(ed|ing).*Tuesday" }), context)
        .verdict,
    ).toBe(Verdict.Pass);
    expect(
      evaluateAssertion(textAssertion({ type: "regex", value: "cancel(ed|ing)" }), context).verdict,
    ).toBe(Verdict.Fail);
  });

  it("evaluates jsonpath exists and equals assertions", () => {
    expect(
      evaluateAssertion(
        { type: "jsonpath", target: "response.raw", path: "$.calendar.eventId", exists: true },
        context,
      ).verdict,
    ).toBe(Verdict.Pass);
    expect(
      evaluateAssertion(
        { type: "jsonpath", target: "response.raw", path: "$.calendar.eventId", equals: "evt_123" },
        context,
      ).verdict,
    ).toBe(Verdict.Pass);
    expect(
      evaluateAssertion(
        { type: "jsonpath", target: "response.raw", path: "$.calendar.eventId", equals: "evt_999" },
        context,
      ).verdict,
    ).toBe(Verdict.Fail);
    expect(
      evaluateAssertion(
        { type: "jsonpath", target: "response.raw", path: "$.calendar.missing", exists: false },
        context,
      ).verdict,
    ).toBe(Verdict.Pass);
  });

  it("resolves existing turn and result assertion targets through trajectory", () => {
    expect(
      evaluateAssertion(
        {
          type: "jsonpath",
          target: "turn",
          path: "$.response.text",
          equals: "I booked the meeting for Tuesday.",
        },
        context,
      ).verdict,
    ).toBe(Verdict.Pass);
    expect(
      evaluateAssertion(
        { type: "jsonpath", target: "result", path: "$.metrics.turns", equals: 1 },
        context,
      ).verdict,
    ).toBe(Verdict.Pass);
  });

  it("scopes response targets to currentStepIndex in a multi-step trajectory", () => {
    const multi = multiStepTrajectory();

    for (const [index, text] of STEP_TEXTS.entries()) {
      const scoped: Trajectory = { ...multi, currentStepIndex: index };

      expect(
        evaluateAssertion(textAssertion({ type: "equals", value: text }), scoped).verdict,
      ).toBe(Verdict.Pass);
      expect(
        evaluateAssertion(textAssertion({ target: "response.raw", value: `step-${index}` }), scoped)
          .verdict,
      ).toBe(Verdict.Pass);
      // The other steps' answers must not be reachable from this step.
      for (const other of STEP_TEXTS.filter((candidate) => candidate !== text)) {
        expect(
          evaluateAssertion(textAssertion({ type: "equals", value: other }), scoped).verdict,
        ).toBe(Verdict.Fail);
      }
    }
  });

  it("does not borrow another step's response when the scoped step has no output", () => {
    const multi = multiStepTrajectory();
    const scoped: Trajectory = {
      ...multi,
      steps: [
        { index: 0, input: { role: "user", content: "ask 0" }, error: "boom", metadata: {} },
        ...multi.steps.slice(1),
      ],
      currentStepIndex: 0,
    };

    expect(evaluateAssertion(textAssertion({ value: "answer" }), scoped).verdict).toBe(
      Verdict.Fail,
    );
    expect(
      evaluateAssertion(
        { type: "jsonpath", target: "response.raw", path: "$.step", exists: true },
        scoped,
      ).verdict,
    ).toBe(Verdict.Fail);
  });

  it("falls back to the final response only when no step is scoped", () => {
    expect(
      evaluateAssertion(
        textAssertion({ type: "equals", value: "third answer" }),
        multiStepTrajectory(),
      ).verdict,
    ).toBe(Verdict.Pass);
  });

  it("exposes turn scores through the turn assertion target", () => {
    const score = { name: "assertion:contains:response.text", verdict: Verdict.Pass };
    const scoped: Trajectory = {
      ...context,
      steps: [{ ...context.steps[0]!, metadata: { assertions: [score], spanId: "span-1" } }],
      currentStepIndex: 0,
    };

    expect(
      evaluateAssertion(
        { type: "jsonpath", target: "turn.assertions", path: "$[0].verdict", equals: Verdict.Pass },
        scoped,
      ).verdict,
    ).toBe(Verdict.Pass);
    expect(
      evaluateAssertion(
        { type: "jsonpath", target: "turn.metadata", path: "$.spanId", equals: "span-1" },
        scoped,
      ).verdict,
    ).toBe(Verdict.Pass);
  });

  it("resolves trajectory targets", () => {
    expect(
      evaluateAssertion(
        { type: "jsonpath", target: "trajectory", path: "$.source", equals: "driven" },
        context,
      ).verdict,
    ).toBe(Verdict.Pass);
    expect(
      evaluateAssertion(
        { type: "jsonpath", target: "trajectory.metrics", path: "$.turns", equals: 1 },
        context,
      ).verdict,
    ).toBe(Verdict.Pass);
  });

  it("aggregates assertion scores conservatively", () => {
    const scores = evaluateAssertions(
      [textAssertion({ value: "booked" }), textAssertion({ value: "cancelled" })],
      context,
    );

    expect(scores.map((score) => score.verdict)).toEqual([Verdict.Pass, Verdict.Fail]);
    expect(aggregateScores(scores)).toBe(Verdict.Fail);
  });
});

describe("threshold evaluator", () => {
  it("passes maxTurns and maxLatencyMs at boundary values", () => {
    const scores = evaluateThresholds(
      [
        { metric: "maxTurns", max: 2 },
        { metric: "maxLatencyMs", max: 1500 },
      ],
      trajectory({ turns: 2, latency_ms: 1500 }),
    );

    expect(scores.map((score) => score.verdict)).toEqual([Verdict.Pass, Verdict.Pass]);
    expect(aggregateScores(scores)).toBe(Verdict.Pass);
  });

  it("fails maxTurns and maxLatencyMs when measured values exceed max", () => {
    const scores = evaluateThresholds(
      [
        { metric: "maxTurns", max: 2 },
        { metric: "maxLatencyMs", max: 1500 },
      ],
      trajectory({ turns: 3, latency_ms: 1501 }),
    );

    expect(scores.map((score) => score.verdict)).toEqual([Verdict.Fail, Verdict.Fail]);
    expect(aggregateScores(scores)).toBe(Verdict.Fail);
  });

  it("normalizes threshold metric aliases across camel, snake, and kebab case", () => {
    const scores = evaluateThresholds(
      [
        { metric: "max_turns", max: 2 },
        { metric: "max-latency-ms", max: 1500 },
        { metric: "max_cost_usd", max: 0.25 },
      ],
      trajectory({ turns: 2, latency_ms: 1500, cost_usd: 0.25 }),
    );

    expect(scores.map((score) => score.verdict)).toEqual([
      Verdict.Pass,
      Verdict.Pass,
      Verdict.Pass,
    ]);
  });

  it("evaluates min threshold boundaries", () => {
    expect(evaluateThreshold({ metric: "turns", min: 2 }, trajectory({ turns: 2 })).verdict).toBe(
      Verdict.Pass,
    );
    expect(evaluateThreshold({ metric: "turns", min: 2 }, trajectory({ turns: 1 })).verdict).toBe(
      Verdict.Fail,
    );
  });
  it("evaluates maxCostUsd when cost data exists", () => {
    expect(
      evaluateThreshold({ metric: "maxCostUsd", max: 0.25 }, trajectory({ cost_usd: 0.25 }))
        .verdict,
    ).toBe(Verdict.Pass);
    expect(
      evaluateThreshold({ metric: "maxCostUsd", max: 0.25 }, trajectory({ cost_usd: 0.26 }))
        .verdict,
    ).toBe(Verdict.Fail);
  });

  it("normalizes camelCase aliases for the trace-derived tool metrics", () => {
    expect(
      evaluateThreshold({ metric: "toolCalls", max: 3 }, trajectory({ tool_calls: 3 })).verdict,
    ).toBe(Verdict.Pass);
    expect(
      evaluateThreshold({ metric: "toolInvocations", max: 2 }, trajectory({ tool_invocations: 3 }))
        .verdict,
    ).toBe(Verdict.Fail);
  });

  it("skips maxCostUsd cleanly when cost data is missing", () => {
    const score = evaluateThreshold({ metric: "maxCostUsd", max: 0.25 }, trajectory({}));

    expect(score.verdict).toBe(Verdict.Skip);
    expect(score.reason).toMatch(/cost_usd is missing/);
    expect(aggregateScores([score])).toBe(Verdict.Pass);
  });

  it("skips trace-derived metrics that are missing instead of failing", () => {
    for (const metric of ["tool_calls", "tool_invocations", "total_tokens"]) {
      const score = evaluateThreshold({ metric, max: 5 }, trajectory({}));

      expect(score.verdict).toBe(Verdict.Skip);
      expect(score.metadata.skipped).toBe("no_trace_metric");
      expect(aggregateScores([score])).toBe(Verdict.Pass);
    }
  });

  it("still fails on a missing metric that trace evidence never supplies", () => {
    const score = evaluateThreshold({ metric: "turns", max: 5 }, trajectory({}));

    expect(score.verdict).toBe(Verdict.Fail);
    expect(score.reason).toMatch(/Metric turns is missing/);
  });
});

describe("manual and judge evaluators", () => {
  it("creates needs_review scores for required manual criteria", () => {
    const scores = evaluateManualScoring({
      required: true,
      criteria: ["correctness", "tone"],
      rubric: ["Answer is correct"],
    });

    expect(scores.map((score) => [score.name, score.verdict])).toEqual([
      ["manual:correctness", Verdict.NeedsReview],
      ["manual:tone", Verdict.NeedsReview],
    ]);
    expect(aggregateScores(scores)).toBe(Verdict.NeedsReview);
  });

  it("emits a skip score for configured judge blocks without a provider", async () => {
    const scores = await evaluateJudge(
      { enabled: true, prompt: "Judge this response." },
      context,
      undefined,
    );

    expect(scores).toHaveLength(1);
    expect(scores[0]).toMatchObject({
      name: "judge",
      verdict: Verdict.Skip,
      reason: "LLM judge not configured",
    });
    // No skipped marker: a missing provider is a configuration gap, not something
    // --require-trace should be able to escalate (see applyTraceRequirement).
    expect(scores[0]?.metadata.skipped).toBeUndefined();
    expect(aggregateScores(scores)).toBe(Verdict.Pass);
  });

  it("emits a skip score when enabled but the scenario has no rubric", async () => {
    const provider = { judge: async () => ({ verdict: Verdict.Pass, reason: "n/a" }) };

    const scores = await evaluateJudge({ enabled: true, prompt: "Judge this." }, context, provider);

    expect(scores).toHaveLength(1);
    expect(scores[0]).toMatchObject({
      name: "judge",
      verdict: Verdict.Skip,
      reason: "Judge enabled but scenario has no rubric configured",
      metadata: expect.objectContaining({ skipped: NO_JUDGE_VERDICT_MARKER }),
    });
  });

  it("emits a skip score naming the prompt, not the rubric, when only the prompt is missing", async () => {
    const provider = { judge: async () => ({ verdict: Verdict.Pass, reason: "n/a" }) };
    const judge = {
      enabled: true,
      rubric: { choices: ["A"], choiceScores: { A: Verdict.Pass } },
    };

    const scores = await evaluateJudge(judge, context, provider);

    expect(scores[0]).toMatchObject({
      name: "judge",
      verdict: Verdict.Skip,
      reason: "Judge enabled but scenario has no prompt configured",
    });
  });

  it("scores from a successful provider call", async () => {
    const provider = {
      judge: async () => ({ verdict: Verdict.Fail, reason: "Missed the deadline detail." }),
    };
    const judge = {
      enabled: true,
      prompt: "Judge this.",
      rubric: { choices: ["A", "B"], choiceScores: { A: Verdict.Pass, B: Verdict.Fail } },
    };

    const scores = await evaluateJudge(judge, context, provider);

    expect(scores).toEqual([
      {
        name: "judge",
        verdict: Verdict.Fail,
        reason: "Missed the deadline detail.",
        metadata: { judge },
      },
    ]);
  });

  it("passes the trajectory's final response text, rubric, prompt, and model to the provider", async () => {
    let seenRequest: unknown;
    const provider = {
      judge: async (request: unknown) => {
        seenRequest = request;
        return { verdict: Verdict.Pass, reason: "ok" };
      },
    };
    const judge = {
      enabled: true,
      prompt: "Judge this.",
      model: "gpt-4o-mini",
      rubric: { choices: ["A"], choiceScores: { A: Verdict.Pass } },
    };

    await evaluateJudge(judge, context, provider);

    expect(seenRequest).toEqual({
      prompt: "Judge this.",
      rubric: judge.rubric,
      output: "I booked the meeting for Tuesday.",
      model: "gpt-4o-mini",
    });
  });

  it("passes an empty output string when the trajectory has no final response", async () => {
    let seenOutput: unknown;
    const provider = {
      judge: async (request: { output: unknown }) => {
        seenOutput = request.output;
        return { verdict: Verdict.Pass, reason: "ok" };
      },
    };
    const judge = {
      enabled: true,
      prompt: "Judge this.",
      rubric: { choices: ["A"], choiceScores: { A: Verdict.Pass } },
    };
    const noResponseContext: Trajectory = { ...context, finalResponse: undefined };

    await evaluateJudge(judge, noResponseContext, provider);

    expect(seenOutput).toBe("");
  });

  it("skips instead of throwing when the provider call fails", async () => {
    const provider = {
      judge: async () => {
        throw new Error("Judge endpoint returned 500");
      },
    };
    const judge = {
      enabled: true,
      prompt: "Judge this.",
      rubric: { choices: ["A"], choiceScores: { A: Verdict.Pass } },
    };

    const scores = await evaluateJudge(judge, context, provider);

    expect(scores).toHaveLength(1);
    expect(scores[0]).toMatchObject({
      name: "judge",
      verdict: Verdict.Skip,
      reason: "LLM judge call failed: Judge endpoint returned 500",
      metadata: expect.objectContaining({ skipped: NO_JUDGE_VERDICT_MARKER }),
    });
    expect(aggregateScores(scores)).toBe(Verdict.Pass);
  });
});
