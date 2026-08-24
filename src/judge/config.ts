import { firstString } from "../core/json.js";

export interface JudgeProviderConfig {
  baseUrl: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}

/**
 * Subset of `PupilConfig["judge"]` that resolution needs. Kept structural so this
 * module does not depend on config loading, matching `LangfuseSettings`.
 */
export interface JudgeProviderSettings {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

export function judgeConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): JudgeProviderConfig | undefined {
  return resolveJudgeConfig({ env });
}

/**
 * Resolves the judge provider config from `pupil.config.yaml` settings first, then
 * the environment. "Configured" is gated on `baseUrl` alone — an API key is not
 * required, since some OpenAI-compatible backends (Ollama, vLLM) need none. Never
 * throws for missing/partial config; the caller treats `undefined` as "unconfigured".
 */
export function resolveJudgeConfig(
  options: { settings?: JudgeProviderSettings; env?: NodeJS.ProcessEnv } = {},
): JudgeProviderConfig | undefined {
  const settings = options.settings ?? {};
  const env = options.env ?? process.env;

  const baseUrl = firstString(settings.baseUrl, env.JUDGE_BASE_URL);
  if (!baseUrl) return undefined;

  const apiKey = firstString(settings.apiKey, env.JUDGE_API_KEY, env.LITELLM_API_KEY);
  const model = firstString(settings.model, env.JUDGE_MODEL);
  const timeoutMs = settings.timeoutMs ?? asNumber(env.JUDGE_TIMEOUT_MS);

  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    ...(apiKey !== undefined && { apiKey }),
    ...(model !== undefined && { model }),
    ...(timeoutMs !== undefined && { timeoutMs }),
  };
}
