#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { loadPupilConfig, type PupilConfig } from "../core/config.js";
import {
  aggregateVerdicts,
  PupilError,
  type Scenario,
  type TargetIdentity,
  Verdict,
} from "../core/types.js";
import {
  compareRuns,
  formatRunComparison,
  JsonRunHistoryStore,
  resolveCompareOptions,
  type RunComparison,
} from "../history/index.js";
import { finishRun } from "./finishRun.js";
import { loadInvariantFile } from "../invariants/index.js";
import { LangfuseTraceSource, LangfuseTracePopulationSource } from "../langfuse/index.js";
import { createIrisMockAgent } from "../mock/irisMockAgent.js";
import { buildObserveResult, resolvePopulationQuery } from "../observe/index.js";
import { runScenarios, type RunnerProgressEvent } from "../runner/index.js";
import {
  assertUniqueScenarioIds,
  loadScenarioFile,
  loadScenarios,
  sortScenarios,
} from "../scenario/index.js";

export const program = new Command();
program.enablePositionalOptions();
const packageManifest = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf-8"),
) as { version: string };

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new InvalidArgumentError("port must be an integer between 0 and 65535");
  }
  return port;
}

function parseNonNegativeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError(`${name} must be a non-negative integer`);
  }
  return parsed;
}
function parseNonNegativeNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new InvalidArgumentError(`${name} must be a non-negative number`);
  }
  return parsed;
}

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseManualVerdict(value: string): Verdict.Pass | Verdict.Fail {
  if (value === Verdict.Pass || value === Verdict.Fail) return value;
  throw new InvalidArgumentError("manual score must be pass or fail");
}

function definedConfig(options: {
  baseUrl?: string;
  bearerToken?: string;
  originThreadTs?: string;
  timeoutMs?: number;
}): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries({
      baseUrl: options.baseUrl,
      bearerToken: options.bearerToken,
      originThreadTs: options.originThreadTs,
      timeoutMs: options.timeoutMs,
    }).filter(([, value]) => value !== undefined),
  );
}

const DEFAULT_HISTORY_DIR = ".pupil";

interface ConfigOptions {
  config?: string;
  profile?: string;
}

function configLoadOptions(options: ConfigOptions): { configPath?: string; profile?: string } {
  return {
    ...(options.config !== undefined && { configPath: options.config }),
    ...(options.profile !== undefined && { profile: options.profile }),
  };
}

/**
 * History dir for the read-only commands. `--history-dir` wins; otherwise the
 * config file decides.
 *
 * These commands only need a directory name, so a config file that cannot be
 * loaded (an unset `${VAR}`, say) must not stop someone from reading run
 * history — unless they named the config or profile themselves, in which case
 * the failure is about their own request and is reported.
 */
async function resolveHistoryDir(
  options: ConfigOptions & { historyDir?: string },
): Promise<string> {
  if (options.historyDir) return options.historyDir;
  try {
    const config = await loadPupilConfig(configLoadOptions(options));
    return config.history.dir;
  } catch (error) {
    if (options.config !== undefined || options.profile !== undefined) throw error;
    console.error(
      `WARNING: ignoring unreadable Pupil config, falling back to --history-dir ${DEFAULT_HISTORY_DIR}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return DEFAULT_HISTORY_DIR;
  }
}

/**
 * Applies the config file's driver defaults that are *not* part of
 * `projectDriverConfig` (which the runner layers under each scenario's own
 * `driver.config`). Only `preset` needs handling here: a scenario that names no
 * preset would otherwise fall through to the raw REST driver and fail on the
 * missing request templates, even though the project declared `iris-http`.
 * `driver.type` is left alone — scenario loading already defaults it to `rest`,
 * the only type the runner supports, so there is no "unset" to fill in.
 */
function applyProjectDriverDefaults(scenarios: Scenario[], config: PupilConfig): Scenario[] {
  const preset = config.driver.preset;
  if (preset === undefined) return scenarios;
  return scenarios.map((scenario) =>
    scenario.driver.preset === undefined
      ? { ...scenario, driver: { ...scenario.driver, preset } }
      : scenario,
  );
}

async function loadConfiguredScenarios(
  path: string | undefined,
  config: PupilConfig,
): Promise<Scenario[]> {
  const paths = path
    ? [path]
    : Array.isArray(config.scenarios)
      ? config.scenarios
      : [config.scenarios];
  const groups = await Promise.all(paths.map((scenarioPath) => loadScenarios(scenarioPath)));
  const scenarios = groups.flat();
  assertUniqueScenarioIds(scenarios);
  return applyProjectDriverDefaults(sortScenarios(scenarios), config);
}

function formatProgressLine(event: RunnerProgressEvent): string {
  if (event.type === "scenario:start") return `START ${event.scenarioId}`;
  if (event.type === "scenario:retry") {
    return `RETRY ${event.scenarioId} attempt ${event.attempt}/${event.maxAttempts}`;
  }
  if (event.type === "scenario:pass") return `PASS ${event.scenarioId}`;
  if (event.type === "scenario:skip") return `SKIP ${event.scenarioId}`;
  if (event.type === "scenario:needs_review") return `REVIEW ${event.scenarioId}`;
  if (event.type === "scenario:fail") return `FAIL ${event.scenarioId}`;
  return `ERROR ${event.scenarioId}${event.message ? `: ${event.message}` : ""}`;
}

function logProgress(event: RunnerProgressEvent): void {
  console.log(formatProgressLine(event));
}

/** Used under `--json` so stdout stays a single parseable JSON payload. */
function logProgressToStderr(event: RunnerProgressEvent): void {
  console.error(formatProgressLine(event));
}

function formatSummary(summary: {
  total: number;
  passed: number;
  failed: number;
  needsReview: number;
  errors: number;
}): string {
  return `${summary.passed}/${summary.total} passed, ${summary.failed} failed, ${summary.needsReview} needs_review, ${summary.errors} errors`;
}

function summarizeResults(results: { verdict: Verdict }[]): {
  total: number;
  passed: number;
  failed: number;
  needsReview: number;
  errors: number;
} {
  return {
    total: results.length,
    passed: results.filter((result) => result.verdict === Verdict.Pass).length,
    failed: results.filter((result) => result.verdict === Verdict.Fail).length,
    needsReview: results.filter((result) => result.verdict === Verdict.NeedsReview).length,
    errors: results.filter((result) => result.verdict === Verdict.Error).length,
  };
}

program
  .name("pupil")
  .description("Continuous quality engineering for AI agents.")
  .version(packageManifest.version);

program
  .command("validate")
  .description("Validate one YAML scenario file.")
  .argument("<file>", "Scenario YAML file")
  .action(async (file: string) => {
    const scenario = await loadScenarioFile(file);
    console.log(`Valid scenario: ${scenario.id}`);
  });

program
  .command("discover")
  .description("Recursively discover and validate YAML scenarios.")
  .argument("<path>", "Scenario file or directory")
  .action(async (path: string) => {
    const scenarios = await loadScenarios(path);
    console.log(`Discovered ${scenarios.length} scenario${scenarios.length === 1 ? "" : "s"}.`);
    for (const scenario of scenarios) {
      console.log(`- ${scenario.id} (${scenario.sourceFile ?? "<unknown>"})`);
    }
  });

program
  .command("run")
  .description("Run one scenario file or a directory of scenarios.")
  .argument("[path]", "Scenario YAML file or directory; defaults to config.scenarios")
  .option("--config <path>", "Path to a Pupil config file (default: pupil.config.yaml)")
  .option("--profile <name>", "Environment profile from pupil.config.yaml")
  .option("--base-url <url>", "Override driver.config.baseUrl")
  .option("--bearer-token <token>", "Override bearer auth token")
  .option("--origin-thread-ts <value>", "Override IRIS originThreadTs")
  .option("--timeout-ms <timeoutMs>", "Per-scenario timeout in milliseconds", (value) =>
    parsePositiveInteger(value, "timeout-ms"),
  )
  .option(
    "--retries <retries>",
    "Retries for transport and timeout errors only",
    (value) => parseNonNegativeInteger(value, "retries"),
    0,
  )
  .option(
    "--concurrency <concurrency>",
    "Number of scenarios to run concurrently",
    (value) => parsePositiveInteger(value, "concurrency"),
    1,
  )
  .option("--history-dir <dir>", "Directory for JSON run history")
  .option("--no-langfuse", "Skip Langfuse trace enrichment for this run")
  .option(
    "--require-trace",
    "Fail (instead of skip) tool assertions when no trace evidence is available",
    false,
  )
  .option("--system <name>", "Agent system name (e.g. support-agent)")
  .option("--environment <env>", "Deployment environment (e.g. staging, pr-123)")
  .option("--target-version <version>", "Deployed version or commit SHA")
  .option("--fixture-set <name>", "Active fixture/stub set name")
  .option(
    "--baseline",
    "Auto-compare against the stored baseline run and exit 1 on regression",
    false,
  )
  .option("--strict", "Also fail (exit 1) when the run verdict is needs_review", false)
  .option("--json", "Print machine-readable JSON run output instead of human-readable lines", false)
  .option("--junit <path>", "Write a JUnit XML report to this path")
  .option(
    "--latency-threshold-ms <latencyThresholdMs>",
    "Allowed latency increase in milliseconds before flagging a regression",
    (value) => parseNonNegativeNumber(value, "latency-threshold-ms"),
  )
  .option(
    "--latency-threshold-pct <latencyThresholdPct>",
    "Allowed latency increase as a percent before flagging a regression (default: 20)",
    (value) => parseNonNegativeNumber(value, "latency-threshold-pct"),
  )
  .action(
    async (
      path: string | undefined,
      options: {
        config?: string;
        profile?: string;
        baseUrl?: string;
        bearerToken?: string;
        originThreadTs?: string;
        timeoutMs?: number;
        retries: number;
        concurrency: number;
        historyDir?: string;
        langfuse: boolean;
        requireTrace?: boolean;
        system?: string;
        environment?: string;
        targetVersion?: string;
        fixtureSet?: string;
        baseline: boolean;
        strict: boolean;
        json: boolean;
        junit?: string;
        latencyThresholdMs?: number;
        latencyThresholdPct?: number;
      },
    ) => {
      const config = await loadPupilConfig(configLoadOptions(options));
      const invariants = config.invariants?.file
        ? await loadInvariantFile(config.invariants.file)
        : [];
      const scenarios = await loadConfiguredScenarios(path, config);
      const mergedTarget: TargetIdentity = {
        ...config.target,
        mode: "driven",
        ...(options.system ? { system: options.system } : {}),
        ...(options.environment ? { environment: options.environment } : {}),
        ...(options.targetVersion ? { version: options.targetVersion } : {}),
        ...(options.fixtureSet ? { fixtureSet: options.fixtureSet } : {}),
      };
      const result = await runScenarios(scenarios, {
        timeoutMs: options.timeoutMs,
        retries: options.retries,
        concurrency: options.concurrency,
        projectDriverConfig: config.driver.config,
        driverConfig: definedConfig(options),
        progress: options.json ? logProgressToStderr : logProgress,
        // `?? false` matters: the CLI has already consulted config *and* env, so an
        // unresolved source means enrichment is off. Passing undefined would instead
        // let the runner re-resolve from env and override `langfuse.enabled: false`.
        traceSource:
          options.langfuse === false
            ? false
            : (LangfuseTraceSource.fromSettings(config.langfuse) ?? false),
        target: mergedTarget,
        requireTrace: Boolean(options.requireTrace) || config.requireTrace,
        invariants,
        defaultMaxViolationRate: config.invariants?.defaultMaxViolationRate,
      });

      await finishRun(result, {
        historyDir: options.historyDir ?? config.history.dir,
        baseline: options.baseline,
        strict: options.strict,
        json: options.json,
        junit: options.junit,
        latencyThresholdMs: options.latencyThresholdMs,
        latencyThresholdPct: options.latencyThresholdPct,
        compareConfig: config.compare,
        summaryLine: (result) =>
          `Run ${result.runId}: ${result.verdict} (${result.summary.passed}/${result.summary.total} passed, ${result.summary.errors} errors)`,
        skipNoun: "tool assertion",
      });
    },
  );

program
  .command("observe")
  .description("Evaluate repo-level invariants against a population of production traces.")
  .argument("<population>", "Named population from config.observe.populations")
  .option("--config <path>", "Path to a Pupil config file (default: pupil.config.yaml)")
  .option("--profile <name>", "Environment profile from pupil.config.yaml")
  .option("--history-dir <dir>", "Directory for JSON run history")
  .option("--since <since>", "Population time window start (relative, e.g. 24h, or ISO)")
  .option("--until <until>", "Population time window end (relative or ISO; default now)")
  .option("--name <name>", "Override the population's Langfuse trace name filter")
  .option(
    "--tag <tag>",
    "Add a tag filter (repeatable)",
    (value: string, previous: string[]) => [...previous, value],
    [] as string[],
  )
  .option("--user-id <userId>", "Override the population's userId filter")
  .option("--limit <limit>", "Max observation rows to fetch", (value) =>
    parsePositiveInteger(value, "limit"),
  )
  .option(
    "--require-trace",
    "Fail (instead of skip) invariants when no trace evidence is available",
    false,
  )
  .option("--system <name>", "Agent system name (e.g. support-agent)")
  .option("--environment <env>", "Deployment environment (e.g. staging, pr-123)")
  .option("--target-version <version>", "Deployed version or commit SHA")
  .option("--fixture-set <name>", "Active fixture/stub set name")
  .option(
    "--baseline",
    "Auto-compare against the stored baseline run and exit 1 on regression",
    false,
  )
  .option("--strict", "Also fail (exit 1) when the run verdict is needs_review", false)
  .option("--json", "Print machine-readable JSON output instead of human-readable lines", false)
  .option("--junit <path>", "Write a JUnit XML report to this path")
  .option(
    "--latency-threshold-ms <latencyThresholdMs>",
    "Allowed latency increase in milliseconds before flagging a regression",
    (value) => parseNonNegativeNumber(value, "latency-threshold-ms"),
  )
  .option(
    "--latency-threshold-pct <latencyThresholdPct>",
    "Allowed latency increase as a percent before flagging a regression (default: 20)",
    (value) => parseNonNegativeNumber(value, "latency-threshold-pct"),
  )
  .action(
    async (
      population: string,
      options: {
        config?: string;
        profile?: string;
        historyDir?: string;
        since?: string;
        until?: string;
        name?: string;
        tag: string[];
        userId?: string;
        limit?: number;
        requireTrace?: boolean;
        system?: string;
        environment?: string;
        targetVersion?: string;
        fixtureSet?: string;
        baseline: boolean;
        strict: boolean;
        json: boolean;
        junit?: string;
        latencyThresholdMs?: number;
        latencyThresholdPct?: number;
      },
    ) => {
      const config = await loadPupilConfig(configLoadOptions(options));
      const invariants = config.invariants?.file
        ? await loadInvariantFile(config.invariants.file)
        : [];

      const query = resolvePopulationQuery(config.observe?.populations ?? {}, population, {
        ...(options.since !== undefined && { since: options.since }),
        ...(options.until !== undefined && { until: options.until }),
        ...(options.name !== undefined && { name: options.name }),
        ...(options.tag.length > 0 && { tags: options.tag }),
        ...(options.userId !== undefined && { userId: options.userId }),
        ...(options.limit !== undefined && { limit: options.limit }),
      });

      const populationSource = LangfuseTracePopulationSource.fromSettings(config.langfuse);
      if (!populationSource) {
        throw new PupilError(
          "pupil observe requires Langfuse to be configured (langfuse.host/publicKey/secretKey via pupil.config.yaml or environment)",
        );
      }
      const trajectories = await populationSource.fetch(query);

      const mergedTarget: TargetIdentity = {
        ...config.target,
        mode: "observed",
        ...(options.system ? { system: options.system } : {}),
        ...(options.environment ? { environment: options.environment } : {}),
        ...(options.targetVersion ? { version: options.targetVersion } : {}),
        ...(options.fixtureSet ? { fixtureSet: options.fixtureSet } : {}),
      };

      const result = buildObserveResult({
        populationName: population,
        query,
        trajectories,
        invariants,
        defaultMaxViolationRate: config.invariants?.defaultMaxViolationRate,
        requireTrace: Boolean(options.requireTrace) || config.requireTrace,
        target: mergedTarget,
      });

      await finishRun(result, {
        historyDir: options.historyDir ?? config.history.dir,
        baseline: options.baseline,
        strict: options.strict,
        json: options.json,
        junit: options.junit,
        latencyThresholdMs: options.latencyThresholdMs,
        latencyThresholdPct: options.latencyThresholdPct,
        compareConfig: config.compare,
        summaryLine: (result) => `Observed population "${population}": ${result.verdict}`,
        skipNoun: "invariant check",
      });
    },
  );

program
  .command("list")
  .description("List saved Pupil runs from JSON history.")
  .option("--config <path>", "Path to a Pupil config file (default: pupil.config.yaml)")
  .option("--profile <name>", "Environment profile from pupil.config.yaml")
  .option("--history-dir <dir>", "Directory for JSON run history")
  .action(async (options: { config?: string; profile?: string; historyDir?: string }) => {
    const store = new JsonRunHistoryStore({ dir: await resolveHistoryDir(options) });
    const entries = await store.listRuns();
    if (entries.length === 0) {
      console.log("No saved runs found.");
      return;
    }

    for (const entry of entries) {
      console.log(
        `${entry.runId} ${entry.verdict} ${entry.startedAt} scenarios=${entry.scenarioCount} (${formatSummary(entry.summary)})`,
      );
    }
  });

program
  .command("report")
  .description("Print a report for one saved Pupil run.")
  .argument("<runId>", "Run id to report")
  .option("--config <path>", "Path to a Pupil config file (default: pupil.config.yaml)")
  .option("--profile <name>", "Environment profile from pupil.config.yaml")
  .option("--history-dir <dir>", "Directory for JSON run history")
  .action(
    async (runId: string, options: { config?: string; profile?: string; historyDir?: string }) => {
      const run = await new JsonRunHistoryStore({
        dir: await resolveHistoryDir(options),
      }).readRun(runId);
      console.log(`Run ${run.runId}: ${run.verdict}`);
      console.log(`Started: ${run.startedAt}`);
      console.log(`Completed: ${run.completedAt}`);
      console.log(`Summary: ${formatSummary(run.summary)}`);
      if (run.target) {
        const parts = (
          [
            ["system", run.target.system],
            ["environment", run.target.environment],
            ["version", run.target.version],
            ["mode", run.target.mode],
            ["fixtureSet", run.target.fixtureSet],
          ] as [string, string | undefined][]
        )
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ");
        if (parts) {
          console.log(`Target: ${parts}`);
        }
      }

      for (const result of [...run.results].sort((a, b) =>
        a.scenarioId.localeCompare(b.scenarioId),
      )) {
        console.log(
          `- ${result.scenarioId}: ${result.verdict} (${result.metrics.turns ?? 0} turns, ${result.metrics.latency_ms ?? 0}ms)`,
        );
        for (const score of result.scores) {
          console.log(
            `  score ${score.name}: ${score.verdict}${score.reason ? ` - ${score.reason}` : ""}`,
          );
        }
      }
    },
  );

program
  .command("baseline")
  .description("Show or set the baseline run id.")
  .argument("[runId]", "Run id to set as baseline")
  .option("--config <path>", "Path to a Pupil config file (default: pupil.config.yaml)")
  .option("--profile <name>", "Environment profile from pupil.config.yaml")
  .option("--history-dir <dir>", "Directory for JSON run history")
  .action(
    async (
      runId: string | undefined,
      options: { config?: string; profile?: string; historyDir?: string },
    ) => {
      const store = new JsonRunHistoryStore({ dir: await resolveHistoryDir(options) });
      if (runId) {
        await store.readRun(runId);
        await store.setBaseline(runId);
        console.log(`Baseline set to ${runId}`);
        return;
      }

      const baselineRunId = await store.getBaselineRunId();
      if (!baselineRunId) {
        console.log("No baseline set.");
        process.exitCode = 1;
        return;
      }
      console.log(`Baseline: ${baselineRunId}`);
    },
  );

program
  .command("score")
  .description("Apply a manual score to a saved scenario result.")
  .argument("<runId>", "Run id to update")
  .argument("<scenario>", "Scenario id to score")
  .argument("<criterion>", "Manual criterion name")
  .argument("<verdict>", "Manual verdict: pass or fail", parseManualVerdict)
  .option("--config <path>", "Path to a Pupil config file (default: pupil.config.yaml)")
  .option("--profile <name>", "Environment profile from pupil.config.yaml")
  .option("--history-dir <dir>", "Directory for JSON run history")
  .option("--note <note>", "Reviewer note for the manual score")
  .action(
    async (
      runId: string,
      scenarioId: string,
      criterion: string,
      verdict: Verdict.Pass | Verdict.Fail,
      options: { config?: string; profile?: string; historyDir?: string; note?: string },
    ) => {
      const store = new JsonRunHistoryStore({ dir: await resolveHistoryDir(options) });
      const run = await store.readRun(runId);
      const scenario = run.results.find((result) => result.scenarioId === scenarioId);
      if (!scenario) {
        throw new PupilError(`Scenario ${scenarioId} was not found in run ${runId}`);
      }

      const scoreName = `manual:${criterion}`;
      const score = scenario.scores.find((candidate) => candidate.name === scoreName);
      if (!score) {
        throw new PupilError(
          `Manual criterion ${criterion} was not found for scenario ${scenarioId}`,
        );
      }

      score.verdict = verdict;
      score.reason = options.note
        ? `Manual score: ${verdict} - ${options.note}`
        : `Manual score: ${verdict}`;
      score.value = verdict;
      // Scores are parsed from stored JSON, so metadata may be absent in older
      // or hand-edited run files even though the type marks it as required.
      const existingMetadata = score.metadata ?? {};
      const existingManual =
        typeof existingMetadata.manual === "object" && existingMetadata.manual !== null
          ? existingMetadata.manual
          : {};
      score.metadata = {
        ...existingMetadata,
        manual: {
          ...existingManual,
          criterion,
          note: options.note,
          scoredAt: new Date().toISOString(),
        },
      };

      scenario.verdict = aggregateVerdicts(scenario.scores.map((current) => current.verdict));
      run.verdict = aggregateVerdicts(run.results.map((result) => result.verdict));
      run.summary = summarizeResults(run.results);
      await store.updateRun(run);

      console.log(
        `Updated ${runId}/${scenarioId}/${criterion}: ${verdict}. Scenario verdict: ${scenario.verdict}. Run verdict: ${run.verdict}`,
      );
    },
  );
program
  .command("compare")
  .description("Compare two stored Pupil runs for regressions.")
  .argument("<baseRunId>", "Baseline or previous run id")
  .argument("<currentRunId>", "Current run id")
  .option("--history-dir <dir>", "Directory for JSON run history")
  .option("--config <path>", "Path to a Pupil config file (default: pupil.config.yaml)")
  .option("--profile <name>", "Environment profile from pupil.config.yaml")
  .option(
    "--latency-threshold-ms <latencyThresholdMs>",
    "Allowed latency increase in milliseconds before flagging a regression",
    (value) => parseNonNegativeNumber(value, "latency-threshold-ms"),
  )
  .option(
    "--latency-threshold-pct <latencyThresholdPct>",
    "Allowed latency increase as a percent before flagging a regression (default: 20)",
    (value) => parseNonNegativeNumber(value, "latency-threshold-pct"),
  )
  .action(
    async (
      baseRunId: string,
      currentRunId: string,
      options: {
        historyDir?: string;
        config?: string;
        profile?: string;
        latencyThresholdMs?: number;
        latencyThresholdPct?: number;
      },
    ) => {
      // `compare` needs the config for its threshold block anyway, so it loads
      // once and takes the history dir from the same config rather than going
      // through resolveHistoryDir() a second time.
      const config = await loadPupilConfig(configLoadOptions(options));
      const store = new JsonRunHistoryStore({ dir: options.historyDir ?? config.history.dir });
      const [base, current] = await Promise.all([
        store.readRun(baseRunId),
        store.readRun(currentRunId),
      ]);
      const comparison = compareRuns(
        base,
        current,
        resolveCompareOptions(config.compare, {
          latencyThresholdMs: options.latencyThresholdMs,
          latencyThresholdPct: options.latencyThresholdPct,
        }),
      );

      process.stdout.write(formatRunComparison(comparison));
      const hasHardTargetMismatch = comparison.targetMismatch.some(
        (mismatch) => mismatch.severity === "hard",
      );
      if (hasHardTargetMismatch) {
        // A hard mismatch (e.g. stubbed vs. live) means the comparison isn't
        // meaningful, so it must never surface as exit code 1 (a real
        // regression) — use a distinct code so CI can tell "refused" apart
        // from "regressed".
        process.exitCode = 2;
      } else if (comparison.hasRegressions) {
        process.exitCode = 1;
      }
    },
  );
program
  .command("mock-agent")
  .description("Start an IRIS-compatible mock HTTP agent.")
  .option("-p, --port <port>", "Port to listen on", parsePort, 5050)
  .option("--host <host>", "Host to bind", "127.0.0.1")
  .option(
    "--delay-ms <delayMs>",
    "Default response delay in milliseconds",
    (value) => parseNonNegativeInteger(value, "delay-ms"),
    0,
  )
  .action(async (options: { port: number; host: string; delayMs: number }) => {
    const mock = createIrisMockAgent({
      port: options.port,
      host: options.host,
      defaultDelayMs: options.delayMs,
    });
    const address = await mock.listen();
    console.log(`IRIS mock agent listening on http://${address.host}:${address.port}`);
  });

program.exitOverride();

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      process.exit(error.exitCode);
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

// process.argv[1] keeps whatever path invoked this script (e.g. a symlinked
// global bin), while import.meta.url is Node's fully resolved real path.
// Comparing raw strings breaks for any symlinked/linked install; resolving
// both through the filesystem first makes the comparison symlink-proof while
// still skipping this when the module is merely imported (e.g. by tests).
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
