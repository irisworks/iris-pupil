import { afterEach, describe, expect, it } from "vitest";
import { createIrisMockAgent, type IrisMockAgent } from "./irisMockAgent.js";

let mock: IrisMockAgent | undefined;

afterEach(async () => {
  if (mock) {
    await mock.close();
    mock = undefined;
  }
});

async function createSession(baseUrl: string): Promise<{ sessionId: string }> {
  const response = await fetch(`${baseUrl}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ originChannel: "test", originThreadTs: "thread-1" }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { sessionId: string };
}

describe("IRIS mock agent", () => {
  it("creates sessions and records message requests", async () => {
    mock = createIrisMockAgent({ port: 0 });
    const address = await mock.listen();
    const baseUrl = `http://${address.host}:${address.port}`;

    const health = await fetch(`${baseUrl}/health`).then((response) => response.json());
    expect(health).toEqual({ ok: true, channels: 0 });

    const session = await createSession(baseUrl);

    const reply = (await fetch(`${baseUrl}/sessions/${session.sessionId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    }).then((response) => response.json())) as { text: string };

    expect(reply.text).toBe("Mock Iris received: hello");
    expect(mock.requests).toHaveLength(2);
  });

  it("requires IRIS session origin fields", async () => {
    mock = createIrisMockAgent({ port: 0 });
    const address = await mock.listen();
    const baseUrl = `http://${address.host}:${address.port}`;

    const response = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "originChannel and originThreadTs are required",
    });
  });

  it("supports scripted replies, history, and session reset", async () => {
    mock = createIrisMockAgent({
      port: 0,
      rules: [{ match: "book meeting", reply: "Meeting booked.", delayMs: 5 }],
    });
    const address = await mock.listen();
    const baseUrl = `http://${address.host}:${address.port}`;
    const session = await createSession(baseUrl);

    const reply = (await fetch(`${baseUrl}/sessions/${session.sessionId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "book meeting" }),
    }).then((response) => response.json())) as { text: string };

    expect(reply.text).toBe("Meeting booked.");
    expect(mock.sessions.get(session.sessionId)?.history).toHaveLength(2);

    const history = (await fetch(`${baseUrl}/sessions/${session.sessionId}/history`).then(
      (response) => response.json(),
    )) as { history: unknown[] };
    expect(history.history).toHaveLength(2);

    const reset = await fetch(`${baseUrl}/sessions/${session.sessionId}/reset`, {
      method: "POST",
    }).then((response) => response.json());

    expect(reset).toEqual({ status: "ok", message: "Context cleared" });
    expect(mock.sessions.get(session.sessionId)?.history).toEqual([]);
  });

  it("exposes recorded requests for assertions", async () => {
    mock = createIrisMockAgent({ port: 0 });
    const address = await mock.listen();
    const baseUrl = `http://${address.host}:${address.port}`;

    await createSession(baseUrl);
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

  it("requires bearer auth when an API token is configured", async () => {
    mock = createIrisMockAgent({ port: 0, apiToken: "secret" });
    const address = await mock.listen();
    const baseUrl = `http://${address.host}:${address.port}`;

    const unauthorized = await fetch(`${baseUrl}/sessions`, { method: "POST" });
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ originChannel: "test", originThreadTs: "thread-1" }),
    });
    expect(authorized.status).toBe(201);
  });

  it("rejects message requests without text", async () => {
    mock = createIrisMockAgent({ port: 0 });
    const address = await mock.listen();
    const baseUrl = `http://${address.host}:${address.port}`;
    const session = await createSession(baseUrl);

    const response = await fetch(`${baseUrl}/sessions/${session.sessionId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "text is required" });
  });

  it.each([
    ["__500__", 500],
    ["__504__", 504],
  ])("supports scripted %s responses", async (text, expectedStatus) => {
    mock = createIrisMockAgent({ port: 0 });
    const address = await mock.listen();
    const baseUrl = `http://${address.host}:${address.port}`;
    const session = await createSession(baseUrl);

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
    const session = await createSession(baseUrl);

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
    const session = await createSession(baseUrl);

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

describe("span store — session initialization", () => {
  it("initialises span store with empty array when a session is created", async () => {
    const spanStore = new Map<string, string[]>();
    mock = createIrisMockAgent({ port: 0 }, spanStore);
    const address = await mock.listen();
    const baseUrl = `http://${address.host}:${address.port}`;

    const session = await createSession(baseUrl);

    expect(spanStore.has(session.sessionId)).toBe(true);
    expect(spanStore.get(session.sessionId)).toEqual([]);
  });

  it("does not initialise span store when session creation fails", async () => {
    const spanStore = new Map<string, string[]>();
    mock = createIrisMockAgent({ port: 0 }, spanStore);
    const address = await mock.listen();
    const baseUrl = `http://${address.host}:${address.port}`;

    const response = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}), // missing required fields
    });

    expect(response.status).toBe(400);
    expect(spanStore.size).toBe(0);
  });
});
