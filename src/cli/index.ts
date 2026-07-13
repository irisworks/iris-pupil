#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { loadScenarioFile, loadScenarios } from "../scenario/index.js";
import { createIrisMockAgent } from "../mock/irisMockAgent.js";

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
  .description("Run a scenario. REST driver implementation lands in IRIS-87 to IRIS-90.")
  .argument("<scenario>", "Scenario YAML file")
  .action(async (scenarioPath: string) => {
    const scenario = await loadScenarioFile(scenarioPath);
    console.log(`Scenario loaded: ${scenario.id}`);
    console.log("Run support is scaffolded; implement driver execution in IRIS-87 to IRIS-90.");
  });

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
