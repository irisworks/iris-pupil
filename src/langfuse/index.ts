import { Buffer } from "node:buffer";
import type { RunResult, ScenarioResult } from "../core/types.js";

export interface LangfuseEnrichment {
  readonly traceId?: string;
  readonly traceUrl?: string;
  readonly traceCount: number;
  readonly costUsd?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly toolCalls: string[];
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

export interface LangfuseEnrichmentOptions {
  config?: LangfuseConfig;
  settings?: LangfuseSettings;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** How long to keep polling for a trace; Langfuse ingestion is asynchronous. */
  waitMs?: number;
  /** Earliest point, measured from scenario start, when a second poll is expected to be useful. */
  initialDelayMs?: number;
  /** Scenario start timestamp in epoch milliseconds. Only used to discount `initialDelayMs`. */
  startedAt?: number;
  /** Initial backoff delay between trace lookup attempts. Primarily useful for tests. */
  pollIntervalMs?: number;
}

export type LangfuseStatus = "enriched" | "skipped" | "error";

type JsonRecord = Record<string, unknown>;

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

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
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

function sessionIdForScenario(result: ScenarioResult): string | undefined {
  const fromMetadata = isRecord(result.metadata) ? result.metadata.sessionId : undefined;
  if (typeof fromMetadata === "string" && fromMetadata.length > 0) return fromMetadata;

  for (const turn of result.turns) {
    const raw = turn.response?.raw;
    if (!isRecord(raw)) continue;
    const sessionId = firstString(raw.sessionId, raw.session_id, raw.id);
    if (sessionId) return sessionId;
  }
  return undefined;
}

function tracesFromSession(payload: unknown): JsonRecord[] {
  if (!isRecord(payload)) return [];
  if (Array.isArray(payload.traces)) return payload.traces.filter(isRecord);
  if (Array.isArray(payload.data)) return payload.data.filter(isRecord);
  if (isRecord(payload.trace)) return [payload.trace];
  if (firstString(payload.traceId, payload.trace_id)) return [payload];
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
  const candidates = [
    trace.observations,
    trace.generations,
    trace.spans,
    isRecord(payload) ? payload.observations : undefined,
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

function extractToolCalls(records: JsonRecord[]): string[] {
  const names = new Set<string>();
  for (const record of records) {
    const type = firstString(record.type, record.observationType, record.kind)?.toLowerCase() ?? "";
    const name = firstString(record.name, record.toolName, record.tool_name);
    if (type.includes("tool") && name) names.add(name);

    for (const key of ["toolCalls", "tool_calls"] as const) {
      const calls = record[key];
      if (!Array.isArray(calls)) continue;
      for (const call of calls) {
        if (!isRecord(call)) continue;
        const callName = firstString(
          call.name,
          call.toolName,
          call.tool_name,
          isRecord(call.function) ? call.function.name : undefined,
        );
        if (callName) names.add(callName);
      }
    }
  }
  return [...names].sort();
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
      const traces: JsonRecord[] = [];
      for (const traceId of traceIds) {
        const traceResponse = await fetchLangfuse(
          traceDetailUrl(config, traceId),
          auth,
          fetchImpl,
          timeoutMs,
        );
        if (!traceResponse.ok) return undefined;
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

function withLangfuseMetadata(result: ScenarioResult, langfuse: Record<string, unknown>): void {
  result.metadata = { ...(result.metadata ?? {}), langfuse };
}

function applyEnrichment(
  result: ScenarioResult,
  sessionId: string,
  enrichment: LangfuseEnrichment | undefined,
): LangfuseStatus {
  if (!enrichment) {
    withLangfuseMetadata(result, {
      status: "skipped",
      sessionId,
      reason: "No trace found for session",
    });
    return "skipped";
  }

  if (enrichment.costUsd !== undefined) result.metrics.cost_usd = enrichment.costUsd;
  if (enrichment.inputTokens !== undefined) result.metrics.input_tokens = enrichment.inputTokens;
  if (enrichment.outputTokens !== undefined) result.metrics.output_tokens = enrichment.outputTokens;
  if (enrichment.totalTokens !== undefined) result.metrics.total_tokens = enrichment.totalTokens;
  result.metrics.tool_calls = enrichment.toolCalls.length;

  withLangfuseMetadata(result, {
    status: "enriched",
    sessionId,
    traceId: enrichment.traceId,
    traceUrl: enrichment.traceUrl,
    ...(enrichment.traceCount > 1 && { traceCount: enrichment.traceCount }),
    toolCalls: enrichment.toolCalls,
  });
  return "enriched";
}

/**
 * Best-effort enrichment of a single scenario result. Mutates `metrics` and `metadata`
 * in place so callers can score thresholds against the enriched metrics. Returns
 * `undefined` when Langfuse is not configured, leaving the result untouched.
 */
export async function enrichScenarioWithLangfuse(
  result: ScenarioResult,
  options: LangfuseEnrichmentOptions = {},
): Promise<LangfuseStatus | undefined> {
  const config = options.config ?? resolveLangfuseConfig(options);
  if (!config) return undefined;

  const sessionId = sessionIdForScenario(result);
  if (!sessionId) {
    withLangfuseMetadata(result, { status: "skipped", reason: "No session id available" });
    return "skipped";
  }

  try {
    const enrichment = await lookupSession(
      config,
      sessionId,
      options.fetchImpl ?? fetch,
      options.timeoutMs ?? config.timeoutMs ?? DEFAULT_LANGFUSE_TIMEOUT_MS,
      options.waitMs ?? config.waitMs ?? DEFAULT_LANGFUSE_WAIT_MS,
      options.initialDelayMs ?? config.initialDelayMs ?? DEFAULT_LANGFUSE_INITIAL_DELAY_MS,
      options.pollIntervalMs ?? DEFAULT_LANGFUSE_INITIAL_BACKOFF_MS,
      options.startedAt,
    );
    return applyEnrichment(result, sessionId, enrichment);
  } catch (error) {
    withLangfuseMetadata(result, {
      status: "error",
      sessionId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return "error";
  }
}

/**
 * Rolls the per-scenario Langfuse statuses already present on `run.results` into a
 * run-level summary. Leaves `run.metadata` untouched when nothing was enriched.
 */
export function summarizeLangfuseRun(run: RunResult): RunResult {
  let enriched = 0;
  let skipped = 0;
  let failed = 0;

  for (const result of run.results) {
    const langfuse = isRecord(result.metadata) ? result.metadata.langfuse : undefined;
    const status = isRecord(langfuse) ? langfuse.status : undefined;
    if (status === "enriched") enriched += 1;
    else if (status === "skipped") skipped += 1;
    else if (status === "error") failed += 1;
  }

  if (enriched === 0 && skipped === 0 && failed === 0) return run;

  run.metadata = {
    ...run.metadata,
    langfuse: {
      status: failed > 0 ? "partial" : enriched > 0 ? "enriched" : "skipped",
      enriched,
      skipped,
      failed,
    },
  };
  return run;
}

/**
 * Enriches every scenario result of a completed run. The runner enriches scenarios as
 * they finish (so cost thresholds can be scored); this entry point covers callers that
 * hold a finished `RunResult`.
 */
export async function enrichRunWithLangfuse(
  run: RunResult,
  options: LangfuseEnrichmentOptions = {},
): Promise<RunResult> {
  const config = options.config ?? resolveLangfuseConfig(options);
  if (!config) return run;

  for (const result of run.results) {
    await enrichScenarioWithLangfuse(result, { ...options, config });
  }
  return summarizeLangfuseRun(run);
}
