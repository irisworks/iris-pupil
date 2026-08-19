#!/usr/bin/env node

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { loadPupilConfig } from "../core/config.js";
import { aggregateVerdicts, PupilError, Verdict } from "../core/types.js";
import {
  compareRuns,
  formatRunComparison,
  JsonRunHistoryStore,
  resolveCompareOptions,
  type RunComparison,
} from "../history/index.js";
import { LangfuseTraceSource } from "../langfuse/index.js";
import { createIrisMockAgent } from "../mock/irisMockAgent.js";
import { runScenarios, type RunnerProgressEvent } from "../runner/index.js";
import {
  buildRunJson,
  buildStepSummaryMarkdown,
  formatJUnitXml,
  isStrictFailure,
} from "./reporting.js";
import { loadScenarioFile, loadScenarios } from "../scenario/index.js";

const program = new Command();
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
  .argument("<path>", "Scenario YAML file or directory")
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
  .option("--history-dir <dir>", "Directory for JSON run history", ".pupil")
  .option("--no-langfuse", "Skip Langfuse trace enrichment for this run")
  .option(
    "--baseline",
    "Auto-compare against the stored baseline run and exit 1 on regression",
    false,
  )
  .option("--strict", "Also fail (exit 1) when the run verdict is needs_review", false)
  .option("--json", "Print machine-readable JSON run output instead of human-readable lines", false)
  .option("--junit <path>", "Write a JUnit XML report to this path")
  .option("--config <path>", "Path to a Pupil config file (default: pupil.config.yaml)")
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
      path: string,
      options: {
        baseUrl?: string;
        bearerToken?: string;
        originThreadTs?: string;
        timeoutMs?: number;
        retries: number;
        concurrency: number;
        historyDir: string;
        langfuse: boolean;
        baseline: boolean;
        strict: boolean;
        json: boolean;
        junit?: string;
        config?: string;
        latencyThresholdMs?: number;
        latencyThresholdPct?: number;
      },
    ) => {
      const scenarios = await loadScenarios(path);
      const config = await loadPupilConfig(
        options.config !== undefined ? { configPath: options.config } : {},
      );
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
      });

      const store = new JsonRunHistoryStore({ dir: options.historyDir });
      let stored;
      try {
        stored = await store.writeRun(result);
      } catch (error) {
        throw new PupilError(
          `Failed to save run history: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      let comparison: RunComparison | undefined;
      if (options.baseline) {
        const baselineRunId = await store.getBaselineRunId();
        if (!baselineRunId) {
          console.error(
            "WARNING: --baseline was requested but no baseline run is set, so no regression comparison ran. Set one with `pupil baseline <runId>`.",
          );
        } else {
          const baselineRun = await store.readRun(baselineRunId);
          comparison = compareRuns(
            baselineRun,
            result,
            resolveCompareOptions(config.compare, {
              latencyThresholdMs: options.latencyThresholdMs,
              latencyThresholdPct: options.latencyThresholdPct,
            }),
          );
        }
      }

      if (options.junit) {
        try {
          await mkdir(dirname(options.junit), { recursive: true });
          await writeFile(
            options.junit,
            formatJUnitXml(result, { strict: options.strict }),
            "utf-8",
          );
        } catch (error) {
          throw new PupilError(
            `Failed to write JUnit report to ${options.junit}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      const stepSummaryPath = process.env.GITHUB_STEP_SUMMARY;
      if (stepSummaryPath) {
        try {
          await appendFile(
            stepSummaryPath,
            buildStepSummaryMarkdown(result, { comparison }),
            "utf-8",
          );
        } catch (error) {
          console.error(
            `WARNING: failed to write the GitHub step summary to ${stepSummaryPath}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      if (options.json) {
        console.log(
          JSON.stringify(
            buildRunJson(result, {
              strict: options.strict,
              historyPath: stored.runPath,
              comparison,
              baselineRequested: options.baseline,
            }),
            null,
            2,
          ),
        );
      } else {
        console.log(`Saved run: ${stored.runPath}`);
        console.log(
          `Run ${result.runId}: ${result.verdict} (${result.summary.passed}/${result.summary.total} passed, ${result.summary.errors} errors)`,
        );
        if (comparison) {
          process.stdout.write(formatRunComparison(comparison));
        }
      }

      if (isStrictFailure(result.verdict, options.strict) || comparison?.hasRegressions === true) {
        process.exitCode = 1;
      }
    },
  );

program
  .command("list")
  .description("List saved Pupil runs from JSON history.")
  .option("--history-dir <dir>", "Directory for JSON run history", ".pupil")
  .action(async (options: { historyDir: string }) => {
    const store = new JsonRunHistoryStore({ dir: options.historyDir });
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
  .option("--history-dir <dir>", "Directory for JSON run history", ".pupil")
  .action(async (runId: string, options: { historyDir: string }) => {
    const run = await new JsonRunHistoryStore({ dir: options.historyDir }).readRun(runId);
    console.log(`Run ${run.runId}: ${run.verdict}`);
    console.log(`Started: ${run.startedAt}`);
    console.log(`Completed: ${run.completedAt}`);
    console.log(`Summary: ${formatSummary(run.summary)}`);

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
  });

program
  .command("baseline")
  .description("Show or set the baseline run id.")
  .argument("[runId]", "Run id to set as baseline")
  .option("--history-dir <dir>", "Directory for JSON run history", ".pupil")
  .action(async (runId: string | undefined, options: { historyDir: string }) => {
    const store = new JsonRunHistoryStore({ dir: options.historyDir });
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
  });

program
  .command("score")
  .description("Apply a manual score to a saved scenario result.")
  .argument("<runId>", "Run id to update")
  .argument("<scenario>", "Scenario id to score")
  .argument("<criterion>", "Manual criterion name")
  .argument("<verdict>", "Manual verdict: pass or fail", parseManualVerdict)
  .option("--history-dir <dir>", "Directory for JSON run history", ".pupil")
  .option("--note <note>", "Reviewer note for the manual score")
  .action(
    async (
      runId: string,
      scenarioId: string,
      criterion: string,
      verdict: Verdict.Pass | Verdict.Fail,
      options: { historyDir: string; note?: string },
    ) => {
      const store = new JsonRunHistoryStore({ dir: options.historyDir });
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
  .option("--history-dir <dir>", "Directory for JSON run history", ".pupil")
  .option("--config <path>", "Path to a Pupil config file (default: pupil.config.yaml)")
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
        historyDir: string;
        config?: string;
        latencyThresholdMs?: number;
        latencyThresholdPct?: number;
      },
    ) => {
      const config = await loadPupilConfig(
        options.config !== undefined ? { configPath: options.config } : {},
      );
      const store = new JsonRunHistoryStore({ dir: options.historyDir });
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
      if (comparison.hasRegressions) {
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

void main();
