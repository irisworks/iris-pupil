import { Buffer } from "node:buffer";
import type { RunResult, ScenarioResult } from "../core/types.js";

export interface LangfuseEnrichment {
  readonly traceId?: string;
  readonly traceUrl?: string;
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
}

export interface LangfuseEnrichmentOptions {
  config?: LangfuseConfig;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface LangfuseLookupResult extends LangfuseEnrichment {
  raw: unknown;
}

type JsonRecord = Record<string, unknown>;

const DEFAULT_LANGFUSE_TIMEOUT_MS = 3000;

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

function sumNumbers(values: unknown[]): number | undefined {
  const numbers = values.map(asNumber).filter((value): value is number => value !== undefined);
  if (numbers.length === 0) return undefined;
  return numbers.reduce((total, value) => total + value, 0);
}

function valuesFromPath(source: unknown, keys: string[]): unknown[] {
  if (!isRecord(source)) return [];
  const values: unknown[] = [];
  let current: unknown = source;
  for (const key of keys) {
    if (!isRecord(current)) return values;
    current = current[key];
  }
  values.push(current);
  return values;
}

function numericCandidates(record: unknown, keys: string[]): unknown[] {
  if (!isRecord(record)) return [];
  return keys.map((key) => record[key]);
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

export function langfuseConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LangfuseConfig | undefined {
  const baseUrl = env.LANGFUSE_BASE_URL;
  const publicKey = env.LANGFUSE_PUBLIC_KEY;
  const secretKey = env.LANGFUSE_SECRET_KEY;
  if (!baseUrl || !publicKey || !secretKey) return undefined;
  return { baseUrl: normalizeBaseUrl(baseUrl), publicKey, secretKey };
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

function extractTokens(records: JsonRecord[]): {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
} {
  const inputTokens = sumNumbers(
    records.flatMap((record) => [
      ...numericCandidates(record, [
        "inputTokens",
        "promptTokens",
        "input_tokens",
        "prompt_tokens",
      ]),
      ...valuesFromPath(record, ["usage", "input"]),
      ...valuesFromPath(record, ["usage", "promptTokens"]),
      ...valuesFromPath(record, ["usageDetails", "input"]),
    ]),
  );
  const outputTokens = sumNumbers(
    records.flatMap((record) => [
      ...numericCandidates(record, [
        "outputTokens",
        "completionTokens",
        "output_tokens",
        "completion_tokens",
      ]),
      ...valuesFromPath(record, ["usage", "output"]),
      ...valuesFromPath(record, ["usage", "completionTokens"]),
      ...valuesFromPath(record, ["usageDetails", "output"]),
    ]),
  );
  const totalTokens =
    sumNumbers(
      records.flatMap((record) => [
        ...numericCandidates(record, ["totalTokens", "total_tokens"]),
        ...valuesFromPath(record, ["usage", "total"]),
        ...valuesFromPath(record, ["usage", "totalTokens"]),
      ]),
    ) ??
    (inputTokens !== undefined || outputTokens !== undefined
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined);
  return { inputTokens, outputTokens, totalTokens };
}

function extractCost(records: JsonRecord[]): number | undefined {
  return sumNumbers(
    records.flatMap((record) => [
      ...numericCandidates(record, [
        "totalCost",
        "cost",
        "costUsd",
        "calculatedTotalCost",
        "total_cost",
      ]),
      ...valuesFromPath(record, ["usage", "totalCost"]),
      ...valuesFromPath(record, ["usageDetails", "totalCost"]),
    ]),
  );
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

function extractTrace(payload: unknown): LangfuseLookupResult | undefined {
  const trace = tracesFromSession(payload)[0];
  if (!trace) return undefined;
  const observations = observationsFromTrace(trace, payload);
  const records = [trace, ...observations];
  const tokens = extractTokens(records);
  const costUsd = extractCost(records);
  const toolCalls = extractToolCalls(records);

  return {
    traceId: firstString(trace.id, trace.traceId, trace.trace_id),
    traceUrl: firstString(trace.url, trace.traceUrl, trace.trace_url, trace.htmlUrl),
    costUsd,
    ...tokens,
    toolCalls,
    raw: payload,
  };
}

async function fetchSession(
  config: LangfuseConfig,
  sessionId: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<LangfuseLookupResult | undefined> {
  const auth = Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(
      `${normalizeBaseUrl(config.baseUrl)}/api/public/sessions/${encodeURIComponent(sessionId)}`,
      { headers: { authorization: `Basic ${auth}` }, signal: controller.signal },
    );
    if (!response.ok) {
      throw new Error(`Langfuse lookup failed with status ${response.status}`);
    }
    return extractTrace(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}

function applyEnrichment(
  result: ScenarioResult,
  sessionId: string,
  enrichment: LangfuseLookupResult | undefined,
): void {
  const metadata = { ...(result.metadata ?? {}) };
  if (!enrichment) {
    result.metadata = {
      ...metadata,
      langfuse: { status: "skipped", sessionId, reason: "No trace found for session" },
    };
    return;
  }

  if (enrichment.costUsd !== undefined) result.metrics.cost_usd = enrichment.costUsd;
  if (enrichment.inputTokens !== undefined) result.metrics.input_tokens = enrichment.inputTokens;
  if (enrichment.outputTokens !== undefined) result.metrics.output_tokens = enrichment.outputTokens;
  if (enrichment.totalTokens !== undefined) result.metrics.total_tokens = enrichment.totalTokens;
  result.metrics.tool_calls = enrichment.toolCalls.length;

  result.metadata = {
    ...metadata,
    langfuse: {
      status: "enriched",
      sessionId,
      traceId: enrichment.traceId,
      traceUrl: enrichment.traceUrl,
      toolCalls: enrichment.toolCalls,
    },
  };
}

export async function enrichRunWithLangfuse(
  run: RunResult,
  options: LangfuseEnrichmentOptions = {},
): Promise<RunResult> {
  const config = options.config ?? langfuseConfigFromEnv(options.env);
  if (!config) return run;

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LANGFUSE_TIMEOUT_MS;
  let enriched = 0;
  let skipped = 0;
  let failed = 0;

  for (const result of run.results) {
    const sessionId = sessionIdForScenario(result);
    if (!sessionId) {
      skipped += 1;
      result.metadata = {
        ...(result.metadata ?? {}),
        langfuse: { status: "skipped", reason: "No session id available" },
      };
      continue;
    }

    try {
      const trace = await fetchSession(config, sessionId, fetchImpl, timeoutMs);
      applyEnrichment(result, sessionId, trace);
      if (trace) enriched += 1;
      else skipped += 1;
    } catch (error) {
      failed += 1;
      result.metadata = {
        ...(result.metadata ?? {}),
        langfuse: {
          status: "error",
          sessionId,
          reason: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

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
