import { describe, expect, it } from "vitest";
import { normalizeScenario } from "./schema.js";

describe("normalizeScenario", () => {
  it("normalizes shorthand input into one user turn", () => {
    const scenario = normalizeScenario({
      id: "short",
      input: "Hello",
    });

    expect(scenario.turns).toEqual([{ role: "user", content: "Hello" }]);
    expect(scenario.driver).toEqual({ type: "rest", config: {} });
  });

  it("keeps multi-turn messages as first-class turns", () => {
    const scenario = normalizeScenario({
      id: "multi",
      input: {
        messages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi" },
          { role: "user", content: "Continue" },
        ],
      },
    });

    expect(scenario.turns).toHaveLength(3);
    expect(scenario.turns[1].role).toBe("assistant");
  });

  it("reports actionable validation errors", () => {
    expect(() => normalizeScenario({ input: "missing id" }, "bad.yaml")).toThrow(/bad\.yaml:id:/);
  });
});
