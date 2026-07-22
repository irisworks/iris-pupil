import { describe, expect, it } from "vitest";
import { Verdict, type AssertionCheck, type TextAssertionCheck } from "../core/types.js";
import { aggregateScores, evaluateAssertion, evaluateAssertions } from "./index.js";

const context = {
  response: {
    text: "I booked the meeting for Tuesday.",
    raw: {
      status: "ok",
      calendar: { eventId: "evt_123", attendees: ["john@example.com"] },
    },
  },
};

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

  it("aggregates assertion scores conservatively", () => {
    const scores = evaluateAssertions(
      [textAssertion({ value: "booked" }), textAssertion({ value: "cancelled" })],
      context,
    );

    expect(scores.map((score) => score.verdict)).toEqual([Verdict.Pass, Verdict.Fail]);
    expect(aggregateScores(scores)).toBe(Verdict.Fail);
  });
});
