import { mkdtemp, readFile, rm } from "node:fs/promises";
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
