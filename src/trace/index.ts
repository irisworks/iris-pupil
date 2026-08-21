import { isRecord } from "../core/json.js";
import type { RunResult, ScenarioResult, ToolCall, Trajectory } from "../core/types.js";

export interface TraceRecord {
  readonly traceId?: string;
  readonly traceUrl?: string;
  readonly traceCount: number;
  readonly costUsd?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  /**
   * Observed tool calls in call order.
   *
   * `undefined` means this backend does not report tool calls at all, and tool
   * assertions must skip. An empty array means the backend looked and the agent
   * called no tools — a real observation that tool assertions must score.
   * These two must never be collapsed into one another.
   */
  readonly toolCalls?: readonly ToolCall[];
}

export type TraceStatus = "enriched" | "skipped" | "error";

export const NO_CORRELATION_KEY_REASON = "No correlation key available";
export const NO_TRACE_FOUND_REASON = "No trace found for session";

export type TraceLookupResult =
  | { status: "found"; record: TraceRecord }
  | { status: "missing"; reason?: string }
  | { status: "error"; reason: string };

/**
 * Context the runner knows about a completed scenario, passed to every lookup.
 *
 * Backends that poll an asynchronous ingestion pipeline use `startedAt` to
 * discount time the scenario itself already spent, so a slow scenario does not
 * pay an ingestion delay twice. Backends that read synchronously may ignore it.
 */
export interface TraceLookupContext {
  /** Start of the scenario attempt this trace belongs to, in epoch milliseconds. */
  readonly startedAt?: number;
}

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
 * Note: resolve() assumes a single string correlation key (session ID), plus
 * the optional TraceLookupContext. If a future backend requires a richer key,
 * revisit this signature with real requirements at that point.
 *
 * Adding a second backend: implement this interface, set metadataKey,
 * implement resolve(), and pass an instance as traceSource to runScenario.
 * No changes required in core.
 */
export interface TraceSource {
  readonly metadataKey: string;
  resolve(correlationKey: string, context?: TraceLookupContext): Promise<TraceRecord | undefined>;
}

/** A named population's resolved fetch parameters, after config + CLI-flag merging. */
export interface TracePopulationQuery {
  name?: string;
  tags?: readonly string[];
  userId?: string;
  /** Relative ("24h") or ISO 8601. Always required by the time resolvePopulationQuery returns it. */
  since: string;
  /** Relative or ISO 8601; defaults to "now" if unset. */
  until?: string;
  limit?: number;
}

/**
 * Resolves a population of production traces as ready-to-evaluate Trajectories.
 *
 * Implementations are backend-specific (Langfuse today); `pupil observe` depends
 * only on this interface. Unlike TraceSource.resolve() (which returns undefined
 * for "not found yet" so the runner can skip gracefully), fetch() throwing means
 * the population could not be retrieved at all — pupil observe has no partial
 * result to fall back to, so the command fails outright.
 */
export interface TracePopulationSource {
  readonly metadataKey: string;
  fetch(query: TracePopulationQuery): Promise<Trajectory[]>;
}

/** Trace-record figures translated into the Trajectory/ScenarioResult metrics namespace. */
export function metricsFromTraceRecord(record: TraceRecord): Record<string, number> {
  const metrics: Record<string, number> = {};
  if (record.costUsd !== undefined) metrics.cost_usd = record.costUsd;
  if (record.inputTokens !== undefined) metrics.input_tokens = record.inputTokens;
  if (record.outputTokens !== undefined) metrics.output_tokens = record.outputTokens;
  if (record.totalTokens !== undefined) metrics.total_tokens = record.totalTokens;
  if (record.toolCalls !== undefined) {
    // tool_calls preserves its pre-PR meaning (distinct tool names used) so an
    // existing threshold/baseline on it cannot silently misfire. tool_invocations
    // is total call count (efficiency regressions like retry loops).
    metrics.tool_calls = new Set(record.toolCalls.map((call) => call.name)).size;
    metrics.tool_invocations = record.toolCalls.length;
  }
  return metrics;
}

/**
 * Builds a `Trajectory` directly from trace evidence with no conversational
 * turns — used by `pupil observe`, where a production trace carries tool
 * calls and metrics but no scenario steps.
 */
export function trajectoryFromTraceRecord(record: TraceRecord): Trajectory {
  return {
    source: "trace",
    steps: [],
    metrics: metricsFromTraceRecord(record),
    metadata: {
      ...(record.traceId !== undefined && { traceId: record.traceId }),
      ...(record.traceUrl !== undefined && { traceUrl: record.traceUrl }),
    },
    ...(record.toolCalls !== undefined && { toolCalls: record.toolCalls }),
  };
}

/**
 * Writes a lookup outcome onto a scenario result. `correlationKey` is undefined when
 * the run produced no key to look up with; the key is then omitted from metadata so
 * "we never looked" stays distinguishable from "we looked and found nothing".
 */
export function applyTraceEnrichment(
  result: ScenarioResult,
  correlationKey: string | undefined,
  lookup: TraceLookupResult,
  metadataKey: string,
): TraceStatus {
  const sessionId = correlationKey !== undefined ? { sessionId: correlationKey } : {};

  if (lookup.status === "error") {
    result.metadata = {
      ...(result.metadata ?? {}),
      [metadataKey]: { status: "error", ...sessionId, reason: lookup.reason },
    };
    return "error";
  }

  if (lookup.status === "missing") {
    result.metadata = {
      ...(result.metadata ?? {}),
      [metadataKey]: {
        status: "skipped",
        ...sessionId,
        reason: lookup.reason ?? NO_TRACE_FOUND_REASON,
      },
    };
    return "skipped";
  }

  const { record } = lookup;
  Object.assign(result.metrics, metricsFromTraceRecord(record));

  result.metadata = {
    ...(result.metadata ?? {}),
    [metadataKey]: {
      status: "enriched",
      ...sessionId,
      traceId: record.traceId,
      traceUrl: record.traceUrl,
      ...(record.traceCount > 1 && { traceCount: record.traceCount }),
      // Names only: run history is JSON and reviewed in PRs, so it stays compact
      // and diffable. Full ToolCall detail reaches evaluators via the Trajectory.
      ...(record.toolCalls !== undefined && {
        toolCalls: record.toolCalls.map((call) => call.name),
      }),
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
