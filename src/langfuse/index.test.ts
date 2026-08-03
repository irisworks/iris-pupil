import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Verdict, type RunResult, type ScenarioResult } from "../core/types.js";
import {
  enrichRunWithLangfuse,
  enrichScenarioWithLangfuse,
  extractLangfuseEnrichment,
  langfuseConfigFromEnv,
  resolveLangfuseConfig,
} from "./index.js";

let server: Server | undefined;

function scenarioResult(overrides: Partial<ScenarioResult> = {}): ScenarioResult {
  return {
    scenarioId: "scenario-1",
    scenarioName: "Scenario 1",
    verdict: Verdict.Pass,
    scores: [],
    turns: [],
    startedAt: "2026-07-30T00:00:00.000Z",
    completedAt: "2026-07-30T00:00:01.000Z",
    metrics: { turns: 1, latency_ms: 1000 },
    metadata: { sessionId: "session-1" },
    ...overrides,
  };
}

function runResult(results: ScenarioResult[] = [scenarioResult()]): RunResult {
  return {
    runId: "run-1",
    verdict: Verdict.Pass,
    startedAt: "2026-07-30T00:00:00.000Z",
    completedAt: "2026-07-30T00:00:01.000Z",
    results,
    summary: {
      total: results.length,
      passed: results.length,
      failed: 0,
      needsReview: 0,
      errors: 0,
    },
    metadata: {},
  };
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
      }),
    ).toEqual({
      baseUrl: "http://langfuse.local",
      publicKey: "pk",
      secretKey: "sk",
      waitMs: 60000,
      timeoutMs: 15000,
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

  it("prefers pupil.config.yaml settings over the environment", () => {
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
        },
      }),
    ).toEqual({
      baseUrl: "http://configured.local",
      publicKey: "pk-cfg",
      secretKey: "sk-env",
      waitMs: 0,
      timeoutMs: 2000,
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
      toolCalls: ["calendar.create", "calendar.read"],
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
      toolCalls: ["calendar.create"],
    });
  });
  it("collects tool names from toolCalls arrays", () => {
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
    ).toEqual(["notify", "search"]);
  });

  it("returns undefined when the session has no traces", () => {
    expect(extractLangfuseEnrichment({ id: "session-1", traces: [] })).toBeUndefined();
    expect(extractLangfuseEnrichment(undefined)).toBeUndefined();
  });
});

describe("Langfuse enrichment", () => {
  it("skips cleanly when Langfuse is not configured", async () => {
    const run = runResult();

    await expect(enrichRunWithLangfuse(run, { env: {} })).resolves.toBe(run);
    expect(run.results[0]?.metrics).toEqual({ turns: 1, latency_ms: 1000 });
    expect(run.results[0]?.metadata).toEqual({ sessionId: "session-1" });
    expect(run.metadata).toEqual({});
  });

  it("enriches run results from a stubbed Langfuse session endpoint", async () => {
    const stub = await stubSession({
      id: "session-1",
      traces: [
        {
          id: "trace-1",
          url: "http://langfuse.local/project/traces/trace-1",
          totalCost: 0.012,
          usage: { input: 10, output: 5, total: 15 },
          observations: [{ id: "obs-1", type: "tool", name: "calendar.create" }],
        },
      ],
    });
    const run = runResult();

    await enrichRunWithLangfuse(run, { config: config(stub.baseUrl), waitMs: 0 });

    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]?.url).toContain("/api/public/v2/observations");
    expect(stub.requests[0]?.url).toContain("session-1");
    expect(stub.requests[0]?.authorization).toBe(
      `Basic ${Buffer.from("pk-test:sk-test").toString("base64")}`,
    );
    expect(run.results[0]?.metrics).toMatchObject({
      cost_usd: 0.012,
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      tool_calls: 1,
    });
    expect(run.results[0]?.metadata?.langfuse).toEqual({
      status: "enriched",
      sessionId: "session-1",
      traceId: "trace-1",
      traceUrl: "http://langfuse.local/project/traces/trace-1",
      toolCalls: ["calendar.create"],
    });
    expect(run.metadata.langfuse).toEqual({
      status: "enriched",
      enriched: 1,
      skipped: 0,
      failed: 0,
    });
  });

  it("polls until an asynchronously ingested trace appears", async () => {
    const stub = await stubSession(
      { id: "session-1", traces: [] },
      { id: "session-1", traces: [{ id: "trace-1", totalCost: 0.004 }] },
    );
    const result = scenarioResult();

    await expect(
      enrichScenarioWithLangfuse(result, {
        config: config(stub.baseUrl),
        waitMs: 2000,
        pollIntervalMs: 1,
      }),
    ).resolves.toBe("enriched");

    expect(stub.requests.length).toBeGreaterThanOrEqual(2);
    expect(result.metrics.cost_usd).toBe(0.004);
  });

  it("records a skip when no trace is ingested within waitMs", async () => {
    const stub = await stubSession({ data: [] });
    const result = scenarioResult();

    await expect(
      enrichScenarioWithLangfuse(result, { config: config(stub.baseUrl), waitMs: 0 }),
    ).resolves.toBe("skipped");

    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]?.url).toContain("/api/public/v2/observations");
    expect(result.metadata?.langfuse).toEqual({
      status: "skipped",
      sessionId: "session-1",
      reason: "No trace found for session",
    });
    expect(result.metrics).toEqual({ turns: 1, latency_ms: 1000 });
  });

  it("skips scenarios without a session id", async () => {
    const result = scenarioResult({ metadata: undefined });

    await expect(
      enrichScenarioWithLangfuse(result, { config: config("http://127.0.0.1:1"), waitMs: 0 }),
    ).resolves.toBe("skipped");

    expect(result.metadata?.langfuse).toEqual({
      status: "skipped",
      reason: "No session id available",
    });
  });

  it("falls back to the session id carried on a turn response", async () => {
    const stub = await stubSession({ traces: [{ id: "trace-9" }] });
    const result = scenarioResult({
      metadata: undefined,
      turns: [
        {
          index: 0,
          user: "hi",
          startedAt: "2026-07-30T00:00:00.000Z",
          assertions: [],
          response: { text: "ok", raw: { session_id: "session-from-turn" } },
        },
      ],
    });

    await enrichScenarioWithLangfuse(result, { config: config(stub.baseUrl), waitMs: 0 });

    expect(stub.requests[0]?.url).toContain("/api/public/v2/observations");
    expect(stub.requests[0]?.url).toContain("session-from-turn");
    expect(result.metadata?.langfuse).toMatchObject({ sessionId: "session-from-turn" });
  });

  it("records lookup errors without failing the run", async () => {
    const stub = await stubSession({ status: 503 });
    const run = runResult();

    await expect(
      enrichRunWithLangfuse(run, { config: config(stub.baseUrl), waitMs: 0 }),
    ).resolves.toBe(run);

    expect(run.verdict).toBe(Verdict.Pass);
    expect(run.results[0]?.metadata?.langfuse).toMatchObject({
      status: "error",
      sessionId: "session-1",
      reason: "Langfuse lookup failed with status 503",
    });
    expect(run.metadata.langfuse).toMatchObject({ status: "partial", failed: 1 });
  });

  it("records an aborted lookup as an error without throwing", async () => {
    const result = scenarioResult();

    await expect(
      enrichScenarioWithLangfuse(result, {
        config: config("http://127.0.0.1:9"),
        timeoutMs: 10,
        waitMs: 0,
        fetchImpl: ((_url: string, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          })) as unknown as typeof fetch,
      }),
    ).resolves.toBe("error");

    expect(result.metadata?.langfuse).toMatchObject({ status: "error", reason: "aborted" });
  });
});
