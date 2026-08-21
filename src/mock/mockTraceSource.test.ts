import { afterEach, describe, expect, it } from "vitest";
import { applyTraceEnrichment } from "../trace/index.js";
import { Verdict, type ScenarioResult, type ToolCall } from "../core/types.js";
import { createMockAgentBundle, type IrisMockAgent } from "./irisMockAgent.js";
import { MockTraceSource } from "./mockTraceSource.js";

describe("MockTraceSource", () => {
  it("resolve returns undefined for an unknown session ID", async () => {
    const store = new Map<string, ToolCall[]>();
    const source = new MockTraceSource(store);

    await expect(source.resolve("nonexistent-id")).resolves.toBeUndefined();
  });

  it("resolve returns traceCount 1 with empty toolCalls for a session that produced no spans", async () => {
    const store = new Map<string, ToolCall[]>([["session-1", []]]);
    const source = new MockTraceSource(store);

    await expect(source.resolve("session-1")).resolves.toEqual({
      traceCount: 1,
      toolCalls: [],
    });
  });

  it("resolve returns accumulated spans after one turn", async () => {
    const store = new Map<string, ToolCall[]>([["session-1", [{ name: "web_search", index: 0 }]]]);
    const source = new MockTraceSource(store);

    await expect(source.resolve("session-1")).resolves.toEqual({
      traceCount: 1,
      toolCalls: [{ name: "web_search", index: 0 }],
    });
  });

  it("resolve returns accumulated spans after multiple turns in emission order", async () => {
    const store = new Map<string, ToolCall[]>([
      [
        "session-1",
        [
          { name: "web_search", index: 0 },
          { name: "calendar_create", index: 1 },
          { name: "email_send", index: 2 },
        ],
      ],
    ]);
    const source = new MockTraceSource(store);

    await expect(source.resolve("session-1")).resolves.toEqual({
      traceCount: 1,
      toolCalls: [
        { name: "web_search", index: 0 },
        { name: "calendar_create", index: 1 },
        { name: "email_send", index: 2 },
      ],
    });
  });

  it("returns a copy of spans — mutations to the returned array do not affect the store", async () => {
    const spans: ToolCall[] = [{ name: "web_search", index: 0 }];
    const store = new Map<string, ToolCall[]>([["session-1", spans]]);
    const source = new MockTraceSource(store);

    const record = await source.resolve("session-1");
    (record!.toolCalls as ToolCall[]).push({ name: "mutated", index: 1 });

    // Store is unaffected
    expect(store.get("session-1")).toEqual([{ name: "web_search", index: 0 }]);
  });

  it("metadataKey is 'mock'", () => {
    const source = new MockTraceSource(new Map());
    expect(source.metadataKey).toBe("mock");
  });
});

describe("integration — createMockAgentBundle + applyTraceEnrichment", () => {
  let agent: IrisMockAgent | undefined;

  afterEach(async () => {
    if (agent) {
      await agent.close();
      agent = undefined;
    }
  });

  it("enriches ScenarioResult with tool calls from mock spans — no network, no API keys", async () => {
    const bundle = createMockAgentBundle({
      port: 0,
      traceRules: [{ match: "book", toolCalls: ["calendar_create", "notify_user"] }],
    });
    agent = bundle.agent;
    const address = await agent.listen();
    const baseUrl = `http://${address.host}:${address.port}`;

    // Create session and send a message that triggers the trace rule
    const sessionResponse = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ originChannel: "test", originThreadTs: "ts-1" }),
    });
    const { sessionId } = (await sessionResponse.json()) as { sessionId: string };

    await fetch(`${baseUrl}/sessions/${sessionId}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "book a meeting" }),
    });

    // Resolve trace evidence directly from the MockTraceSource
    const record = await bundle.traceSource.resolve(sessionId);
    expect(record).toBeDefined();
    expect(record!.toolCalls).toEqual([
      { name: "calendar_create", index: 0 },
      { name: "notify_user", index: 1 },
    ]);

    // Apply enrichment just like the runner does
    const result: ScenarioResult = {
      scenarioId: "s1",
      scenarioName: "book meeting",
      verdict: Verdict.Pass,
      scores: [],
      turns: [],
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      metrics: {},
    };

    const lookup = record
      ? ({ status: "found", record } as const)
      : ({ status: "missing" } as const);

    applyTraceEnrichment(result, sessionId, lookup, bundle.traceSource.metadataKey);

    expect(result.metrics.tool_calls).toBe(2);
    expect((result.metadata?.mock as { toolCalls: string[] }).toolCalls).toEqual([
      "calendar_create",
      "notify_user",
    ]);
  });
});
