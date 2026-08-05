import { describe, it, expect } from "vitest";
import { Verdict, type RunResult, type ScenarioResult } from "../core/types.js";
import { applyTraceEnrichment, summarizeTraceRun, type TraceLookupResult } from "./index.js";

function makeResult(overrides: Partial<ScenarioResult> = {}): ScenarioResult {
  return {
    scenarioId: "s1",
    scenarioName: "S1",
    verdict: Verdict.Pass,
    scores: [],
    turns: [],
    startedAt: "2026-08-05T00:00:00.000Z",
    completedAt: "2026-08-05T00:00:01.000Z",
    metrics: { turns: 1, latency_ms: 1000 },
    ...overrides,
  };
}

function makeRun(results: ScenarioResult[]): RunResult {
  return {
    runId: "r1",
    verdict: Verdict.Pass,
    startedAt: "2026-08-05T00:00:00.000Z",
    completedAt: "2026-08-05T00:00:01.000Z",
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

describe("applyTraceEnrichment", () => {
  it("writes metrics and metadata when record is found", () => {
    const result = makeResult();
    const lookup: TraceLookupResult = {
      status: "found",
      record: {
        traceId: "t1",
        traceUrl: "http://lf/t/t1",
        traceCount: 1,
        costUsd: 0.012,
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        toolCalls: ["search", "send"],
      },
    };
    const status = applyTraceEnrichment(result, "sess-1", lookup, "langfuse");
    expect(status).toBe("enriched");
    expect(result.metrics.cost_usd).toBe(0.012);
    expect(result.metrics.input_tokens).toBe(100);
    expect(result.metrics.output_tokens).toBe(50);
    expect(result.metrics.total_tokens).toBe(150);
    expect(result.metrics.tool_calls).toBe(2);
    expect(result.metadata?.langfuse).toMatchObject({
      status: "enriched",
      sessionId: "sess-1",
      traceId: "t1",
      traceUrl: "http://lf/t/t1",
      toolCalls: ["search", "send"],
    });
  });

  it("omits metric keys when record fields are undefined", () => {
    const result = makeResult();
    const lookup: TraceLookupResult = {
      status: "found",
      record: { traceCount: 1, toolCalls: [] },
    };
    applyTraceEnrichment(result, "sess-1", lookup, "langfuse");
    expect(result.metrics.cost_usd).toBeUndefined();
    expect(result.metrics.input_tokens).toBeUndefined();
  });

  it("includes traceCount in metadata only when > 1", () => {
    const result = makeResult();
    const lookup: TraceLookupResult = {
      status: "found",
      record: { traceCount: 3, toolCalls: [] },
    };
    applyTraceEnrichment(result, "sess-1", lookup, "langfuse");
    expect((result.metadata?.langfuse as Record<string, unknown>).traceCount).toBe(3);

    const result2 = makeResult();
    const lookup2: TraceLookupResult = {
      status: "found",
      record: { traceCount: 1, toolCalls: [] },
    };
    applyTraceEnrichment(result2, "sess-1", lookup2, "langfuse");
    expect((result2.metadata?.langfuse as Record<string, unknown>).traceCount).toBeUndefined();
  });

  it("writes skipped status when missing", () => {
    const result = makeResult();
    const lookup: TraceLookupResult = { status: "missing" };
    const status = applyTraceEnrichment(result, "sess-1", lookup, "langfuse");
    expect(status).toBe("skipped");
    expect(result.metadata?.langfuse).toMatchObject({
      status: "skipped",
      sessionId: "sess-1",
    });
    expect(result.metrics.cost_usd).toBeUndefined();
  });

  it("writes error status when errored", () => {
    const result = makeResult();
    const lookup: TraceLookupResult = { status: "error", reason: "timeout" };
    const status = applyTraceEnrichment(result, "sess-1", lookup, "langfuse");
    expect(status).toBe("error");
    expect(result.metadata?.langfuse).toMatchObject({
      status: "error",
      sessionId: "sess-1",
      reason: "timeout",
    });
  });

  it("never changes verdict", () => {
    const result = makeResult({ verdict: Verdict.Fail });
    applyTraceEnrichment(result, "sess-1", { status: "missing" }, "langfuse");
    expect(result.verdict).toBe(Verdict.Fail);
  });

  it("uses the provided metadataKey", () => {
    const result = makeResult();
    applyTraceEnrichment(result, "k", { status: "missing" }, "otel");
    expect(result.metadata?.otel).toBeDefined();
    expect(result.metadata?.langfuse).toBeUndefined();
  });
});

describe("summarizeTraceRun", () => {
  it("returns run unchanged when no enrichment metadata present", () => {
    const run = makeRun([makeResult()]);
    const result = summarizeTraceRun(run, "langfuse");
    expect(result.metadata.langfuse).toBeUndefined();
  });

  it("aggregates enriched/skipped/error counts", () => {
    const r1 = makeResult({ metadata: { langfuse: { status: "enriched" } } });
    const r2 = makeResult({ metadata: { langfuse: { status: "enriched" } } });
    const r3 = makeResult({ metadata: { langfuse: { status: "skipped" } } });
    const r4 = makeResult({ metadata: { langfuse: { status: "error" } } });
    const run = makeRun([r1, r2, r3, r4]);
    const result = summarizeTraceRun(run, "langfuse");
    expect(result.metadata.langfuse).toMatchObject({
      status: "partial",
      enriched: 2,
      skipped: 1,
      failed: 1,
    });
  });

  it("uses provided metadataKey", () => {
    const r1 = makeResult({ metadata: { otel: { status: "enriched" } } });
    const run = makeRun([r1]);
    const result = summarizeTraceRun(run, "otel");
    expect(result.metadata.otel).toBeDefined();
    expect(result.metadata.langfuse).toBeUndefined();
  });
});
