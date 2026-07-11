import { afterEach, describe, expect, it } from "vitest";
import { createIrisMockAgent, type IrisMockAgent } from "./irisMockAgent.js";

let mock: IrisMockAgent | undefined;

afterEach(async () => {
  if (mock) {
    await mock.close();
    mock = undefined;
  }
});

describe("IRIS mock agent", () => {
  it("creates sessions and records message requests", async () => {
    mock = createIrisMockAgent({ port: 0 });
    const address = await mock.listen();
    const baseUrl = `http://${address.host}:${address.port}`;

    const health = await fetch(`${baseUrl}/health`).then((response) => response.json());
    expect(health).toEqual({ ok: true, service: "iris-mock" });

    const session = (await fetch(`${baseUrl}/sessions`, { method: "POST" }).then((response) =>
      response.json(),
    )) as { sessionId: string };

    const reply = (await fetch(`${baseUrl}/sessions/${session.sessionId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    }).then((response) => response.json())) as { text: string };

    expect(reply.text).toBe("Mock Iris received: hello");
    expect(mock.requests).toHaveLength(2);
  });

  it("supports scripted 500 and 504 responses", async () => {
    mock = createIrisMockAgent({ port: 0 });
    const address = await mock.listen();
    const baseUrl = `http://${address.host}:${address.port}`;
    const session = (await fetch(`${baseUrl}/sessions`, { method: "POST" }).then((response) =>
      response.json(),
    )) as { sessionId: string };

    const response = await fetch(`${baseUrl}/sessions/${session.sessionId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "__504__" }),
    });

    expect(response.status).toBe(504);
  });
});
