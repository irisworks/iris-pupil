#!/usr/bin/env node

import { Command, CommanderError } from "commander";
import { discoverScenarioFiles, loadScenarioFile, loadScenarios } from "../scenario/index.js";
import { createIrisMockAgent } from "../mock/irisMockAgent.js";

const program = new Command();

function isSuccessfulCommanderExit(error: unknown): boolean {
  return error instanceof CommanderError && error.exitCode === 0;
}

program.name("pupil").description("Continuous quality engineering for AI agents.").version("0.1.0");

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
    const files = await discoverScenarioFiles(path);
    const scenarios = await loadScenarios(path);
    console.log(`Discovered ${scenarios.length} scenario${scenarios.length === 1 ? "" : "s"}.`);
    for (const scenario of scenarios) {
      console.log(`- ${scenario.id} (${scenario.sourceFile ?? files[0]})`);
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
  .option("-p, --port <port>", "Port to listen on", "5050")
  .option("--host <host>", "Host to bind", "127.0.0.1")
  .option("--delay-ms <delayMs>", "Default response delay in milliseconds", "0")
  .action(async (options: { port: string; host: string; delayMs: string }) => {
    const mock = createIrisMockAgent({
      port: Number(options.port),
      host: options.host,
      defaultDelayMs: Number(options.delayMs),
    });
    const address = await mock.listen();
    console.log(`IRIS mock agent listening on http://${address.host}:${address.port}`);
  });

program.exitOverride();

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (isSuccessfulCommanderExit(error)) {
      process.exit(0);
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

void main();
