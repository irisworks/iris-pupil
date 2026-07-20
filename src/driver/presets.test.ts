import { afterEach, describe, expect, it } from "vitest";
import { createIrisMockAgent, type IrisMockAgent } from "../mock/irisMockAgent.js";
import { RestDriver } from "./index.js";
import { createIrisHttpPreset, IRIS_HTTP_PRESET } from "./presets.js";

let mock: IrisMockAgent | undefined;

afterEach(async () => {
  if (mock) {
    await mock.close();
    mock = undefined;
  }
});

async function mockBaseUrl(options: Parameters<typeof createIrisMockAgent>[0] = {}) {
  mock = createIrisMockAgent({ port: 0, ...options });
  const address = await mock.listen();
  return `http://${address.host}:${address.port}`;
}

describe("iris-http preset", () => {
  it("uses the built-in preset name", () => {
    expect(IRIS_HTTP_PRESET).toBe("iris-http");
  });

  it("runs a conversation against the IRIS-compatible mock agent", async () => {
    const baseUrl = await mockBaseUrl({ rules: [{ match: "schedule", reply: "Scheduled." }] });
    const driver = new RestDriver(createIrisHttpPreset({ baseUrl, originThreadTs: "thread-1" }));

    const conversation = await driver.createConversation();
    const response = await driver.send(conversation, "please schedule this");
    await driver.closeConversation(conversation);

    expect(response.text).toBe("Scheduled.");
    expect(mock?.requests.map((request) => request.path)).toEqual([
      "/sessions",
      `/sessions/${conversation.id}/message`,
      `/sessions/${conversation.id}/reset`,
    ]);
    expect(mock?.requests[0]?.body).toEqual({
      originChannel: "pupil",
      originThreadTs: "thread-1",
    });
    expect(mock?.requests[1]?.body).toEqual({ text: "please schedule this" });
  });

  it("uses bearer auth from IRIS_API_TOKEN env", async () => {
    const baseUrl = await mockBaseUrl({ apiToken: "secret" });
    const driver = new RestDriver(
      createIrisHttpPreset({
        baseUrl,
        originThreadTs: "thread-1",
        env: { IRIS_API_TOKEN: "secret" },
      }),
    );

    const conversation = await driver.createConversation();

    expect(conversation.id).toMatch(/[0-9a-f-]{36}/);
  });

  it("deep-merges override config without losing default IRIS mappings", async () => {
    const config = createIrisHttpPreset({
      baseUrl: "https://iris.example.test",
      originThreadTs: "thread-1",
      overrides: {
        timeoutMs: 1_000,
        headers: { "x-pupil-run": "{{runId}}" },
        createConversation: {
          headers: { "x-create": "true" },
          body: { metadata: { scenarioId: "{{scenarioId}}" } },
        },
        send: {
          extract: { reply: "$.message" },
        },
      },
    });

    expect(config.timeoutMs).toBe(1_000);
    expect(config.headers).toEqual({ "x-pupil-run": "{{runId}}" });
    expect(config.createConversation).toEqual({
      method: "POST",
      path: "/sessions",
      headers: { "x-create": "true" },
      body: {
        originChannel: "pupil",
        originThreadTs: "thread-1",
        metadata: { scenarioId: "{{scenarioId}}" },
      },
      extract: { conversationId: "$.sessionId" },
    });
    expect(config.send).toEqual({
      method: "POST",
      path: "/sessions/{{conversationId}}/message",
      body: { text: "{{message}}" },
      extract: { reply: "$.message" },
    });
    expect(config.close).toEqual({
      method: "POST",
      path: "/sessions/{{conversationId}}/reset",
    });
  });

  it("can target live IRIS by changing base URL and token config only", () => {
    const config = createIrisHttpPreset({
      baseUrl: "https://iris.example.test",
      bearerToken: "live-token",
    });

    expect(config.baseUrl).toBe("https://iris.example.test");
    expect(config.bearerToken).toBe("live-token");
    expect(config.createConversation.path).toBe("/sessions");
    expect(config.send.path).toBe("/sessions/{{conversationId}}/message");
    expect(config.close?.path).toBe("/sessions/{{conversationId}}/reset");
  });
});
