import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { parseDocument } from "yaml";
import type { Scenario } from "../core/types.js";
import { PupilError } from "../core/types.js";
import { normalizeScenario } from "./schema.js";

const YAML_EXTENSIONS = new Set([".yaml", ".yml"]);

export async function discoverScenarioFiles(path: string): Promise<string[]> {
  const root = resolve(path);
  const found: string[] = [];
  const visitedDirs = new Set<string>();

  async function visit(current: string): Promise<void> {
    const currentStat = await stat(current);
    if (currentStat.isFile()) {
      if (YAML_EXTENSIONS.has(extname(current).toLowerCase())) {
        found.push(current);
      }
      return;
    }

    if (!currentStat.isDirectory()) {
      return;
    }

    // Symlinked directories can loop back on an ancestor; guard on the
    // resolved real path so such cycles don't recurse forever.
    const realDir = await realpath(current);
    if (visitedDirs.has(realDir)) {
      return;
    }
    visitedDirs.add(realDir);

    const entries = await readdir(current, { withFileTypes: true });
    const ordered = entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of ordered) {
      await visit(join(current, entry.name));
    }
  }

  await visit(root);
  return found.sort((left, right) => left.localeCompare(right));
}

export async function loadScenarioFile(file: string): Promise<Scenario> {
  const absoluteFile = resolve(file);
  let parsed: unknown;

  try {
    const source = await readFile(absoluteFile, "utf-8");
    const document = parseDocument(source, { prettyErrors: true });
    if (document.errors.length > 0) {
      const message = document.errors.map((error) => error.message).join("\n");
      throw new PupilError(`Invalid YAML in ${absoluteFile}\n${message}`, { file: absoluteFile });
    }
    parsed = document.toJSON();
  } catch (error) {
    if (error instanceof PupilError) {
      throw error;
    }
    throw new PupilError(`Failed to read scenario ${absoluteFile}: ${String(error)}`, {
      file: absoluteFile,
    });
  }

  return normalizeScenario(parsed, absoluteFile);
}

export function assertUniqueScenarioIds(scenarios: Scenario[]): void {
  const firstById = new Map<string, Scenario>();

  for (const scenario of scenarios) {
    const existing = firstById.get(scenario.id);
    if (existing) {
      throw new PupilError(
        `Duplicate scenario id "${scenario.id}" in ${existing.sourceFile ?? "<unknown>"} and ${
          scenario.sourceFile ?? "<unknown>"
        }`,
        { file: scenario.sourceFile, path: "id" },
      );
    }
    firstById.set(scenario.id, scenario);
  }
}

export function sortScenarios(scenarios: Scenario[]): Scenario[] {
  return [...scenarios].sort((left, right) => {
    const byId = left.id.localeCompare(right.id);
    if (byId !== 0) return byId;
    return (left.sourceFile ?? "").localeCompare(right.sourceFile ?? "");
  });
}

export async function loadScenarios(path: string): Promise<Scenario[]> {
  const files = await discoverScenarioFiles(path);
  const scenarios = await Promise.all(files.map((file) => loadScenarioFile(file)));
  assertUniqueScenarioIds(scenarios);
  return sortScenarios(scenarios);
}
