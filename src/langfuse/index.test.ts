import { createServer, type RequestListener, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Verdict, type RunResult } from "../core/types.js";
import { enrichRunWithLangfuse, langfuseConfigFromEnv } from "./index.js";

let server: Server | undefined;

function runResult(): RunResult {
  return {
    runId: "run-1",
    verdict: Verdict.Pass,
    startedAt: "2026-07-30T00:00:00.000Z",
    completedAt: "2026-07-30T00:00:01.000Z",
    results: [
      {
        scenarioId: "scenario-1",
        scenarioName: "Scenario 1",
        verdict: Verdict.Pass,
        scores: [],
        turns: [],
        startedAt: "2026-07-30T00:00:00.000Z",
        completedAt: "2026-07-30T00:00:01.000Z",
        metrics: { turns: 1, latency_ms: 1000 },
        metadata: { sessionId: "session-1" },
      },
    ],
    summary: { total: 1, passed: 1, failed: 0, needsReview: 0, errors: 0 },
    metadata: {},
  };
}

async function listen(handler: RequestListener): Promise<string> {
  server = createServer(handler);
  return new Promise((resolve, reject) => {
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
}

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server?.close((error) => (error ? reject(error) : resolve()));
  });
  server = undefined;
});

describe("Langfuse enrichment", () => {
  it("loads config only when all Langfuse env vars are present", () => {
    expect(langfuseConfigFromEnv({})).toBeUndefined();
    expect(
      langfuseConfigFromEnv({
        LANGFUSE_BASE_URL: "http://langfuse.local/",
        LANGFUSE_PUBLIC_KEY: "pk",
        LANGFUSE_SECRET_KEY: "sk",
      }),
    ).toEqual({ baseUrl: "http://langfuse.local", publicKey: "pk", secretKey: "sk" });
  });

  it("skips cleanly when Langfuse env vars are missing", async () => {
    const run = runResult();

    await expect(enrichRunWithLangfuse(run, { env: {} })).resolves.toBe(run);
    expect(run.results[0]?.metrics).toEqual({ turns: 1, latency_ms: 1000 });
    expect(run.metadata).toEqual({});
  });

  it("enriches run results from a stubbed Langfuse session endpoint", async () => {
    const baseUrl = await listen((req, res) => {
      expect(req.url).toBe("/api/public/sessions/session-1");
      expect(req.headers.authorization).toBe(
        `Basic ${Buffer.from("pk-test:sk-test").toString("base64")}`,
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "session-1",
          traces: [
            {
              id: "trace-1",
              url: "http://langfuse.local/project/traces/trace-1",
              totalCost: 0.012,
              usage: { input: 10, output: 5, total: 15 },
              observations: [
                { id: "obs-1", type: "tool", name: "calendar.create" },
                {
                  id: "obs-2",
                  type: "generation",
                  totalCost: 0.003,
                  usage: { input: 2, output: 1 },
                },
              ],
            },
          ],
        }),
      );
    });
    const run = runResult();

    await enrichRunWithLangfuse(run, {
      config: { baseUrl, publicKey: "pk-test", secretKey: "sk-test" },
    });

    expect(run.results[0]?.metrics).toMatchObject({
      cost_usd: 0.015,
      input_tokens: 12,
      output_tokens: 6,
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

  it("records lookup errors without failing the run", async () => {
    const baseUrl = await listen((_req, res) => {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "offline" }));
    });
    const run = runResult();

    await expect(
      enrichRunWithLangfuse(run, {
        config: { baseUrl, publicKey: "pk-test", secretKey: "sk-test" },
      }),
    ).resolves.toBe(run);

    expect(run.verdict).toBe(Verdict.Pass);
    expect(run.results[0]?.metadata?.langfuse).toMatchObject({
      status: "error",
      sessionId: "session-1",
      reason: "Langfuse lookup failed with status 503",
    });
    expect(run.metadata.langfuse).toMatchObject({ status: "partial", failed: 1 });
  });
});
