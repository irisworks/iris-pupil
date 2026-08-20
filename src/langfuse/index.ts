import { Buffer } from "node:buffer";
import { firstString, isRecord, type JsonRecord } from "../core/json.js";
import type { ToolCall } from "../core/types.js";
import type { TraceLookupContext, TraceRecord, TraceSource } from "../trace/index.js";

export interface LangfuseEnrichment {
  readonly traceId?: string;
  readonly traceUrl?: string;
  readonly traceCount: number;
  readonly costUsd?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly toolCalls: ToolCall[];
}

export interface LangfuseConfig {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
  waitMs?: number;
  timeoutMs?: number;
  initialDelayMs?: number;
}

/**
 * Subset of `PupilConfig["langfuse"]` that enrichment needs. Kept structural so the
 * langfuse module does not depend on config loading.
 */
export interface LangfuseSettings {
  enabled?: boolean | "auto";
  host?: string;
  publicKey?: string;
  secretKey?: string;
  waitMs?: number;
  timeoutMs?: number;
  initialDelayMs?: number;
}

/** Polling knobs for {@link LangfuseTraceSource}. */
export interface LangfuseTraceSourceOptions {
  /** How long to keep polling for a trace; Langfuse ingestion is asynchronous. */
  waitMs?: number;
  /** Earliest point, measured from scenario start, when a second poll is expected to be useful. */
  initialDelayMs?: number;
  /** Initial backoff delay between trace lookup attempts. Primarily useful for tests. */
  initialBackoffMs?: number;
  /** Bound on each individual HTTP lookup. */
  timeoutMs?: number;
}

const DEFAULT_LANGFUSE_TIMEOUT_MS = 3000;
const DEFAULT_LANGFUSE_WAIT_MS = 25_000;
const DEFAULT_LANGFUSE_INITIAL_DELAY_MS = 8_000;
const DEFAULT_LANGFUSE_INITIAL_BACKOFF_MS = 1_000;
const DEFAULT_LANGFUSE_MAX_BACKOFF_MS = 15_000;

const COST_KEYS = ["totalCost", "cost", "costUsd", "calculatedTotalCost", "total_cost"];
const COST_PATHS = [
  ["usage", "totalCost"],
  ["usageDetails", "totalCost"],
];
const INPUT_TOKEN_KEYS = [
  "inputTokens",
  "promptTokens",
  "input_tokens",
  "prompt_tokens",
  "inputUsage",
];
const INPUT_TOKEN_PATHS = [
  ["usage", "input"],
  ["usage", "promptTokens"],
  ["usageDetails", "input"],
];
const OUTPUT_TOKEN_KEYS = [
  "outputTokens",
  "completionTokens",
  "output_tokens",
  "completion_tokens",
  "outputUsage",
];
const OUTPUT_TOKEN_PATHS = [
  ["usage", "output"],
  ["usage", "completionTokens"],
  ["usageDetails", "output"],
];
const TOTAL_TOKEN_KEYS = ["totalTokens", "total_tokens", "totalUsage"];
const TOTAL_TOKEN_PATHS = [
  ["usage", "total"],
  ["usage", "totalTokens"],
];

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function valueAtPath(record: JsonRecord, keys: string[]): unknown {
  let current: unknown = record;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

/**
 * Langfuse exposes the same figure under several aliases (`usage.input`,
 * `usage.promptTokens`, `usageDetails.input`, ...). The first populated alias wins;
 * summing them would multiply the real value.
 */
function firstNumber(record: JsonRecord, keys: string[], paths: string[][]): number | undefined {
  for (const key of keys) {
    const value = asNumber(record[key]);
    if (value !== undefined) return value;
  }
  for (const path of paths) {
    const value = asNumber(valueAtPath(record, path));
    if (value !== undefined) return value;
  }
  return undefined;
}

function recordCost(record: JsonRecord): number | undefined {
  return firstNumber(record, COST_KEYS, COST_PATHS);
}

function recordInputTokens(record: JsonRecord): number | undefined {
  return firstNumber(record, INPUT_TOKEN_KEYS, INPUT_TOKEN_PATHS);
}

function recordOutputTokens(record: JsonRecord): number | undefined {
  return firstNumber(record, OUTPUT_TOKEN_KEYS, OUTPUT_TOKEN_PATHS);
}

function recordTotalTokens(record: JsonRecord): number | undefined {
  return firstNumber(record, TOTAL_TOKEN_KEYS, TOTAL_TOKEN_PATHS);
}

function sumRecords(
  records: JsonRecord[],
  pick: (record: JsonRecord) => number | undefined,
): number | undefined {
  let total: number | undefined;
  for (const record of records) {
    const value = pick(record);
    if (value !== undefined) total = (total ?? 0) + value;
  }
  return total;
}

/** Cost sums accumulate binary float noise; six decimals is well below one cent. */
function roundCost(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return Math.round(value * 1e6) / 1e6;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

export function langfuseConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LangfuseConfig | undefined {
  return resolveLangfuseConfig({ env });
}

/**
 * Resolves the lookup client from `pupil.config.yaml` settings first, then the
 * environment. `enabled: false` disables enrichment outright; `auto` (the default)
 * enables it only when a host and both keys are available.
 */
export function resolveLangfuseConfig(
  options: { settings?: LangfuseSettings; env?: NodeJS.ProcessEnv } = {},
): LangfuseConfig | undefined {
  const settings = options.settings ?? {};
  if (settings.enabled === false) return undefined;

  const env = options.env ?? process.env;
  const baseUrl = firstString(settings.host, env.LANGFUSE_HOST, env.LANGFUSE_BASE_URL);
  const publicKey = firstString(settings.publicKey, env.LANGFUSE_PUBLIC_KEY);
  const secretKey = firstString(settings.secretKey, env.LANGFUSE_SECRET_KEY);
  if (!baseUrl || !publicKey || !secretKey) return undefined;

  const waitMs = settings.waitMs ?? asNumber(env.LANGFUSE_WAIT_MS);
  const timeoutMs = settings.timeoutMs ?? asNumber(env.LANGFUSE_TIMEOUT_MS);
  const initialDelayMs = settings.initialDelayMs ?? asNumber(env.LANGFUSE_INITIAL_DELAY_MS);
  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    publicKey,
    secretKey,
    ...(waitMs !== undefined && { waitMs }),
    ...(timeoutMs !== undefined && { timeoutMs }),
    ...(initialDelayMs !== undefined && { initialDelayMs }),
  };
}

function tracesFromSession(payload: unknown): JsonRecord[] {
  if (!isRecord(payload)) return [];
  if (Array.isArray(payload.traces)) return payload.traces.filter(isRecord);
  if (Array.isArray(payload.data)) return payload.data.filter(isRecord);
  if (isRecord(payload.trace)) return [payload.trace];
  if (firstString(payload.id, payload.traceId, payload.trace_id)) return [payload];
  return [];
}

function tracesFromV2Observations(payload: unknown, baseUrl?: string): JsonRecord[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return [];
  const observations = payload.data.filter(isRecord);
  if (observations.length === 0) return [];

  const grouped = new Map<string, JsonRecord[]>();
  for (const observation of observations) {
    const traceId = firstString(observation.traceId, observation.trace_id);
    if (!traceId) continue;
    grouped.set(traceId, [...(grouped.get(traceId) ?? []), observation]);
  }

  return [...grouped].map(([traceId, groupedObservations]) => ({
    id: traceId,
    traceId,
    ...(baseUrl && { url: `${normalizeBaseUrl(baseUrl)}/trace/${traceId}` }),
    observations: groupedObservations,
  }));
}

function traceIdsFromPayload(payload: unknown): string[] {
  const ids = new Set<string>();
  for (const trace of tracesFromSession(payload)) {
    const traceId = firstString(trace.id, trace.traceId, trace.trace_id);
    if (traceId) ids.add(traceId);
  }
  return [...ids];
}

function observationsFromTrace(trace: JsonRecord, payload: unknown): JsonRecord[] {
  const payloadObservations = isRecord(payload) ? payload.observations : undefined;
  const candidates = [
    trace.observations,
    trace.generations,
    trace.spans,
    // A single-trace payload where the trace object IS the payload (e.g. a bare
    // `{ id, observations }` shape) would otherwise flatten the same array in twice.
    payloadObservations === trace.observations ? undefined : payloadObservations,
  ];
  return candidates.flatMap((candidate) =>
    Array.isArray(candidate) ? candidate.filter(isRecord) : [],
  );
}

/**
 * Trace-level figures already aggregate their observations in Langfuse, so a trace
 * value is used as-is and observations are only summed when the trace omits it.
 */
function aggregate(
  traces: { trace: JsonRecord; observations: JsonRecord[] }[],
  pick: (record: JsonRecord) => number | undefined,
): number | undefined {
  let total: number | undefined;
  for (const { trace, observations } of traces) {
    const value = pick(trace) ?? sumRecords(observations, pick);
    if (value !== undefined) total = (total ?? 0) + value;
  }
  return total;
}

/** Langfuse sends tool arguments either as an object or as a JSON string. */
function parseArgs(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // A non-JSON string is still the best argument evidence we have.
    return value;
  }
}

function observationError(record: JsonRecord): string | undefined {
  const level = firstString(record.level, record.statusLevel)?.toUpperCase();
  if (level !== "ERROR") return undefined;
  return firstString(record.statusMessage, record.status_message, record.error) ?? "tool error";
}

type CollectedToolCall = Omit<ToolCall, "index">;

/**
 * Collects tool calls in call order.
 *
 * Order comes from `startTime` when every collected call has one; otherwise
 * payload order is preserved. Sorting only when all entries are timed avoids an
 * inconsistent comparator, which would give undefined results for mixed input.
 * Duplicates are deliberately kept — `tool_call_count` and `tool_order` depend
 * on them.
 */
function extractToolCalls(records: JsonRecord[]): ToolCall[] {
  const collected: CollectedToolCall[] = [];

  for (const record of records) {
    const type = firstString(record.type, record.observationType, record.kind)?.toLowerCase() ?? "";
    // Also check the OTel attribute Langfuse echoes back in metadata.attributes —
    // this is the reliable path for iris-core's OTel-ingested tool observations,
    // which may land as type SPAN in Langfuse's internal model but always carry
    // the original 'tool' value in the raw OTel attribute.
    const otelType = isRecord(record.metadata) && isRecord(record.metadata["attributes"])
      ? firstString(record.metadata["attributes"]["langfuse.observation.type"])?.toLowerCase()
      : undefined;
    const name = firstString(record.name, record.toolName, record.tool_name);
    if ((type.includes("tool") || otelType === "tool") && name) {
      collected.push({
        name,
        args: parseArgs(record.input ?? record.args ?? record.arguments),
        startedAt: firstString(record.startTime, record.start_time),
        error: observationError(record),
      });
    }

    for (const key of ["toolCalls", "tool_calls"] as const) {
      const calls = record[key];
      if (!Array.isArray(calls)) continue;
      for (const call of calls) {
        if (!isRecord(call)) continue;
        const fn = isRecord(call.function) ? call.function : undefined;
        const callName = firstString(call.name, call.toolName, call.tool_name, fn?.name);
        if (!callName) continue;
        collected.push({
          name: callName,
          args: parseArgs(call.args ?? call.input ?? call.arguments ?? fn?.arguments),
          startedAt: firstString(call.startTime, call.start_time, record.startTime),
          error: undefined,
        });
      }
    }
  }

  const allTimed = collected.every((call) => call.startedAt !== undefined);
  if (allTimed) {
    collected.sort((a, b) => (a.startedAt as string).localeCompare(b.startedAt as string));
  }

  return collected.map((call, index) => ({
    name: call.name,
    index,
    ...(call.args !== undefined && { args: call.args }),
    ...(call.startedAt !== undefined && { startedAt: call.startedAt }),
    ...(call.error !== undefined && { error: call.error }),
  }));
}

export function extractLangfuseEnrichment(
  payload: unknown,
  options: { baseUrl?: string } = {},
): LangfuseEnrichment | undefined {
  const traces = tracesFromV2Observations(payload, options.baseUrl);
  if (traces.length === 0) traces.push(...tracesFromSession(payload));
  if (traces.length === 0) return undefined;

  // Top-level observations belong to a single-trace payload; attributing them to every
  // trace of a multi-trace session would count them repeatedly.
  const grouped = traces.map((trace) => ({
    trace,
    observations: observationsFromTrace(trace, traces.length === 1 ? payload : undefined),
  }));

  const inputTokens = aggregate(grouped, recordInputTokens);
  const outputTokens = aggregate(grouped, recordOutputTokens);
  const totalTokens =
    aggregate(grouped, recordTotalTokens) ??
    (inputTokens !== undefined || outputTokens !== undefined
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined);
  const costUsd = roundCost(aggregate(grouped, recordCost));
  const toolCalls = extractToolCalls(
    grouped.flatMap(({ trace, observations }) => [trace, ...observations]),
  );
  const first = grouped[0]?.trace ?? {};

  return {
    traceId: firstString(first.id, first.traceId, first.trace_id),
    traceUrl: firstString(first.url, first.traceUrl, first.trace_url, first.htmlUrl),
    traceCount: traces.length,
    costUsd,
    inputTokens,
    outputTokens,
    totalTokens,
    toolCalls,
  };
}

function traceDetailUrl(config: LangfuseConfig, traceId: string): URL {
  return new URL(
    `${normalizeBaseUrl(config.baseUrl)}/api/public/traces/${encodeURIComponent(traceId)}`,
  );
}

function tracesUrlForSession(config: LangfuseConfig, sessionId: string): URL {
  const url = new URL(`${normalizeBaseUrl(config.baseUrl)}/api/public/traces`);
  url.searchParams.set("sessionId", sessionId);
  url.searchParams.set("limit", "100");
  return url;
}

async function fetchLangfuse(
  url: URL,
  auth: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      headers: { authorization: `Basic ${auth}` },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchSession(
  config: LangfuseConfig,
  sessionId: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<LangfuseEnrichment | undefined> {
  const auth = Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64");
  const tracesResponse = await fetchLangfuse(
    tracesUrlForSession(config, sessionId),
    auth,
    fetchImpl,
    timeoutMs,
  );
  if (tracesResponse.ok) {
    const tracesPayload = await tracesResponse.json();
    const traceIds = traceIdsFromPayload(tracesPayload);
    if (traceIds.length > 0) {
      const traceResponses = await Promise.all(
        traceIds.map((traceId) =>
          fetchLangfuse(traceDetailUrl(config, traceId), auth, fetchImpl, timeoutMs),
        ),
      );
      const traces: JsonRecord[] = [];
      for (let i = 0; i < traceIds.length; i++) {
        const traceId = traceIds[i];
        const traceResponse = traceResponses[i];
        if (!traceResponse.ok) {
          // A trace listed by the session query can 404 briefly before it is
          // readable; treat that as "not ready yet" so the caller retries the
          // whole session lookup, matching the traces-list not-found handling below.
          if (traceResponse.status === 404) return undefined;
          throw new Error(`Langfuse lookup failed with status ${traceResponse.status}`);
        }
        const trace = await traceResponse.json();
        if (isRecord(trace)) {
          traces.push({ url: `${normalizeBaseUrl(config.baseUrl)}/trace/${traceId}`, ...trace });
        }
      }
      return (
        extractLangfuseEnrichment({ traces }, { baseUrl: config.baseUrl }) ??
        extractLangfuseEnrichment(tracesPayload, { baseUrl: config.baseUrl })
      );
    }
  } else if (tracesResponse.status !== 404) {
    throw new Error(`Langfuse lookup failed with status ${tracesResponse.status}`);
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls until a trace shows up, because Langfuse ingests traces asynchronously. */
async function lookupSession(
  config: LangfuseConfig,
  sessionId: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  waitMs: number,
  initialDelayMs: number,
  initialBackoffMs: number,
  startedAt?: number,
): Promise<LangfuseEnrichment | undefined> {
  const deadline = Date.now() + Math.max(waitMs, 0);
  let backoffMs = Math.max(initialBackoffMs, 0);
  let attempts = 0;

  for (;;) {
    attempts += 1;
    const enrichment = await fetchSession(config, sessionId, fetchImpl, timeoutMs);
    if (enrichment) return enrichment;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return undefined;

    let sleepMs = backoffMs;
    if (attempts === 1 && startedAt !== undefined) {
      sleepMs = Math.max(startedAt + Math.max(initialDelayMs, 0) - Date.now(), 0);
    } else {
      backoffMs = Math.min(backoffMs * 2, DEFAULT_LANGFUSE_MAX_BACKOFF_MS);
    }
    await sleep(Math.min(sleepMs, remaining));
  }
}

/**
 * Reads Langfuse trace evidence for a scenario's session id.
 *
 * Enrichment semantics (best-effort, never verdict-changing) live in the runner and
 * `applyTraceEnrichment`; this class only resolves evidence or reports it cannot.
 */
export class LangfuseTraceSource implements TraceSource {
  readonly metadataKey = "langfuse";

  constructor(
    private readonly config: LangfuseConfig,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly options: LangfuseTraceSourceOptions = {},
  ) {}

  static fromSettings(
    settings?: LangfuseSettings,
    env?: NodeJS.ProcessEnv,
  ): LangfuseTraceSource | undefined {
    const config = resolveLangfuseConfig({ settings, env });
    if (!config) return undefined;
    return new LangfuseTraceSource(config, globalThis.fetch, {
      waitMs: config.waitMs,
      timeoutMs: config.timeoutMs,
      initialDelayMs: config.initialDelayMs,
    });
  }

  /**
   * `context.startedAt` is what makes `initialDelayMs` meaningful: the wait before the
   * second poll is measured from when the scenario started, so a scenario that already
   * ran longer than the ingestion delay polls again immediately instead of waiting twice.
   */
  async resolve(sessionId: string, context?: TraceLookupContext): Promise<TraceRecord | undefined> {
    const enrichment = await lookupSession(
      this.config,
      sessionId,
      this.fetchImpl,
      this.options.timeoutMs ?? DEFAULT_LANGFUSE_TIMEOUT_MS,
      this.options.waitMs ?? DEFAULT_LANGFUSE_WAIT_MS,
      this.options.initialDelayMs ?? DEFAULT_LANGFUSE_INITIAL_DELAY_MS,
      this.options.initialBackoffMs ?? DEFAULT_LANGFUSE_INITIAL_BACKOFF_MS,
      context?.startedAt,
    );
    if (!enrichment) return undefined;
    return {
      traceId: enrichment.traceId,
      traceUrl: enrichment.traceUrl,
      traceCount: enrichment.traceCount,
      costUsd: enrichment.costUsd,
      inputTokens: enrichment.inputTokens,
      outputTokens: enrichment.outputTokens,
      totalTokens: enrichment.totalTokens,
      toolCalls: enrichment.toolCalls,
    };
  }
}
