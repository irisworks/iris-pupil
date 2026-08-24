import { afterEach, describe, expect, it } from "vitest";
import { createIrisMockAgent, createMockAgentBundle, type IrisMockAgent } from "./irisMockAgent.js";
import type { ToolCall } from "../core/types.js";

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
    const spanStore = new Map<string, ToolCall[]>();
    mock = createIrisMockAgent({ port: 0 }, spanStore);
    const address = await mock.listen();
    const baseUrl = `http://${address.host}:${address.port}`;

    const session = await createSession(baseUrl);

    expect(spanStore.has(session.sessionId)).toBe(true);
    expect(spanStore.get(session.sessionId)).toEqual([]);
  });

  it("does not initialise span store when session creation fails", async () => {
    const spanStore = new Map<string, ToolCall[]>();
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

describe("span store — trace pass on message", () => {
  it("appends defaultToolCalls when no trace rule matches", async () => {
    const spanStore = new Map<string, ToolCall[]>();
    mock = createIrisMockAgent({ port: 0, defaultToolCalls: ["search", "send"] }, spanStore);
    const address = await mock.listen();
    const baseUrl = `http://${address.host}:${address.port}`;
    const session = await createSession(baseUrl);

    await fetch(`${baseUrl}/sessions/${session.sessionId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });

    expect(spanStore.get(session.sessionId)).toEqual([
      { name: "search", index: 0 },
      { name: "send", index: 1 },
    ]);
  });

  it("appends per-rule toolCalls when a trace rule matches by string", async () => {
    const spanStore = new Map<string, ToolCall[]>();
    mock = createIrisMockAgent(
      {
        port: 0,
        traceRules: [{ match: "book meeting", toolCalls: ["calendar_create"] }],
      },
      spanStore,
    );
    const address = await mock.listen();
    const baseUrl = `http://${address.host}:${address.port}`;
    const session = await createSession(baseUrl);

    await fetch(`${baseUrl}/sessions/${session.sessionId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "please book meeting for 3pm" }),
    });

    expect(spanStore.get(session.sessionId)).toEqual([{ name: "calendar_create", index: 0 }]);
  });

  it("appends per-rule toolCalls when a trace rule matches by regex", async () => {
    const spanStore = new Map<string, ToolCall[]>();
    mock = createIrisMockAgent(
      {
        port: 0,
        traceRules: [{ match: /order #\d+/i, toolCalls: ["order_lookup"] }],
      },
      spanStore,
    );
    const address = await mock.listen();
    const baseUrl = `http://${address.host}:${address.port}`;
    const session = await createSession(baseUrl);

    await fetch(`${baseUrl}/sessions/${session.sessionId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Check Order #99 status" }),
    });

    expect(spanStore.get(session.sessionId)).toEqual([{ name: "order_lookup", index: 0 }]);
  });

  it("appends nothing when no trace rule matches and no defaultToolCalls configured", async () => {
    const spanStore = new Map<string, ToolCall[]>();
    mock = createIrisMockAgent({ port: 0 }, spanStore);
    const address = await mock.listen();
    const baseUrl = `http://${address.host}:${address.port}`;
    const session = await createSession(baseUrl);

    await fetch(`${baseUrl}/sessions/${session.sessionId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });

    expect(spanStore.get(session.sessionId)).toEqual([]);
  });

  // Rule matches but toolCalls is empty — agent ran but called nothing.
  // Configures a trajectory where a tool_called assertion would fail.
  it("trace rule with toolCalls: [] produces empty span list even when rule matches", async () => {
    const spanStore = new Map<string, ToolCall[]>();
    mock = createIrisMockAgent(
      {
        port: 0,
        traceRules: [{ match: "search", toolCalls: [] }],
        defaultToolCalls: ["fallback_tool"], // should NOT be used — rule matched
      },
      spanStore,
    );
    const address = await mock.listen();
    const baseUrl = `http://${address.host}:${address.port}`;
    const session = await createSession(baseUrl);

    await fetch(`${baseUrl}/sessions/${session.sessionId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "search for news" }),
    });

    // Rule matched → defaultToolCalls is skipped → spans stay empty
    expect(spanStore.get(session.sessionId)).toEqual([]);
  });

  it("spans accumulate across multiple turns in emission order", async () => {
    const spanStore = new Map<string, ToolCall[]>();
    mock = createIrisMockAgent(
      {
        port: 0,
        traceRules: [
          { match: "search", toolCalls: ["web_search"] },
          { match: "send", toolCalls: ["email_send"] },
        ],
      },
      spanStore,
    );
    const address = await mock.listen();
    const baseUrl = `http://${address.host}:${address.port}`;
    const session = await createSession(baseUrl);

    await fetch(`${baseUrl}/sessions/${session.sessionId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "search for news" }),
    });
    await fetch(`${baseUrl}/sessions/${session.sessionId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "send the results" }),
    });

    expect(spanStore.get(session.sessionId)).toEqual([
      { name: "web_search", index: 0 },
      { name: "email_send", index: 1 },
    ]);
  });

  it("preserves out-of-order and repeated tool names exactly as configured", async () => {
    const spanStore = new Map<string, ToolCall[]>();
    mock = createIrisMockAgent(
      {
        port: 0,
        traceRules: [{ match: "multi", toolCalls: ["b_tool", "a_tool", "b_tool"] }],
      },
      spanStore,
    );
    const address = await mock.listen();
    const baseUrl = `http://${address.host}:${address.port}`;
    const session = await createSession(baseUrl);

    await fetch(`${baseUrl}/sessions/${session.sessionId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "multi tool request" }),
    });

    expect(spanStore.get(session.sessionId)).toEqual([
      { name: "b_tool", index: 0 },
      { name: "a_tool", index: 1 },
      { name: "b_tool", index: 2 },
    ]);
  });

  it("HTTP rule and trace rule matching are independent — trace rule matches even when HTTP rule does not", async () => {
    const spanStore = new Map<string, ToolCall[]>();
    mock = createIrisMockAgent(
      {
        port: 0,
        rules: [{ match: "http-keyword", reply: "http matched" }],
        traceRules: [{ match: "trace-keyword", toolCalls: ["tracer"] }],
      },
      spanStore,
    );
    const address = await mock.listen();
    const baseUrl = `http://${address.host}:${address.port}`;
    const session = await createSession(baseUrl);

    // "trace-keyword" matches trace rule but NOT http rule → default HTTP reply
    const response = await fetch(`${baseUrl}/sessions/${session.sessionId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "trace-keyword" }),
    });
    const reply = (await response.json()) as { text: string };

    expect(reply.text).toBe("Mock Iris received: trace-keyword");
    expect(spanStore.get(session.sessionId)).toEqual([{ name: "tracer", index: 0 }]);
  });

  it("HTTP rule and trace rule matching are independent — HTTP rule matches even when trace rule does not", async () => {
    const spanStore = new Map<string, ToolCall[]>();
    mock = createIrisMockAgent(
      {
        port: 0,
        rules: [{ match: "http-keyword", reply: "http matched" }],
        traceRules: [{ match: "trace-keyword", toolCalls: ["tracer"] }],
      },
      spanStore,
    );
    const address = await mock.listen();
    const baseUrl = `http://${address.host}:${address.port}`;
    const session = await createSession(baseUrl);

    // "http-keyword" matches HTTP rule but NOT trace rule → no spans
    const response = await fetch(`${baseUrl}/sessions/${session.sessionId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "http-keyword" }),
    });
    const reply = (await response.json()) as { text: string };

    expect(reply.text).toBe("http matched");
    expect(spanStore.get(session.sessionId)).toEqual([]);
  });

  it.each([
    ["__500__", 500],
    ["__504__", 504],
  ])("trace pass fires even when HTTP status is %s", async (text, expectedStatus) => {
    const spanStore = new Map<string, ToolCall[]>();
    mock = createIrisMockAgent({ port: 0, defaultToolCalls: ["attempted_tool"] }, spanStore);
    const address = await mock.listen();
    const baseUrl = `http://${address.host}:${address.port}`;
    const session = await createSession(baseUrl);

    const response = await fetch(`${baseUrl}/sessions/${session.sessionId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });

    expect(response.status).toBe(expectedStatus);
    expect(spanStore.get(session.sessionId)).toEqual([{ name: "attempted_tool", index: 0 }]);
  });

  it("serves tool call fixtures with arguments through the trace source", async () => {
    const bundle = createMockAgentBundle({
      port: 0,
      traceRules: [
        {
          match: /book/i,
          toolCalls: [
            "search",
            { name: "calendar.create", args: { title: "Standup" } },
            { name: "email.send", error: "smtp down" },
          ],
        },
      ],
    });
    mock = bundle.agent;
    const address = await mock.listen();
    const baseUrl = `http://${address.host}:${address.port}`;

    const session = await createSession(baseUrl);
    await fetch(`${baseUrl}/sessions/${session.sessionId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "book a meeting" }),
    });

    const record = await bundle.traceSource.resolve(session.sessionId);

    expect(record?.toolCalls).toEqual([
      { name: "search", index: 0 },
      { name: "calendar.create", index: 1, args: { title: "Standup" } },
      { name: "email.send", index: 2, error: "smtp down" },
    ]);
  });

  it("aliases recorded tool-call spans under the traceparent trace id by default", async () => {
    const spanStore = new Map<string, ToolCall[]>();
    mock = createIrisMockAgent({ port: 0, defaultToolCalls: ["calendar.create"] }, spanStore);
    const address = await mock.listen();
    const baseUrl = `http://${address.host}:${address.port}`;
    const session = await createSession(baseUrl);

    await fetch(`${baseUrl}/sessions/${session.sessionId}/message`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      },
      body: JSON.stringify({ text: "hello" }),
    });

    expect(spanStore.get("4bf92f3577b34da6a3ce929d0e0e4736")).toEqual(
      spanStore.get(session.sessionId),
    );
  });

  it("does not alias spans under the trace id when the message opts out with __ignore-traceparent__", async () => {
    const spanStore = new Map<string, ToolCall[]>();
    mock = createIrisMockAgent({ port: 0, defaultToolCalls: ["calendar.create"] }, spanStore);
    const address = await mock.listen();
    const baseUrl = `http://${address.host}:${address.port}`;
    const session = await createSession(baseUrl);

    await fetch(`${baseUrl}/sessions/${session.sessionId}/message`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      },
      body: JSON.stringify({ text: "hello __ignore-traceparent__" }),
    });

    expect(spanStore.get("4bf92f3577b34da6a3ce929d0e0e4736")).toBeUndefined();
    expect(spanStore.get(session.sessionId)).toHaveLength(1);
  });
});
