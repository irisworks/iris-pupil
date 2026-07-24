import { describe, expect, it } from "vitest";
import { loadScenarios } from "./loader.js";

describe("live IRIS example scenarios", () => {
  it("loads the live IRIS suite with the expected diagnostic flows", async () => {
    const scenarios = await loadScenarios("examples/iris");

    expect(scenarios.map((scenario) => scenario.id)).toEqual([
      "iris-live-failure-flow",
      "iris-live-retry-flow",
      "iris-live-successful-flow",
      "iris-live-timeout-flow",
    ]);
    expect(scenarios.every((scenario) => scenario.driver.preset === "iris-http")).toBe(true);
    expect(scenarios.every((scenario) => scenario.tags.includes("live"))).toBe(true);
    expect(
      scenarios.find((scenario) => scenario.id === "iris-live-timeout-flow")?.driver.config
        .timeoutMs,
    ).toBe(1);
    expect(scenarios.find((scenario) => scenario.id === "iris-live-retry-flow")?.tags).toContain(
      "retry",
    );
    expect(
      scenarios.find((scenario) => scenario.id === "iris-live-failure-flow")?.turns[0].expect[0],
    ).toMatchObject({ type: "contains", value: "__pupil_intentional_failure_token__" });
  });
});
