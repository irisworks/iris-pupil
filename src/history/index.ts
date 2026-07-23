import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PupilError, type RunResult, type Verdict } from "../core/types.js";

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
    await mkdir(this.runsDir, { recursive: true });
    const runPath = this.runPath(run.runId);
    await writeFile(runPath, `${JSON.stringify(run, null, 2)}\n`, "utf-8");

    const entry: RunIndexEntry = {
      runId: run.runId,
      verdict: run.verdict,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      scenarioCount: run.results.length,
      summary: run.summary,
      metadata: run.metadata,
      path: `runs/${run.runId}.json`,
    };
    await appendFile(this.indexPath, `${JSON.stringify(entry)}\n`, "utf-8");
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
