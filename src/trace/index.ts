import type { RunResult, ScenarioResult } from "../core/types.js";

export interface TraceRecord {
  readonly traceId?: string;
  readonly traceUrl?: string;
  readonly traceCount: number;
  readonly costUsd?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly toolCalls: readonly string[];
}

export type TraceStatus = "enriched" | "skipped" | "error";

export type TraceLookupResult =
  | { status: "found"; record: TraceRecord }
  | { status: "missing" }
  | { status: "error"; reason: string };

/**
 * Resolves observability evidence for a completed scenario run.
 *
 * Implementations are backend-specific (Langfuse, OTel, etc.) and are
 * injected into the runner — core never depends on a concrete implementation.
 *
 * `metadataKey` is the key written into ScenarioResult.metadata and
 * RunResult.metadata for this backend (e.g. "langfuse", "otel"). It is
 * only a metadata namespace — it does not affect any other behaviour.
 *
 * `resolve` returns undefined when no trace is found for the correlation key.
 * It should throw only on unrecoverable errors; the runner converts exceptions
 * into TraceLookupResult { status: "error" } so verdicts are never affected.
 *
 * Implementations must be stateless and safe to reuse across multiple
 * concurrent scenario executions.
 *
 * Note: resolve() assumes a single string correlation key (session ID).
 * If a future backend requires richer context, revisit this signature
 * with real requirements at that point.
 *
 * Adding a second backend: implement this interface, set metadataKey,
 * implement resolve(), and pass an instance as traceSource to runScenario.
 * No changes required in core.
 */
export interface TraceSource {
  readonly metadataKey: string;
  resolve(correlationKey: string): Promise<TraceRecord | undefined>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function applyTraceEnrichment(
  result: ScenarioResult,
  correlationKey: string,
  lookup: TraceLookupResult,
  metadataKey: string,
): TraceStatus {
  if (lookup.status === "error") {
    result.metadata = {
      ...(result.metadata ?? {}),
      [metadataKey]: { status: "error", sessionId: correlationKey, reason: lookup.reason },
    };
    return "error";
  }

  if (lookup.status === "missing") {
    result.metadata = {
      ...(result.metadata ?? {}),
      [metadataKey]: { status: "skipped", sessionId: correlationKey, reason: "No trace found for session" },
    };
    return "skipped";
  }

  const { record } = lookup;
  if (record.costUsd !== undefined) result.metrics.cost_usd = record.costUsd;
  if (record.inputTokens !== undefined) result.metrics.input_tokens = record.inputTokens;
  if (record.outputTokens !== undefined) result.metrics.output_tokens = record.outputTokens;
  if (record.totalTokens !== undefined) result.metrics.total_tokens = record.totalTokens;
  result.metrics.tool_calls = record.toolCalls.length;

  result.metadata = {
    ...(result.metadata ?? {}),
    [metadataKey]: {
      status: "enriched",
      sessionId: correlationKey,
      traceId: record.traceId,
      traceUrl: record.traceUrl,
      ...(record.traceCount > 1 && { traceCount: record.traceCount }),
      toolCalls: record.toolCalls,
    },
  };
  return "enriched";
}

export function summarizeTraceRun(run: RunResult, metadataKey: string): RunResult {
  let enriched = 0;
  let skipped = 0;
  let failed = 0;

  for (const result of run.results) {
    const traceMeta = isRecord(result.metadata) ? result.metadata[metadataKey] : undefined;
    const status = isRecord(traceMeta) ? traceMeta.status : undefined;
    if (status === "enriched") enriched += 1;
    else if (status === "skipped") skipped += 1;
    else if (status === "error") failed += 1;
  }

  if (enriched === 0 && skipped === 0 && failed === 0) return run;

  run.metadata = {
    ...run.metadata,
    [metadataKey]: {
      status: failed > 0 ? "partial" : enriched > 0 ? "enriched" : "skipped",
      enriched,
      skipped,
      failed,
    },
  };
  return run;
}
