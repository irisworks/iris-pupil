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
  snapshot: { metrics: { turns: 1 }, scenarioId: "scenario-1" },
};

function trajectory(metrics: Record<string, number>): Trajectory {
  return { ...context, metrics };
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

  it("skips maxCostUsd cleanly when cost data is missing", () => {
    const score = evaluateThreshold({ metric: "maxCostUsd", max: 0.25 }, trajectory({}));

    expect(score.verdict).toBe(Verdict.Skip);
    expect(score.reason).toMatch(/Cost metric is missing/);
    expect(aggregateScores([score])).toBe(Verdict.Pass);
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

  it("emits a skip score for configured judge blocks without LLM config", () => {
    const scores = evaluateJudge({ enabled: true, prompt: "Judge this response.", rubric: [] });

    expect(scores).toHaveLength(1);
    expect(scores[0]).toMatchObject({
      name: "judge",
      verdict: Verdict.Skip,
      reason: "LLM judge not configured",
    });
    expect(aggregateScores(scores)).toBe(Verdict.Pass);
  });
});
