import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Verdict, type RunResult } from "../core/types.js";
import { JsonRunHistoryStore } from "./index.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pupil-history-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function runResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    runId: "run-1",
    verdict: Verdict.Pass,
    startedAt: "2026-07-23T00:00:00.000Z",
    completedAt: "2026-07-23T00:00:01.000Z",
    results: [
      {
        scenarioId: "scenario-1",
        scenarioName: "Scenario 1",
        verdict: Verdict.Pass,
        scores: [],
        turns: [],
        startedAt: "2026-07-23T00:00:00.000Z",
        completedAt: "2026-07-23T00:00:01.000Z",
        metrics: { turns: 1, latency_ms: 1000 },
      },
    ],
    summary: {
      total: 1,
      passed: 1,
      failed: 0,
      needsReview: 0,
      errors: 0,
    },
    metadata: { branch: "main" },
    ...overrides,
  };
}

describe("JsonRunHistoryStore", () => {
  it("writes git-diffable run JSON and appends index entries", async () => {
    const store = new JsonRunHistoryStore({ dir });
    const stored = await store.writeRun(runResult());

    expect(stored.runPath).toBe(join(dir, "runs", "run-1.json"));
    const runJson = await readFile(join(dir, "runs", "run-1.json"), "utf-8");
    expect(runJson).toContain('\n  "runId": "run-1"');
    expect(JSON.parse(runJson)).toMatchObject({ runId: "run-1", verdict: "pass" });

    const index = await readFile(join(dir, "index.jsonl"), "utf-8");
    const entries = index
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(entries).toEqual([
      {
        runId: "run-1",
        verdict: "pass",
        startedAt: "2026-07-23T00:00:00.000Z",
        completedAt: "2026-07-23T00:00:01.000Z",
        scenarioCount: 1,
        summary: {
          total: 1,
          passed: 1,
          failed: 0,
          needsReview: 0,
          errors: 0,
        },
        metadata: { branch: "main" },
        path: "runs/run-1.json",
      },
    ]);
  });

  it("rejects duplicate run ids without appending stale index entries", async () => {
    const store = new JsonRunHistoryStore({ dir });
    await store.writeRun(runResult());

    await expect(store.writeRun(runResult())).rejects.toThrow(
      "Run history already exists for run id run-1",
    );

    const index = await readFile(join(dir, "index.jsonl"), "utf-8");
    expect(index.trim().split("\n")).toHaveLength(1);
  });
  it("reads runs and lists index entries", async () => {
    const store = new JsonRunHistoryStore({ dir });
    await store.writeRun(runResult());
    await store.writeRun(runResult({ runId: "run-2", verdict: Verdict.Fail }));

    await expect(store.readRun("run-1")).resolves.toMatchObject({ runId: "run-1" });
    await expect(store.listRuns()).resolves.toMatchObject([
      { runId: "run-1", path: "runs/run-1.json" },
      { runId: "run-2", path: "runs/run-2.json" },
    ]);
  });

  it("updates existing run JSON and replaces the index entry", async () => {
    const store = new JsonRunHistoryStore({ dir });
    await store.writeRun(runResult());

    const updated = runResult({
      verdict: Verdict.NeedsReview,
      summary: { total: 1, passed: 0, failed: 0, needsReview: 1, errors: 0 },
      results: [
        {
          scenarioId: "scenario-1",
          scenarioName: "Scenario 1",
          verdict: Verdict.NeedsReview,
          scores: [],
          turns: [],
          startedAt: "2026-07-23T00:00:00.000Z",
          completedAt: "2026-07-23T00:00:01.000Z",
          metrics: { turns: 1, latency_ms: 1000 },
        },
      ],
    });
    await store.updateRun(updated);

    await expect(store.readRun("run-1")).resolves.toMatchObject({ verdict: "needs_review" });
    const entries = await store.listRuns();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      runId: "run-1",
      verdict: "needs_review",
      summary: { needsReview: 1 },
    });
  });

  it("leaves no temp files behind after updating a run", async () => {
    const store = new JsonRunHistoryStore({ dir });
    await store.writeRun(runResult());
    await store.updateRun(runResult({ verdict: Verdict.NeedsReview }));

    await expect(readdir(join(dir, "runs"))).resolves.toEqual(["run-1.json"]);
    const files = await readdir(dir);
    expect(files.filter((file) => file.includes(".tmp-"))).toEqual([]);
  });

  it("reports a missing run when updateRun targets unknown history", async () => {
    const store = new JsonRunHistoryStore({ dir });

    await expect(store.updateRun(runResult())).rejects.toThrow(
      /Cannot update missing run run-1: .*run-1\.json does not exist/,
    );
  });

  it("resolves the baseline pointer from disk", async () => {
    const store = new JsonRunHistoryStore({ dir });
    await store.writeRun(runResult());
    await store.setBaseline("run-1");

    await expect(readFile(join(dir, "baseline"), "utf-8")).resolves.toBe("run-1\n");
    await expect(store.getBaselineRunId()).resolves.toBe("run-1");
    await expect(store.readBaseline()).resolves.toMatchObject({ runId: "run-1" });
  });

  it("returns an empty history and undefined baseline when files are missing", async () => {
    const store = new JsonRunHistoryStore({ dir });

    await expect(store.listRuns()).resolves.toEqual([]);
    await expect(store.getBaselineRunId()).resolves.toBeUndefined();
    await expect(store.readBaseline()).resolves.toBeUndefined();
  });
});
