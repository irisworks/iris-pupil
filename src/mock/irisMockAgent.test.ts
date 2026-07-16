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

  it("supports scripted replies and session reset", async () => {
    mock = createIrisMockAgent({
      port: 0,
      rules: [{ match: "book meeting", reply: "Meeting booked.", delayMs: 5 }],
    });
    const address = await mock.listen();
    const baseUrl = `http://${address.host}:${address.port}`;
    const session = (await fetch(`${baseUrl}/sessions`, { method: "POST" }).then((response) =>
      response.json(),
    )) as { sessionId: string };

    const reply = (await fetch(`${baseUrl}/sessions/${session.sessionId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "book meeting" }),
    }).then((response) => response.json())) as { text: string };

    expect(reply.text).toBe("Meeting booked.");
    expect(mock.sessions.get(session.sessionId)?.history).toHaveLength(2);

    const reset = await fetch(`${baseUrl}/sessions/${session.sessionId}/reset`, {
      method: "POST",
    }).then((response) => response.json());

    expect(reset).toEqual({ ok: true, sessionId: session.sessionId });
    expect(mock.sessions.get(session.sessionId)?.history).toEqual([]);
  });

  it("exposes recorded requests for assertions", async () => {
    mock = createIrisMockAgent({ port: 0 });
    const address = await mock.listen();
    const baseUrl = `http://${address.host}:${address.port}`;

    await fetch(`${baseUrl}/sessions`, { method: "POST" });
    const recorded = (await fetch(`${baseUrl}/requests`).then((response) => response.json())) as {
      requests: Array<{ method: string; path: string }>;
    };

    expect(recorded.requests).toHaveLength(1);
    expect(recorded.requests[0]).toMatchObject({ method: "POST", path: "/sessions" });

    const cleared = await fetch(`${baseUrl}/requests`, { method: "DELETE" }).then((response) =>
      response.json(),
    );
    expect(cleared).toEqual({ ok: true });
    expect(mock.requests).toEqual([]);
  });

  it.each([
    ["__500__", 500],
    ["__504__", 504],
  ])("supports scripted %s responses", async (text, expectedStatus) => {
    mock = createIrisMockAgent({ port: 0 });
    const address = await mock.listen();
    const baseUrl = `http://${address.host}:${address.port}`;
    const session = (await fetch(`${baseUrl}/sessions`, { method: "POST" }).then((response) =>
      response.json(),
    )) as { sessionId: string };

    const response = await fetch(`${baseUrl}/sessions/${session.sessionId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });

    expect(response.status).toBe(expectedStatus);
  });

  it("clears delayed response timers when closing", async () => {
    mock = createIrisMockAgent({ port: 0 });
    const address = await mock.listen();
    const baseUrl = `http://${address.host}:${address.port}`;
    const session = (await fetch(`${baseUrl}/sessions`, { method: "POST" }).then((response) =>
      response.json(),
    )) as { sessionId: string };

    const delayedRequest = fetch(`${baseUrl}/sessions/${session.sessionId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "__delay:1000__ hello" }),
    }).catch(() => undefined);

    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(mock.close()).resolves.toBeUndefined();
    mock = undefined;
    await delayedRequest;
  });

  it("closes even when a request is hanging", async () => {
    mock = createIrisMockAgent({ port: 0 });
    const address = await mock.listen();
    const baseUrl = `http://${address.host}:${address.port}`;
    const session = (await fetch(`${baseUrl}/sessions`, { method: "POST" }).then((response) =>
      response.json(),
    )) as { sessionId: string };

    const controller = new AbortController();
    const hangingRequest = fetch(`${baseUrl}/sessions/${session.sessionId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "__hang__" }),
      signal: controller.signal,
    }).catch(() => undefined);

    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(mock.close()).resolves.toBeUndefined();
    mock = undefined;

    controller.abort();
    await hangingRequest;
  });
});
