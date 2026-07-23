#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { Verdict } from "../core/types.js";
import { JsonRunHistoryStore } from "../history/index.js";
import { createIrisMockAgent } from "../mock/irisMockAgent.js";
import { runScenarios, type RunnerProgressEvent } from "../runner/index.js";
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

function parsePositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError(`${name} must be a positive integer`);
  }
  return parsed;
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

function logProgress(event: RunnerProgressEvent): void {
  if (event.type === "scenario:start") {
    console.log(`START ${event.scenarioId}`);
    return;
  }
  if (event.type === "scenario:retry") {
    console.log(`RETRY ${event.scenarioId} attempt ${event.attempt}/${event.maxAttempts}`);
    return;
  }
  if (event.type === "scenario:pass") {
    console.log(`PASS ${event.scenarioId}`);
    return;
  }
  if (event.type === "scenario:fail") {
    console.log(`FAIL ${event.scenarioId}`);
    return;
  }
  console.log(`ERROR ${event.scenarioId}${event.message ? `: ${event.message}` : ""}`);
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
      },
    ) => {
      const scenarios = await loadScenarios(path);
      const result = await runScenarios(scenarios, {
        timeoutMs: options.timeoutMs,
        retries: options.retries,
        concurrency: options.concurrency,
        driverConfig: definedConfig(options),
        progress: logProgress,
      });

      const stored = await new JsonRunHistoryStore({ dir: options.historyDir }).writeRun(result);

      console.log(`Saved run: ${stored.runPath}`);
      console.log(
        `Run ${result.runId}: ${result.verdict} (${result.summary.passed}/${result.summary.total} passed, ${result.summary.errors} errors)`,
      );

      if (result.verdict === Verdict.Error || result.verdict === Verdict.Fail) {
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
    process.exit(1);
  }
}

void main();
