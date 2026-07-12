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

  it("reports actionable validation errors", () => {
    expect(() => normalizeScenario({ input: "missing id" }, "bad.yaml")).toThrow(/bad\.yaml:id:/);
  });

  it("reports file and path context for invalid shorthand input", () => {
    expect(() => normalizeScenario({ id: "bad", input: { messages: [] } }, "bad.yaml")).toThrow(
      /bad\.yaml:input:/,
    );
  });
});
