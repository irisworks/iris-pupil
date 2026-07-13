import { describe, expect, it } from "vitest";
import { normalizeScenario } from "./schema.js";

describe("normalizeScenario", () => {
  it("normalizes shorthand input into one user turn", () => {
    const scenario = normalizeScenario({
      id: "short",
      input: "Hello",
    });

    expect(scenario.turns).toEqual([{ user: "Hello", expect: [] }]);
    expect(scenario.driver).toEqual({ type: "rest", config: {} });
  });

  it("keeps multi-turn user actions as first-class turns", () => {
    const scenario = normalizeScenario({
      id: "multi",
      turns: [
        { user: "Hello" },
        {
          user: "Continue",
          expect: [{ type: "contains", target: "response.text", value: "done" }],
        },
      ],
    });

    expect(scenario.turns).toHaveLength(2);
    expect(scenario.turns[1]).toEqual({
      user: "Continue",
      expect: [{ type: "contains", target: "response.text", value: "done", caseSensitive: false }],
    });
  });

  it("normalizes a full scenario with tags, thresholds, manual scoring, judge, and jsonpath", () => {
    const scenario = normalizeScenario({
      id: "full",
      name: "Full scenario",
      tags: ["iris", "smoke"],
      metadata: { owner: "irisflow" },
      driver: { type: "rest", preset: "iris-http", config: { baseUrl: "http://localhost" } },
      turns: [
        {
          user: "Create an event",
          expect: [
            {
              type: "jsonpath",
              target: "response.raw",
              path: "$.calendar.eventId",
              exists: true,
            },
          ],
        },
      ],
      expect: {
        assertions: [{ type: "regex", target: "response.text", value: "book(ed|ing)" }],
        thresholds: [{ metric: "latency_ms", max: 30000 }],
        manual: {
          required: true,
          prompt: "Check whether the booking is correct.",
          rubric: ["Calendar event created"],
        },
        judge: {
          enabled: true,
          model: "gpt-4.1-mini",
          prompt: "Judge task completion.",
          rubric: ["No clarification required"],
        },
      },
    });

    expect(scenario.tags).toEqual(["iris", "smoke"]);
    expect(scenario.metadata).toEqual({ owner: "irisflow" });
    expect(scenario.driver).toEqual({
      type: "rest",
      preset: "iris-http",
      config: { baseUrl: "http://localhost" },
    });
    expect(scenario.turns[0]?.expect).toEqual([
      { type: "jsonpath", target: "response.raw", path: "$.calendar.eventId", exists: true },
    ]);
    expect(scenario.expect.thresholds).toEqual([{ metric: "latency_ms", max: 30000 }]);
    expect(scenario.expect.manual?.rubric).toEqual(["Calendar event created"]);
    expect(scenario.expect.judge?.model).toBe("gpt-4.1-mini");
  });

  it("rejects invalid jsonpath assertions with file and path context", () => {
    expect(() =>
      normalizeScenario(
        {
          id: "bad-jsonpath",
          input: "Hello",
          assertions: [{ type: "jsonpath", target: "response.raw", path: "$.id" }],
        },
        "bad.yaml",
      ),
    ).toThrow(/bad\.yaml:assertions\.0: jsonpath assertion requires equals or exists/);
  });
  it("reports actionable validation errors", () => {
    expect(() => normalizeScenario({ input: "missing id" }, "bad.yaml")).toThrow(/bad\.yaml:id:/);
  });

  it("reports file and path context for invalid shorthand input", () => {
    expect(() => normalizeScenario({ id: "bad", input: { messages: [] } }, "bad.yaml")).toThrow(
      /bad\.yaml:input:/,
    );
  });

  it("rejects scenarios declaring both string-form input and turns", () => {
    expect(() =>
      normalizeScenario({ id: "confusing", input: "Hello", turns: [{ user: "Hi" }] }, "bad.yaml"),
    ).toThrow(/bad\.yaml:turns: scenario cannot define both input and turns/);
  });

  it("rejects scenarios declaring both object-form input and turns", () => {
    for (const input of [{ text: "Hello" }, { user: "Hello" }]) {
      expect(() =>
        normalizeScenario({ id: "confusing", input, turns: [{ user: "Hi" }] }, "bad.yaml"),
      ).toThrow(/bad\.yaml:turns: scenario cannot define both input and turns/);
    }
  });

  it("rejects empty multi-turn scenarios", () => {
    expect(() => normalizeScenario({ id: "empty-turns", turns: [] }, "bad.yaml")).toThrow(
      /bad\.yaml:turns: scenario requires at least one turn/,
    );
  });

  it("rejects unknown expect fields with file and path context", () => {
    expect(() =>
      normalizeScenario(
        { id: "bad-expect", input: "Hello", expect: { assertionz: [] } },
        "bad.yaml",
      ),
    ).toThrow(/bad\.yaml:expect: Unrecognized key\(s\) in object: 'assertionz'/);
  });
  it("rejects unknown driver fields with file and path context", () => {
    expect(() =>
      normalizeScenario(
        { id: "bad-driver", input: "Hello", driver: { presett: "iris-http" } },
        "bad.yaml",
      ),
    ).toThrow(/bad\.yaml:driver: Unrecognized key\(s\) in object: 'presett'/);
  });
});
