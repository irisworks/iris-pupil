import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PupilError, type RunResult, type Verdict } from "../core/types.js";

export * from "./compare.js";

export interface RunIndexEntry {
  runId: string;
  verdict: Verdict;
  startedAt: string;
  completedAt: string;
  scenarioCount: number;
  summary: RunResult["summary"];
  metadata: Record<string, unknown>;
  path: string;
}

export interface StoredRun {
  run: RunResult;
  runPath: string;
  indexPath: string;
}

export interface JsonRunHistoryStoreOptions {
  dir?: string;
}

let atomicWriteSequence = 0;

/**
 * Replace a file in one step so an interrupted write cannot leave the run JSON
 * or the run index truncated. Full-file rewrites are the only way updateRun can
 * touch history, and index.jsonl is the sole listing source.
 */
async function writeFileAtomic(path: string, contents: string): Promise<void> {
  atomicWriteSequence += 1;
  const tempPath = `${path}.tmp-${process.pid}-${atomicWriteSequence}`;
  try {
    await writeFile(tempPath, contents, "utf-8");
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function runIndexEntry(run: RunResult): RunIndexEntry {
  return {
    runId: run.runId,
    verdict: run.verdict,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    scenarioCount: run.results.length,
    summary: run.summary,
    metadata: run.metadata,
    path: `runs/${run.runId}.json`,
  };
}

export class JsonRunHistoryStore {
  readonly type = "json";
  readonly dir: string;
  readonly runsDir: string;
  readonly indexPath: string;
  readonly baselinePath: string;

  constructor(options: JsonRunHistoryStoreOptions = {}) {
    this.dir = resolve(options.dir ?? ".pupil");
    this.runsDir = join(this.dir, "runs");
    this.indexPath = join(this.dir, "index.jsonl");
    this.baselinePath = join(this.dir, "baseline");
  }

  runPath(runId: string): string {
    if (!runId || runId.includes("/") || runId.includes("\\")) {
      throw new PupilError(`Invalid run id for history path: ${runId}`);
    }
    return join(this.runsDir, `${runId}.json`);
  }

  async writeRun(run: RunResult): Promise<StoredRun> {
    try {
      const existing = await stat(this.dir);
      if (!existing.isDirectory()) {
        throw new PupilError(`History path is not a directory: ${this.dir}`);
      }
    } catch (error) {
      if (error instanceof PupilError) {
        throw error;
      }
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }

    await mkdir(this.runsDir, { recursive: true });
    const runPath = this.runPath(run.runId);
    try {
      await writeFile(runPath, `${JSON.stringify(run, null, 2)}\n`, {
        encoding: "utf-8",
        flag: "wx",
      });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        throw new PupilError(`Run history already exists for run id ${run.runId}`);
      }
      throw error;
    }

    const entry = runIndexEntry(run);

    await appendFile(this.indexPath, `${JSON.stringify(entry)}\n`, "utf-8");
    return { run, runPath, indexPath: this.indexPath };
  }

  async updateRun(run: RunResult): Promise<StoredRun> {
    const runPath = this.runPath(run.runId);
    try {
      const existing = await stat(runPath);
      if (!existing.isFile()) {
        throw new PupilError(`Run history path is not a file: ${runPath}`);
      }
    } catch (error) {
      if (error instanceof PupilError) throw error;
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        throw new PupilError(`Cannot update missing run ${run.runId}: ${runPath} does not exist`);
      }
      throw new PupilError(
        `Failed to inspect run ${run.runId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    await writeFileAtomic(runPath, `${JSON.stringify(run, null, 2)}\n`);

    const entry = runIndexEntry(run);
    const entries = await this.listRuns();
    let replaced = false;
    const updatedEntries = entries.map((current) => {
      if (current.runId !== run.runId) return current;
      replaced = true;
      return entry;
    });
    if (!replaced) {
      updatedEntries.push(entry);
    }

    await writeFileAtomic(
      this.indexPath,
      `${updatedEntries.map((current) => JSON.stringify(current)).join("\n")}\n`,
    );
    return { run, runPath, indexPath: this.indexPath };
  }

  async readRun(runId: string): Promise<RunResult> {
    try {
      const source = await readFile(this.runPath(runId), "utf-8");
      return JSON.parse(source) as RunResult;
    } catch (error) {
      throw new PupilError(
        `Failed to read run ${runId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async listRuns(): Promise<RunIndexEntry[]> {
    let source: string;
    try {
      source = await readFile(this.indexPath, "utf-8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return [];
      }
      throw new PupilError(
        `Failed to read run index: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return source
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as RunIndexEntry);
  }

  async setBaseline(runId: string): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.baselinePath, `${runId}\n`, "utf-8");
  }

  async getBaselineRunId(): Promise<string | undefined> {
    try {
      const source = await readFile(this.baselinePath, "utf-8");
      const runId = source.trim();
      return runId.length > 0 ? runId : undefined;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return undefined;
      }
      throw new PupilError(
        `Failed to read baseline pointer: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async readBaseline(): Promise<RunResult | undefined> {
    const runId = await this.getBaselineRunId();
    return runId ? this.readRun(runId) : undefined;
  }
}
