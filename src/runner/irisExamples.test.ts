import { describe, expect, it } from "vitest";
import { Verdict } from "../core/types.js";
import { createIrisMockAgent } from "../mock/irisMockAgent.js";
import { loadScenarios } from "../scenario/index.js";
import { runScenario } from "./index.js";

describe("live IRIS example runner coverage", () => {
  it("runs the successful and failure examples through the IRIS-compatible REST path", async () => {
    const mock = createIrisMockAgent({ port: 0 });
    const address = await mock.listen();

    try {
      const scenarios = await loadScenarios("examples/iris");
      const success = scenarios.find((scenario) => scenario.id === "iris-live-successful-flow");
      const failure = scenarios.find((scenario) => scenario.id === "iris-live-failure-flow");
      expect(success).toBeDefined();
      expect(failure).toBeDefined();

      const driverConfig = {
        baseUrl: `http://${address.host}:${address.port}`,
        originThreadTs: "pupil-live-example-test",
      };

      const successResult = await runScenario(success!, { driverConfig });
      expect(successResult.verdict).toBe(Verdict.Pass);
      expect(successResult.turns[0].response?.text).toContain("Mock Iris received");

      const failureResult = await runScenario(failure!, { driverConfig });
      expect(failureResult.verdict).toBe(Verdict.Fail);
      expect(failureResult.scores).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "assertion:contains:response.text",
            verdict: Verdict.Fail,
          }),
        ]),
      );
    } finally {
      await mock.close();
    }
  });
});
