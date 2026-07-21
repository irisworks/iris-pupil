import { randomUUID } from "node:crypto";
import {
  aggregateVerdicts,
  PupilError,
  type RunResult,
  type Scenario,
  type ScenarioResult,
  type TurnRecord,
  Verdict,
} from "../core/types.js";
import {
  createIrisHttpPreset,
  IRIS_HTTP_PRESET,
  RestDriver,
  RestDriverError,
  type RestConversation,
  type RestDriverConfig,
  type RestDriverConfigOverrides,
  type RestDriverResponse,
} from "../driver/index.js";

export interface RunnerDriver {
  createConversation(
    context?: Record<string, string | number | boolean | null | undefined>,
  ): Promise<RestConversation>;
  send(conversation: RestConversation, message: string): Promise<RestDriverResponse>;
  closeConversation(conversation: RestConversation): Promise<void>;
  dispose?(): void;
}

export interface RunnerProgressEvent {
  type: "scenario:start" | "scenario:retry" | "scenario:pass" | "scenario:error";
  scenarioId: string;
  attempt: number;
  maxAttempts: number;
  message?: string;
}

export interface RunScenarioOptions {
  runId?: string;
  timeoutMs?: number;
  retries?: number;
  driverConfig?: Record<string, unknown>;
  driverFactory?: (scenario: Scenario, context: RunnerDriverContext) => RunnerDriver;
  progress?: (event: RunnerProgressEvent) => void;
}

export interface RunScenariosOptions extends RunScenarioOptions {
  concurrency?: number;
  metadata?: Record<string, unknown>;
}

export interface RunnerDriverContext {
  runId: string;
  scenarioId: string;
  attempt: number;
  config: Record<string, unknown>;
}

class ScenarioAttemptError extends Error {
  constructor(
    readonly cause: unknown,
    readonly turns: TurnRecord[],
  ) {
    super(errorMessage(cause));
    this.name = "ScenarioAttemptError";
  }
}

const DEFAULT_SCENARIO_TIMEOUT_MS = 30_000;

function now(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringOption(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.length > 0) return value;
  throw new PupilError(`${name} must be a non-empty string`);
}

function numberOption(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new PupilError(`${name} must be a number`);
}

function mergedDriverConfig(
  scenario: Scenario,
  overrides: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return { ...scenario.driver.config, ...(overrides ?? {}) };
}

export function createDriverForScenario(
  scenario: Scenario,
  context: RunnerDriverContext,
): RunnerDriver {
  if (scenario.driver.type !== "rest") {
    throw new PupilError(`Unsupported driver type: ${scenario.driver.type}`);
  }

  if (scenario.driver.preset === IRIS_HTTP_PRESET) {
    const baseUrl = stringOption(context.config.baseUrl, "driver.config.baseUrl");
    if (!baseUrl) {
      throw new PupilError("iris-http scenarios require driver.config.baseUrl");
    }

    const directOverrides: RestDriverConfigOverrides = {};
    const timeoutMs = numberOption(context.config.timeoutMs, "driver.config.timeoutMs");
    const retries = numberOption(context.config.retries, "driver.config.retries");
    if (timeoutMs !== undefined) directOverrides.timeoutMs = timeoutMs;
    if (retries !== undefined) directOverrides.retries = retries;
    if (isRecord(context.config.headers))
      directOverrides.headers = context.config.headers as Record<string, string>;
    if (Array.isArray(context.config.retryStatusCodes)) {
      directOverrides.retryStatusCodes = context.config.retryStatusCodes as number[];
    }

    return new RestDriver(
      createIrisHttpPreset({
        baseUrl,
        bearerToken: stringOption(context.config.bearerToken, "driver.config.bearerToken"),
        originChannel: stringOption(context.config.originChannel, "driver.config.originChannel"),
        originThreadTs: stringOption(context.config.originThreadTs, "driver.config.originThreadTs"),
        overrides: {
          ...directOverrides,
          ...(isRecord(context.config.overrides) ? context.config.overrides : {}),
        },
      }),
    );
  }

  if (scenario.driver.preset !== undefined) {
    throw new PupilError(`Unsupported driver preset: ${scenario.driver.preset}`);
  }

  return new RestDriver(context.config as unknown as RestDriverConfig);
}

function isRetryableRunnerError(error: unknown): boolean {
  const actual = error instanceof ScenarioAttemptError ? error.cause : error;
  if (actual instanceof RestDriverError) {
    return actual.status === 408 || actual.status === 429 || actual.status >= 500;
  }
  if (actual instanceof PupilError && /timed out/i.test(actual.message)) {
    return true;
  }
  return actual instanceof TypeError;
}

function createErrorResult(
  scenario: Scenario,
  startedAt: string,
  turns: TurnRecord[],
  error: unknown,
  retries: number,
): ScenarioResult {
  const completedAt = now();
  return {
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    verdict: Verdict.Error,
    scores: [
      {
        name: "execution",
        verdict: Verdict.Error,
        reason: errorMessage(error),
        metadata: {},
      },
    ],
    turns,
    startedAt,
    completedAt,
    metrics: {
      turns: turns.length,
      latency_ms: Date.parse(completedAt) - Date.parse(startedAt),
      retries,
    },
    ...(scenario.sourceFile !== undefined && { sourceFile: scenario.sourceFile }),
  };
}

async function executeAttempt(
  scenario: Scenario,
  driver: RunnerDriver,
  context: RunnerDriverContext,
  timeoutMs: number,
): Promise<TurnRecord[]> {
  const turns: TurnRecord[] = [];
  let conversation: RestConversation | undefined;
  const timeout = setTimeout(() => driver.dispose?.(), timeoutMs);

  try {
    conversation = await driver.createConversation({
      runId: context.runId,
      scenarioId: scenario.id,
      attempt: context.attempt,
      originThreadTs:
        stringOption(context.config.originThreadTs, "driver.config.originThreadTs") ??
        `${context.runId}:${scenario.id}`,
    });

    for (const [index, turn] of scenario.turns.entries()) {
      const startedAt = now();
      const record: TurnRecord = {
        index,
        user: turn.user,
        startedAt,
        assertions: [],
      };
      turns.push(record);

      try {
        const response = await driver.send(conversation, turn.user);
        const completedAt = now();
        record.completedAt = completedAt;
        record.latencyMs = Date.parse(completedAt) - Date.parse(startedAt);
        record.response = { text: response.text, raw: response.raw };
      } catch (error) {
        record.error = errorMessage(error);
        record.completedAt = now();
        record.latencyMs = Date.parse(record.completedAt) - Date.parse(startedAt);
        throw new ScenarioAttemptError(error, turns);
      }
    }

    return turns;
  } catch (error) {
    if (error instanceof ScenarioAttemptError) throw error;
    throw new ScenarioAttemptError(error, turns);
  } finally {
    clearTimeout(timeout);
    if (conversation) {
      try {
        await driver.closeConversation(conversation);
      } catch {
        // Preserve the original scenario failure; close failures are cleanup-only here.
      }
    }
    driver.dispose?.();
  }
}

export async function runScenario(
  scenario: Scenario,
  options: RunScenarioOptions = {},
): Promise<ScenarioResult> {
  const runId = options.runId ?? randomUUID();
  const startedAt = now();
  const maxAttempts = (options.retries ?? 0) + 1;
  const timeoutMs =
    options.timeoutMs ??
    numberOption(scenario.driver.config.timeoutMs, "driver.config.timeoutMs") ??
    DEFAULT_SCENARIO_TIMEOUT_MS;
  let lastError: unknown;
  let lastTurns: TurnRecord[] = [];
  let attemptsUsed = 0;

  options.progress?.({ type: "scenario:start", scenarioId: scenario.id, attempt: 1, maxAttempts });

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attemptsUsed = attempt;
    const config = mergedDriverConfig(scenario, options.driverConfig);
    const context = { runId, scenarioId: scenario.id, attempt, config };
    const driver =
      options.driverFactory?.(scenario, context) ?? createDriverForScenario(scenario, context);

    try {
      const turns = await executeAttempt(scenario, driver, context, timeoutMs);
      const completedAt = now();
      const result: ScenarioResult = {
        scenarioId: scenario.id,
        scenarioName: scenario.name,
        verdict: Verdict.Pass,
        scores: [],
        turns,
        startedAt,
        completedAt,
        metrics: {
          turns: turns.length,
          latency_ms: Date.parse(completedAt) - Date.parse(startedAt),
          retries: attempt - 1,
        },
        ...(scenario.sourceFile !== undefined && { sourceFile: scenario.sourceFile }),
      };
      options.progress?.({ type: "scenario:pass", scenarioId: scenario.id, attempt, maxAttempts });
      return result;
    } catch (error) {
      lastError = error instanceof ScenarioAttemptError ? error.cause : error;
      lastTurns = error instanceof ScenarioAttemptError ? error.turns : [];
      if (attempt < maxAttempts && isRetryableRunnerError(error)) {
        options.progress?.({
          type: "scenario:retry",
          scenarioId: scenario.id,
          attempt: attempt + 1,
          maxAttempts,
          message: errorMessage(lastError),
        });
        continue;
      }
      break;
    }
  }

  const result = createErrorResult(scenario, startedAt, lastTurns, lastError, attemptsUsed - 1);
  options.progress?.({
    type: "scenario:error",
    scenarioId: scenario.id,
    attempt: attemptsUsed,
    maxAttempts,
    message: errorMessage(lastError),
  });
  return result;
}

function summarize(results: ScenarioResult[]): RunResult["summary"] {
  return {
    total: results.length,
    passed: results.filter((result) => result.verdict === Verdict.Pass).length,
    failed: results.filter((result) => result.verdict === Verdict.Fail).length,
    needsReview: results.filter((result) => result.verdict === Verdict.NeedsReview).length,
    errors: results.filter((result) => result.verdict === Verdict.Error).length,
  };
}

export async function runScenarios(
  scenarios: Scenario[],
  options: RunScenariosOptions = {},
): Promise<RunResult> {
  const runId = options.runId ?? randomUUID();
  const startedAt = now();
  const concurrency = options.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new PupilError("runner concurrency must be a positive integer");
  }

  const results = new Array<ScenarioResult>(scenarios.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < scenarios.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await runScenario(scenarios[index], { ...options, runId });
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, scenarios.length) }, () => worker()),
  );

  const completedAt = now();
  return {
    runId,
    verdict: aggregateVerdicts(results.map((result) => result.verdict)),
    results,
    startedAt,
    completedAt,
    summary: summarize(results),
    metadata: options.metadata ?? {},
  };
}
