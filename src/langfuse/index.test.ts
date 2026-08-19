import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractLangfuseEnrichment,
  langfuseConfigFromEnv,
  LangfuseTraceSource,
  resolveLangfuseConfig,
} from "./index.js";

let server: Server | undefined;

/**
 * Fetch stub for the polling tests: records the timestamp of each session-listing
 * request and reports a trace only once `ready()` says ingestion has caught up.
 */
function pollingFetch(calls: number[], ready: () => boolean): typeof fetch {
  return (async (url: string | URL) => {
    if (String(url).includes("/api/public/traces/trace-1")) {
      return { ok: true, status: 200, json: async () => ({ id: "trace-1", totalCost: 0.004 }) };
    }
    calls.push(Date.now());
    const found = ready();
    return {
      ok: true,
      status: 200,
      json: async () => (found ? { data: [{ id: "trace-1" }] } : { data: [] }),
    };
  }) as unknown as typeof fetch;
}

interface StubbedServer {
  baseUrl: string;
  requests: { url?: string; authorization?: string }[];
}

/** Serves `payloads` in order, repeating the last one for any further request. */
async function stubSession(...payloads: unknown[]): Promise<StubbedServer> {
  const requests: StubbedServer["requests"] = [];

  server = createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    const payload = payloads[Math.min(requests.length - 1, payloads.length - 1)];
    const status =
      typeof payload === "object" && payload !== null && "status" in payload
        ? (payload as { status: number }).status
        : 200;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(status === 200 ? payload : { error: "offline" }));
  });

  const baseUrl = await new Promise<string>((resolve, reject) => {
    server?.once("error", reject);
    server?.listen(0, "127.0.0.1", () => {
      server?.off("error", reject);
      const address = server?.address();
      if (!address || typeof address !== "object") {
        reject(new Error("server did not expose a port"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });

  return { baseUrl, requests };
}

function config(baseUrl: string) {
  return { baseUrl, publicKey: "pk-test", secretKey: "sk-test" };
}

afterEach(async () => {
  vi.useRealTimers();
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server?.close((error) => (error ? reject(error) : resolve()));
  });
  server = undefined;
});

describe("Langfuse config resolution", () => {
  it("requires a host and both keys", () => {
    expect(langfuseConfigFromEnv({})).toBeUndefined();
    expect(
      langfuseConfigFromEnv({ LANGFUSE_HOST: "http://langfuse.local", LANGFUSE_PUBLIC_KEY: "pk" }),
    ).toBeUndefined();
  });

  it("accepts LANGFUSE_HOST and trims a trailing slash", () => {
    expect(
      langfuseConfigFromEnv({
        LANGFUSE_HOST: "http://langfuse.local/",
        LANGFUSE_PUBLIC_KEY: "pk",
        LANGFUSE_SECRET_KEY: "sk",
      }),
    ).toEqual({ baseUrl: "http://langfuse.local", publicKey: "pk", secretKey: "sk" });
  });

  it("accepts wait and timeout settings from the environment", () => {
    expect(
      langfuseConfigFromEnv({
        LANGFUSE_HOST: "http://langfuse.local",
        LANGFUSE_PUBLIC_KEY: "pk",
        LANGFUSE_SECRET_KEY: "sk",
        LANGFUSE_WAIT_MS: "60000",
        LANGFUSE_TIMEOUT_MS: "15000",
        LANGFUSE_INITIAL_DELAY_MS: "8000",
      }),
    ).toEqual({
      baseUrl: "http://langfuse.local",
      publicKey: "pk",
      secretKey: "sk",
      waitMs: 60000,
      timeoutMs: 15000,
      initialDelayMs: 8000,
    });
  });

  it("falls back to LANGFUSE_BASE_URL", () => {
    expect(
      langfuseConfigFromEnv({
        LANGFUSE_BASE_URL: "http://langfuse.local",
        LANGFUSE_PUBLIC_KEY: "pk",
        LANGFUSE_SECRET_KEY: "sk",
      })?.baseUrl,
    ).toBe("http://langfuse.local");
  });

  it("lets config override env for runtime polling while env supplies missing settings", () => {
    expect(
      resolveLangfuseConfig({
        settings: {
          host: "http://configured.local",
          publicKey: "pk-cfg",
          waitMs: 0,
          timeoutMs: 2000,
        },
        env: {
          LANGFUSE_HOST: "http://env.local",
          LANGFUSE_PUBLIC_KEY: "pk-env",
          LANGFUSE_SECRET_KEY: "sk-env",
          LANGFUSE_WAIT_MS: "90000",
          LANGFUSE_TIMEOUT_MS: "10000",
          LANGFUSE_INITIAL_DELAY_MS: "12000",
        },
      }),
    ).toEqual({
      baseUrl: "http://configured.local",
      publicKey: "pk-cfg",
      secretKey: "sk-env",
      waitMs: 0,
      timeoutMs: 2000,
      initialDelayMs: 12000,
    });
  });

  it("honors enabled: false even when the environment is fully configured", () => {
    expect(
      resolveLangfuseConfig({
        settings: { enabled: false },
        env: {
          LANGFUSE_HOST: "http://langfuse.local",
          LANGFUSE_PUBLIC_KEY: "pk",
          LANGFUSE_SECRET_KEY: "sk",
        },
      }),
    ).toBeUndefined();
  });
});

describe("Langfuse payload extraction", () => {
  it("uses trace totals without adding their observations again", () => {
    const enrichment = extractLangfuseEnrichment({
      traces: [
        {
          id: "trace-1",
          totalCost: 0.012,
          usage: { input: 10, output: 5, total: 15 },
          observations: [
            { id: "obs-1", type: "generation", totalCost: 0.009, usage: { input: 8, output: 4 } },
            { id: "obs-2", type: "generation", totalCost: 0.003, usage: { input: 2, output: 1 } },
          ],
        },
      ],
    });

    expect(enrichment).toMatchObject({
      costUsd: 0.012,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      traceCount: 1,
    });
  });

  it("prefers the first populated alias instead of summing duplicates", () => {
    const enrichment = extractLangfuseEnrichment({
      traces: [
        {
          id: "trace-1",
          usage: { input: 10, promptTokens: 10, output: 4, completionTokens: 4 },
          usageDetails: { input: 10, output: 4 },
        },
      ],
    });

    expect(enrichment).toMatchObject({ inputTokens: 10, outputTokens: 4, totalTokens: 14 });
  });

  it("falls back to observation sums when the trace omits totals", () => {
    const enrichment = extractLangfuseEnrichment({
      traces: [
        {
          id: "trace-1",
          observations: [
            { id: "obs-1", type: "generation", cost: 0.004, usage: { input: 6, output: 2 } },
            { id: "obs-2", type: "generation", cost: 0.002, usage: { input: 3, output: 1 } },
          ],
        },
      ],
    });

    expect(enrichment).toMatchObject({
      costUsd: 0.006,
      inputTokens: 9,
      outputTokens: 3,
      totalTokens: 12,
    });
  });

  it("aggregates every trace of a multi-turn session", () => {
    const enrichment = extractLangfuseEnrichment({
      traces: [
        {
          id: "trace-1",
          url: "http://langfuse.local/project/traces/trace-1",
          totalCost: 0.01,
          usage: { input: 10, output: 5 },
          observations: [{ id: "obs-1", type: "tool", name: "calendar.create" }],
        },
        {
          id: "trace-2",
          totalCost: 0.02,
          usage: { input: 20, output: 6 },
          observations: [{ id: "obs-2", type: "TOOL", name: "calendar.read" }],
        },
      ],
    });

    expect(enrichment).toMatchObject({
      traceId: "trace-1",
      traceUrl: "http://langfuse.local/project/traces/trace-1",
      traceCount: 2,
      costUsd: 0.03,
      inputTokens: 30,
      outputTokens: 11,
      totalTokens: 41,
      toolCalls: [
        { name: "calendar.create", index: 0 },
        { name: "calendar.read", index: 1 },
      ],
    });
  });

  it("extracts enrichment from Langfuse v4 observation rows", () => {
    const enrichment = extractLangfuseEnrichment(
      {
        data: [
          {
            id: "obs-1",
            traceId: "trace-1",
            type: "GENERATION",
            name: "llm-call",
            inputUsage: 12,
            outputUsage: 4,
            totalUsage: 16,
            totalCost: 0.007,
          },
          {
            id: "obs-2",
            traceId: "trace-1",
            type: "SPAN",
            name: "iris-turn",
          },
          {
            id: "obs-3",
            traceId: "trace-2",
            type: "TOOL",
            name: "calendar.create",
            inputUsage: 3,
            outputUsage: 1,
            totalCost: 0.002,
          },
        ],
      },
      { baseUrl: "https://cloud.langfuse.com" },
    );

    expect(enrichment).toMatchObject({
      traceId: "trace-1",
      traceUrl: "https://cloud.langfuse.com/trace/trace-1",
      traceCount: 2,
      costUsd: 0.009,
      inputTokens: 15,
      outputTokens: 5,
      totalTokens: 16,
      toolCalls: [{ name: "calendar.create", index: 0 }],
    });
  });
  it("collects tool calls from toolCalls arrays in payload order, without deduplicating", () => {
    expect(
      extractLangfuseEnrichment({
        traces: [
          {
            id: "trace-1",
            observations: [
              {
                id: "obs-1",
                type: "generation",
                tool_calls: [{ function: { name: "search" } }, { name: "search" }],
                toolCalls: [{ toolName: "notify" }],
              },
            ],
          },
        ],
      })?.toolCalls,
    ).toEqual([
      { name: "notify", index: 0 },
      { name: "search", index: 1 },
      { name: "search", index: 2 },
    ]);
  });

  it("returns undefined when the session has no traces", () => {
    expect(extractLangfuseEnrichment({ id: "session-1", traces: [] })).toBeUndefined();
    expect(extractLangfuseEnrichment(undefined)).toBeUndefined();
  });
});

describe("extractToolCalls via extractLangfuseEnrichment", () => {
  it("orders tool calls by startTime rather than alphabetically", () => {
    const payload = {
      id: "trace-1",
      observations: [
        { id: "o1", type: "TOOL", name: "search", startTime: "2026-08-19T10:00:02.000Z" },
        { id: "o2", type: "TOOL", name: "calendar.create", startTime: "2026-08-19T10:00:01.000Z" },
      ],
    };

    const enrichment = extractLangfuseEnrichment(payload);

    expect(enrichment?.toolCalls.map((c) => c.name)).toEqual(["calendar.create", "search"]);
    expect(enrichment?.toolCalls.map((c) => c.index)).toEqual([0, 1]);
  });

  it("preserves duplicate tool calls instead of collapsing them", () => {
    const payload = {
      id: "trace-1",
      observations: [
        { id: "o1", type: "TOOL", name: "search", startTime: "2026-08-19T10:00:01.000Z" },
        { id: "o2", type: "TOOL", name: "search", startTime: "2026-08-19T10:00:02.000Z" },
        { id: "o3", type: "TOOL", name: "search", startTime: "2026-08-19T10:00:03.000Z" },
      ],
    };

    const enrichment = extractLangfuseEnrichment(payload);

    expect(enrichment?.toolCalls).toHaveLength(3);
  });

  it("keeps payload order when startTime is absent", () => {
    const payload = {
      id: "trace-1",
      observations: [
        { id: "o1", type: "TOOL", name: "zebra" },
        { id: "o2", type: "TOOL", name: "apple" },
      ],
    };

    const enrichment = extractLangfuseEnrichment(payload);

    expect(enrichment?.toolCalls.map((c) => c.name)).toEqual(["zebra", "apple"]);
  });

  it("reads args from an observation input object", () => {
    const payload = {
      id: "trace-1",
      observations: [
        {
          id: "o1",
          type: "TOOL",
          name: "calendar.create",
          input: { title: "Standup", tz: "UTC" },
        },
      ],
    };

    const enrichment = extractLangfuseEnrichment(payload);

    expect(enrichment?.toolCalls[0]?.args).toEqual({ title: "Standup", tz: "UTC" });
  });

  it("parses args from a JSON string in function.arguments", () => {
    const payload = {
      id: "trace-1",
      observations: [
        {
          id: "o1",
          type: "GENERATION",
          name: "llm",
          toolCalls: [{ function: { name: "calendar.create", arguments: '{"title":"Standup"}' } }],
        },
      ],
    };

    const enrichment = extractLangfuseEnrichment(payload);

    expect(enrichment?.toolCalls[0]?.name).toBe("calendar.create");
    expect(enrichment?.toolCalls[0]?.args).toEqual({ title: "Standup" });
  });

  it("returns an empty array, not undefined, when a trace has no tool calls", () => {
    const payload = {
      id: "trace-1",
      observations: [{ id: "o1", type: "GENERATION", name: "llm" }],
    };

    const enrichment = extractLangfuseEnrichment(payload);

    expect(enrichment).toBeDefined();
    expect(enrichment?.toolCalls).toEqual([]);
  });

  it("captures a tool error when the observation reports one", () => {
    const payload = {
      id: "trace-1",
      observations: [
        { id: "o1", type: "TOOL", name: "email.send", level: "ERROR", statusMessage: "smtp down" },
      ],
    };

    const enrichment = extractLangfuseEnrichment(payload);

    expect(enrichment?.toolCalls[0]?.error).toBe("smtp down");
  });
});

describe("LangfuseTraceSource lookup", () => {
  it("is undefined when Langfuse is not configured", () => {
    expect(LangfuseTraceSource.fromSettings(undefined, {})).toBeUndefined();
  });

  it("is undefined when settings disable it, even with a fully configured environment", () => {
    expect(
      LangfuseTraceSource.fromSettings(
        { enabled: false },
        {
          LANGFUSE_HOST: "http://langfuse.local",
          LANGFUSE_PUBLIC_KEY: "pk",
          LANGFUSE_SECRET_KEY: "sk",
        },
      ),
    ).toBeUndefined();
  });

  it("authenticates and queries the session traces endpoint", async () => {
    const stub = await stubSession(
      { data: [{ id: "trace-1", sessionId: "session-1" }] },
      {
        id: "trace-1",
        url: "http://langfuse.local/project/traces/trace-1",
        totalCost: 0.012,
        usage: { input: 10, output: 5, total: 15 },
        observations: [{ id: "obs-1", type: "tool", name: "calendar.create" }],
      },
    );

    const record = await new LangfuseTraceSource(config(stub.baseUrl), undefined, {
      waitMs: 0,
    }).resolve("session-1");

    expect(stub.requests).toHaveLength(2);
    expect(stub.requests[0]?.url).toContain("/api/public/traces");
    expect(stub.requests[0]?.url).toContain("sessionId=session-1");
    expect(stub.requests[1]?.url).toContain("/api/public/traces/trace-1");
    expect(stub.requests[0]?.authorization).toBe(
      `Basic ${Buffer.from("pk-test:sk-test").toString("base64")}`,
    );
    expect(record).toEqual({
      traceId: "trace-1",
      traceUrl: "http://langfuse.local/project/traces/trace-1",
      traceCount: 1,
      costUsd: 0.012,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      toolCalls: [{ name: "calendar.create", index: 0 }],
    });
  });

  it("reads figures from trace detail observations", async () => {
    const stub = await stubSession(
      { data: [{ id: "trace-1", sessionId: "session-1" }] },
      {
        id: "trace-1",
        sessionId: "session-1",
        observations: [
          {
            id: "obs-1",
            traceId: "trace-1",
            type: "GENERATION",
            name: "llm-call",
            inputUsage: 12,
            outputUsage: 4,
            totalUsage: 16,
            totalCost: 0.007,
          },
          { id: "obs-2", traceId: "trace-1", type: "TOOL", name: "calendar.create" },
        ],
      },
    );

    const record = await new LangfuseTraceSource(config(stub.baseUrl), undefined, {
      waitMs: 0,
    }).resolve("session-1");

    expect(stub.requests).toHaveLength(2);
    expect(record).toMatchObject({
      traceId: "trace-1",
      traceUrl: `${stub.baseUrl}/trace/trace-1`,
      costUsd: 0.007,
      inputTokens: 12,
      outputTokens: 4,
      totalTokens: 16,
      toolCalls: [{ name: "calendar.create", index: 0 }],
    });
  });

  it("polls until an asynchronously ingested trace appears", async () => {
    const stub = await stubSession(
      { id: "session-1", traces: [] },
      { data: [{ id: "trace-1", sessionId: "session-1" }] },
      { id: "trace-1", totalCost: 0.004 },
    );

    const record = await new LangfuseTraceSource(config(stub.baseUrl), undefined, {
      waitMs: 2000,
      initialBackoffMs: 1,
    }).resolve("session-1");

    expect(stub.requests.length).toBeGreaterThanOrEqual(2);
    expect(record?.costUsd).toBe(0.004);
  });

  it("tries once immediately before waiting for the remaining initial delay", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T00:00:10.000Z"));
    const calls: number[] = [];
    const startedAt = Date.now() - 5000;

    const source = new LangfuseTraceSource(
      config("http://langfuse.local"),
      pollingFetch(calls, () => calls.length > 1),
      { initialDelayMs: 8000, waitMs: 10000, initialBackoffMs: 1000 },
    );
    const promise = source.resolve("session-1", { startedAt });

    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([Date.parse("2026-07-30T00:00:10.000Z")]);
    await vi.advanceTimersByTimeAsync(2999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toMatchObject({ costUsd: 0.004 });
    // 5s of the 8s ingestion delay was spent running the scenario, so only 3s remained.
    expect(calls[1]).toBe(startedAt + 8000);
  });

  it("does not add initial delay when scenario runtime already consumed it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T00:00:10.000Z"));
    const calls: number[] = [];

    const source = new LangfuseTraceSource(
      config("http://langfuse.local"),
      pollingFetch(calls, () => true),
      { initialDelayMs: 8000, waitMs: 15000, initialBackoffMs: 1000 },
    );
    const promise = source.resolve("session-1", { startedAt: Date.now() - 9000 });

    await vi.advanceTimersByTimeAsync(0);
    await expect(promise).resolves.toMatchObject({ costUsd: 0.004 });
    expect(calls).toEqual([Date.parse("2026-07-30T00:00:10.000Z")]);
  });

  it("carries initialDelayMs from settings through fromSettings", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T00:00:10.000Z"));
    const calls: number[] = [];
    const startedAt = Date.now();
    vi.stubGlobal(
      "fetch",
      pollingFetch(calls, () => calls.length > 1),
    );

    const source = LangfuseTraceSource.fromSettings({
      host: "http://langfuse.local",
      publicKey: "pk-test",
      secretKey: "sk-test",
      initialDelayMs: 6000,
      waitMs: 20000,
    });
    const promise = source?.resolve("session-1", { startedAt });

    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(6000);
    await expect(promise).resolves.toMatchObject({ costUsd: 0.004 });
    expect(calls[1]).toBe(startedAt + 6000);
    vi.unstubAllGlobals();
  });

  it("uses exponential backoff between lookup attempts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T00:00:00.000Z"));
    const calls: number[] = [];

    const source = new LangfuseTraceSource(
      config("http://langfuse.local"),
      pollingFetch(calls, () => calls.length >= 4),
      { waitMs: 20000, initialBackoffMs: 1000 },
    );
    const promise = source.resolve("session-1");

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);
    await expect(promise).resolves.toMatchObject({ costUsd: 0.004 });

    expect(calls).toEqual([
      Date.parse("2026-07-30T00:00:00.000Z"),
      Date.parse("2026-07-30T00:00:01.000Z"),
      Date.parse("2026-07-30T00:00:03.000Z"),
      Date.parse("2026-07-30T00:00:07.000Z"),
    ]);
  });

  it("keeps polling after a slow scenario already exceeded waitMs from scenario start", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T00:01:00.000Z"));
    const calls: number[] = [];

    const source = new LangfuseTraceSource(
      config("http://langfuse.local"),
      pollingFetch(calls, () => calls.length > 1),
      { waitMs: 1000, initialDelayMs: 8000, initialBackoffMs: 100 },
    );
    const promise = source.resolve("session-1", { startedAt: Date.now() - 30000 });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    await expect(promise).resolves.toMatchObject({ costUsd: 0.004 });
  });

  it("uses a fresh timeout signal for each trace lookup request", async () => {
    const signals = new Set<AbortSignal | null | undefined>();

    const source = new LangfuseTraceSource(
      config("http://langfuse.local"),
      (async (url: string, init?: RequestInit) => {
        signals.add(init?.signal);
        if (String(url).includes("/api/public/traces/trace-1")) {
          return { ok: true, status: 200, json: async () => ({ id: "trace-1", totalCost: 0.002 }) };
        }
        if (String(url).includes("/api/public/traces/trace-2")) {
          return { ok: true, status: 200, json: async () => ({ id: "trace-2", totalCost: 0.003 }) };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: "trace-1" }, { id: "trace-2" }] }),
        };
      }) as unknown as typeof fetch,
      { waitMs: 0 },
    );

    await expect(source.resolve("session-1")).resolves.toMatchObject({
      traceCount: 2,
      costUsd: 0.005,
    });
    expect(signals.size).toBe(3);
  });

  it("keeps polling when a trace detail is listed before it is readable", async () => {
    const stub = await stubSession(
      { data: [{ id: "trace-1" }] },
      { status: 404 },
      { data: [{ id: "trace-1" }] },
      { id: "trace-1", totalCost: 0.004 },
    );

    const record = await new LangfuseTraceSource(config(stub.baseUrl), undefined, {
      waitMs: 2000,
      initialBackoffMs: 1,
    }).resolve("session-1");

    expect(record?.costUsd).toBe(0.004);
  });

  it("resolves to undefined when no trace is ingested within waitMs", async () => {
    const stub = await stubSession({ data: [] });

    const record = await new LangfuseTraceSource(config(stub.baseUrl), undefined, {
      waitMs: 0,
    }).resolve("session-1");

    expect(record).toBeUndefined();
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]?.url).toContain("/api/public/traces");
    expect(stub.requests[0]?.url).toContain("sessionId=session-1");
  });

  it("throws on a non-404 lookup failure so the runner can record it", async () => {
    const stub = await stubSession({ status: 503 });

    await expect(
      new LangfuseTraceSource(config(stub.baseUrl), undefined, { waitMs: 0 }).resolve("session-1"),
    ).rejects.toThrow("Langfuse lookup failed with status 503");
  });

  it("propagates an aborted lookup as a rejection", async () => {
    const source = new LangfuseTraceSource(
      config("http://127.0.0.1:9"),
      ((_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })) as unknown as typeof fetch,
      { timeoutMs: 10, waitMs: 0 },
    );

    await expect(source.resolve("session-1")).rejects.toThrow("aborted");
  });

  it("resolves to undefined when the session listing 404s before the traces exist", async () => {
    const stub = await stubSession({ status: 404 }, { traces: [] });

    await expect(
      new LangfuseTraceSource(config(stub.baseUrl), undefined, { waitMs: 0 }).resolve("session-1"),
    ).resolves.toBeUndefined();
  });

  it("resolves to undefined when a listed trace detail 404s", async () => {
    const stub = await stubSession({ data: [] }, { status: 404 });

    await expect(
      new LangfuseTraceSource(config(stub.baseUrl), undefined, { waitMs: 0 }).resolve("session-1"),
    ).resolves.toBeUndefined();
  });
});
