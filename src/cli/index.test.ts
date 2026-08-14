import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Verdict, type RunResult } from "../core/types.js";
import { JsonRunHistoryStore } from "../history/index.js";
import { createIrisMockAgent } from "../mock/irisMockAgent.js";

const cliPath = join(process.cwd(), "dist", "cli", "index.js");

function runResult(runId: string, verdict: Verdict = Verdict.Pass): RunResult {
  return {
    runId,
    verdict,
    results: [
      {
        scenarioId: "scenario-1",
        scenarioName: "Scenario 1",
        verdict,
        scores: [
          {
            name: "assertion:contains:response.text",
            verdict,
            reason: "Expected response.text to contain ok",
            metadata: {},
          },
        ],
        turns: [],
        startedAt: "2026-07-27T00:00:00.000Z",
        completedAt: "2026-07-27T00:00:01.000Z",
        metrics: { turns: 1, latency_ms: 1000 },
      },
    ],
    startedAt: "2026-07-27T00:00:00.000Z",
    completedAt: "2026-07-27T00:00:01.000Z",
    summary: {
      total: 1,
      passed: verdict === Verdict.Pass ? 1 : 0,
      failed: verdict === Verdict.Fail ? 1 : 0,
      needsReview: verdict === Verdict.NeedsReview ? 1 : 0,
      errors: verdict === Verdict.Error ? 1 : 0,
    },
    metadata: {},
  };
}

async function waitForCli(child: ReturnType<typeof spawn>): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  if (!child.stdout || !child.stderr) {
    throw new Error("Expected piped stdout and stderr from child process");
  }

  const stdoutStream = child.stdout;
  const stderrStream = child.stderr;

  stdoutStream.setEncoding("utf-8");
  stderrStream.setEncoding("utf-8");

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`pupil command did not finish. stderr: ${stderr}`));
    }, 10000);

    stdoutStream.on("data", (chunk: string) => {
      stdout += chunk;
    });
    stderrStream.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe("pupil CLI", () => {
  it("exits successfully for --version", () => {
    const result = spawnSync(process.execPath, [cliPath, "--version"], { encoding: "utf-8" });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("0.1.0");
    expect(result.stderr.trim()).toBe("");
  });

  it("exits successfully for --help", () => {
    const result = spawnSync(process.execPath, [cliPath, "--help"], { encoding: "utf-8" });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: pupil");
    expect(result.stdout).toContain("list");
    expect(result.stdout).toContain("report");
    expect(result.stdout).toContain("baseline");
    expect(result.stdout).toContain("compare");
    expect(result.stdout).toContain("score");
    expect(result.stderr.trim()).toBe("");
  });

  it("does not duplicate Commander parse errors", () => {
    const result = spawnSync(process.execPath, [cliPath, "unknown-command"], { encoding: "utf-8" });

    expect(result.status).toBe(1);
    expect(result.stderr.match(/unknown command/g)).toHaveLength(1);
  });

  it.each([
    [["--port", "abc"], "port must be an integer between 0 and 65535"],
    [["--port", "-1"], "port must be an integer between 0 and 65535"],
    [["--port", "70000"], "port must be an integer between 0 and 65535"],
    [["--delay-ms", "abc"], "delay-ms must be a non-negative integer"],
    [["--delay-ms", "-5"], "delay-ms must be a non-negative integer"],
  ])("rejects invalid numeric mock-agent option %s", (args, message) => {
    const result = spawnSync(process.execPath, [cliPath, "mock-agent", ...args], {
      encoding: "utf-8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });

  it("runs a scenario end to end against the mock agent and stores history", async () => {
    const mock = createIrisMockAgent({
      port: 0,
      rules: [{ match: "hello", reply: "online" }],
    });
    const address = await mock.listen();
    const dir = await mkdtemp(join(tmpdir(), "pupil-run-"));
    const scenarioPath = join(dir, "scenario.yaml");
    const historyDir = join(dir, "history");

    try {
      await writeFile(
        scenarioPath,
        [
          "id: cli-run",
          "name: CLI run",
          "driver:",
          "  type: rest",
          "  preset: iris-http",
          "input: hello",
          "",
        ].join("\n"),
      );

      const child = spawn(
        process.execPath,
        [
          cliPath,
          "run",
          scenarioPath,
          "--base-url",
          `http://${address.host}:${address.port}`,
          "--origin-thread-ts",
          "thread-1",
          "--history-dir",
          historyDir,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const output = await waitForCli(child);

      expect(output.code).toBe(0);
      expect(output.stderr).toBe("");
      expect(output.stdout).toContain("START cli-run");
      expect(output.stdout).toContain("PASS cli-run");
      expect(output.stdout).toContain("Saved run:");
      expect(output.stdout).toContain("Run ");

      const runId = /Run ([^:]+):/.exec(output.stdout)?.[1];
      expect(runId).toBeDefined();
      const runJson = await readFile(join(historyDir, "runs", `${runId}.json`), "utf-8");
      expect(JSON.parse(runJson)).toMatchObject({ runId, verdict: "pass" });
      const index = await readFile(join(historyDir, "index.jsonl"), "utf-8");
      expect(index).toContain(`"runId":"${runId}"`);
    } finally {
      await mock.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 15000);

  it("fails pupil run when scenario assertions fail and stores the failed run", async () => {
    const mock = createIrisMockAgent({
      port: 0,
      rules: [{ match: "hello", reply: "offline" }],
    });
    const address = await mock.listen();
    const dir = await mkdtemp(join(tmpdir(), "pupil-run-"));
    const scenarioPath = join(dir, "scenario.yaml");
    const historyDir = join(dir, "history");

    try {
      await writeFile(
        scenarioPath,
        [
          "id: cli-run-fail",
          "name: CLI run fail",
          "driver:",
          "  type: rest",
          "  preset: iris-http",
          "input: hello",
          "expect:",
          "  assertions:",
          "    - type: contains",
          "      target: response.text",
          "      value: online",
          "",
        ].join("\n"),
      );

      const child = spawn(
        process.execPath,
        [
          cliPath,
          "run",
          scenarioPath,
          "--base-url",
          `http://${address.host}:${address.port}`,
          "--origin-thread-ts",
          "thread-1",
          "--history-dir",
          historyDir,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const output = await waitForCli(child);

      expect(output.code).toBe(1);
      expect(output.stderr).toBe("");
      expect(output.stdout).toContain("START cli-run-fail");
      expect(output.stdout).toContain("FAIL cli-run-fail");
      expect(output.stdout).toContain("Saved run:");

      const index = await readFile(join(historyDir, "index.jsonl"), "utf-8");
      expect(index).toContain('"verdict":"fail"');
    } finally {
      await mock.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 15000);

  it("logs REVIEW, not FAIL, when pupil run produces a needs_review verdict", async () => {
    const mock = createIrisMockAgent({
      port: 0,
      rules: [{ match: "hello", reply: "online" }],
    });
    const address = await mock.listen();
    const dir = await mkdtemp(join(tmpdir(), "pupil-run-"));
    const scenarioPath = join(dir, "scenario.yaml");
    const historyDir = join(dir, "history");

    try {
      await writeFile(
        scenarioPath,
        [
          "id: cli-run-needs-review",
          "name: CLI run needs review",
          "driver:",
          "  type: rest",
          "  preset: iris-http",
          "input: hello",
          "expect:",
          "  manual:",
          "    required: true",
          "",
        ].join("\n"),
      );

      const child = spawn(
        process.execPath,
        [
          cliPath,
          "run",
          scenarioPath,
          "--base-url",
          `http://${address.host}:${address.port}`,
          "--origin-thread-ts",
          "thread-1",
          "--history-dir",
          historyDir,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const output = await waitForCli(child);

      expect(output.stderr).toBe("");
      expect(output.stdout).toContain("START cli-run-needs-review");
      expect(output.stdout).toContain("REVIEW cli-run-needs-review");
      expect(output.stdout).not.toContain("FAIL cli-run-needs-review");
      expect(output.stdout).toContain("Saved run:");

      const index = await readFile(join(historyDir, "index.jsonl"), "utf-8");
      expect(index).toContain('"verdict":"needs_review"');
    } finally {
      await mock.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 15000);

  it("reports a clean error when run history cannot be written", async () => {
    const mock = createIrisMockAgent({
      port: 0,
      rules: [{ match: "hello", reply: "online" }],
    });
    const address = await mock.listen();
    const dir = await mkdtemp(join(tmpdir(), "pupil-run-"));
    const scenarioPath = join(dir, "scenario.yaml");
    const historyDir = join(dir, "history-file");

    try {
      await writeFile(
        scenarioPath,
        [
          "id: cli-run-history-error",
          "name: CLI run history error",
          "driver:",
          "  type: rest",
          "  preset: iris-http",
          "input: hello",
          "",
        ].join("\n"),
      );
      await writeFile(historyDir, "not a directory");

      const child = spawn(
        process.execPath,
        [
          cliPath,
          "run",
          scenarioPath,
          "--base-url",
          `http://${address.host}:${address.port}`,
          "--origin-thread-ts",
          "thread-1",
          "--history-dir",
          historyDir,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const output = await waitForCli(child);

      expect(output.code).toBe(1);
      expect(output.stdout).toContain("PASS cli-run-history-error");
      expect(output.stdout).not.toContain("Saved run:");
      expect(output.stderr).toContain("Failed to save run history:");
    } finally {
      await mock.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 15000);

  it("lists, reports, and manages baseline from saved history", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pupil-history-cli-"));
    const historyDir = join(dir, "history");
    const store = new JsonRunHistoryStore({ dir: historyDir });

    try {
      await store.writeRun(runResult("run-pass"));
      await store.writeRun(runResult("run-fail", Verdict.Fail));

      const list = spawnSync(process.execPath, [cliPath, "list", "--history-dir", historyDir], {
        encoding: "utf-8",
      });
      expect(list.status).toBe(0);
      expect(list.stderr).toBe("");
      expect(list.stdout).toContain("run-pass pass 2026-07-27T00:00:00.000Z scenarios=1");
      expect(list.stdout).toContain("run-fail fail 2026-07-27T00:00:00.000Z scenarios=1");

      const report = spawnSync(
        process.execPath,
        [cliPath, "report", "run-fail", "--history-dir", historyDir],
        {
          encoding: "utf-8",
        },
      );
      expect(report.status).toBe(0);
      expect(report.stderr).toBe("");
      expect(report.stdout).toContain("Run run-fail: fail");
      expect(report.stdout).toContain("Summary: 0/1 passed, 1 failed, 0 needs_review, 0 errors");
      expect(report.stdout).toContain("score assertion:contains:response.text: fail");

      const passingReport = spawnSync(
        process.execPath,
        [cliPath, "report", "run-pass", "--history-dir", historyDir],
        {
          encoding: "utf-8",
        },
      );
      expect(passingReport.status).toBe(0);
      expect(passingReport.stdout).toContain("Run run-pass: pass");

      const missingBaseline = spawnSync(
        process.execPath,
        [cliPath, "baseline", "--history-dir", historyDir],
        {
          encoding: "utf-8",
        },
      );
      expect(missingBaseline.status).toBe(1);
      expect(missingBaseline.stdout).toContain("No baseline set.");

      const setBaseline = spawnSync(
        process.execPath,
        [cliPath, "baseline", "run-pass", "--history-dir", historyDir],
        { encoding: "utf-8" },
      );
      expect(setBaseline.status).toBe(0);
      expect(setBaseline.stdout).toContain("Baseline set to run-pass");

      const showBaseline = spawnSync(
        process.execPath,
        [cliPath, "baseline", "--history-dir", historyDir],
        {
          encoding: "utf-8",
        },
      );
      expect(showBaseline.status).toBe(0);
      expect(showBaseline.stdout).toContain("Baseline: run-pass");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15000);

  it("applies manual scores and report reflects the updated verdict", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pupil-score-cli-"));
    const historyDir = join(dir, "history");
    const store = new JsonRunHistoryStore({ dir: historyDir });
    const manualRun: RunResult = {
      ...runResult("manual-run", Verdict.NeedsReview),
      results: [
        {
          scenarioId: "manual-scenario",
          scenarioName: "Manual scenario",
          verdict: Verdict.NeedsReview,
          scores: [
            {
              name: "manual:correctness",
              verdict: Verdict.NeedsReview,
              reason: "Manual score required",
              metadata: { manual: { criterion: "correctness" } },
            },
          ],
          turns: [],
          startedAt: "2026-07-27T00:00:00.000Z",
          completedAt: "2026-07-27T00:00:01.000Z",
          metrics: { turns: 1, latency_ms: 1000 },
        },
      ],
      summary: { total: 1, passed: 0, failed: 0, needsReview: 1, errors: 0 },
    };

    try {
      await store.writeRun(manualRun);

      const score = spawnSync(
        process.execPath,
        [
          cliPath,
          "score",
          "manual-run",
          "manual-scenario",
          "correctness",
          "pass",
          "--history-dir",
          historyDir,
          "--note",
          "Looks correct",
        ],
        { encoding: "utf-8" },
      );
      expect(score.status).toBe(0);
      expect(score.stderr).toBe("");
      expect(score.stdout).toContain(
        "Updated manual-run/manual-scenario/correctness: pass. Scenario verdict: pass. Run verdict: pass",
      );

      const updated = await store.readRun("manual-run");
      expect(updated).toMatchObject({
        verdict: "pass",
        summary: { passed: 1, needsReview: 0 },
        results: [{ scenarioId: "manual-scenario", verdict: "pass" }],
      });
      expect(updated.results[0]?.scores[0]).toMatchObject({
        verdict: "pass",
        reason: "Manual score: pass - Looks correct",
        value: "pass",
      });

      const report = spawnSync(
        process.execPath,
        [cliPath, "report", "manual-run", "--history-dir", historyDir],
        { encoding: "utf-8" },
      );
      expect(report.status).toBe(0);
      expect(report.stdout).toContain("Run manual-run: pass");
      expect(report.stdout).toContain(
        "score manual:correctness: pass - Manual score: pass - Looks correct",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15000);

  it("scores manual criteria stored without score metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pupil-score-legacy-"));
    const historyDir = join(dir, "history");
    const store = new JsonRunHistoryStore({ dir: historyDir });
    const legacyRun = {
      ...runResult("legacy-run", Verdict.NeedsReview),
      results: [
        {
          scenarioId: "manual-scenario",
          scenarioName: "Manual scenario",
          verdict: Verdict.NeedsReview,
          // Written by an older Pupil version: no metadata on the score.
          scores: [{ name: "manual:overall", verdict: Verdict.NeedsReview }],
          turns: [],
          startedAt: "2026-07-27T00:00:00.000Z",
          completedAt: "2026-07-27T00:00:01.000Z",
          metrics: { turns: 1, latency_ms: 1000 },
        },
      ],
      summary: { total: 1, passed: 0, failed: 0, needsReview: 1, errors: 0 },
    } as unknown as RunResult;

    try {
      await store.writeRun(legacyRun);

      const score = spawnSync(
        process.execPath,
        [
          cliPath,
          "score",
          "legacy-run",
          "manual-scenario",
          "overall",
          "fail",
          "--history-dir",
          historyDir,
        ],
        { encoding: "utf-8" },
      );
      expect(score.status).toBe(0);
      expect(score.stderr).toBe("");

      const updated = await store.readRun("legacy-run");
      expect(updated.verdict).toBe("fail");
      expect(updated.results[0]?.scores[0]).toMatchObject({
        verdict: "fail",
        reason: "Manual score: fail",
        metadata: { manual: { criterion: "overall" } },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15000);

  it("exits nonzero when compare detects regressions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pupil-compare-"));
    const historyDir = join(dir, "history");
    await mkdir(join(historyDir, "runs"), { recursive: true });

    const baseRun = {
      runId: "base-run",
      verdict: "pass",
      results: [
        {
          scenarioId: "scenario-1",
          scenarioName: "Scenario 1",
          verdict: "pass",
          scores: [],
          turns: [],
          startedAt: "2026-07-27T00:00:00.000Z",
          completedAt: "2026-07-27T00:00:01.000Z",
          metrics: { turns: 1, latency_ms: 1000 },
        },
      ],
      startedAt: "2026-07-27T00:00:00.000Z",
      completedAt: "2026-07-27T00:00:01.000Z",
      summary: { total: 1, passed: 1, failed: 0, needsReview: 0, errors: 0 },
      metadata: {},
    };
    const currentRun = {
      ...baseRun,
      runId: "current-run",
      verdict: "fail",
      results: [
        {
          ...baseRun.results[0],
          verdict: "fail",
          metrics: { turns: 1, latency_ms: 1600 },
        },
      ],
      summary: { total: 1, passed: 0, failed: 1, needsReview: 0, errors: 0 },
    };

    try {
      await writeFile(join(historyDir, "runs", "base-run.json"), JSON.stringify(baseRun));
      await writeFile(join(historyDir, "runs", "current-run.json"), JSON.stringify(currentRun));

      const result = spawnSync(
        process.execPath,
        [
          cliPath,
          "compare",
          "base-run",
          "current-run",
          "--history-dir",
          historyDir,
          "--latency-threshold-ms",
          "250",
        ],
        { encoding: "utf-8" },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Comparison base-run -> current-run");
      expect(result.stdout).toContain("Summary: regressed=1");
      expect(result.stdout).toContain("REGRESSION scenario-1: pass -> fail");
      expect(result.stdout).toContain("latency_ms increased by 600 beyond threshold 250");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15000);
  it("starts mock-agent as a standalone server", async () => {
    const child = spawn(process.execPath, [cliPath, "mock-agent", "--port", "0"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!child.stdout || !child.stderr) {
      throw new Error("Expected piped stdout and stderr from child process");
    }
    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;

    try {
      const output = await new Promise<string>((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
          reject(new Error(`mock-agent did not start. stderr: ${stderr}`));
        }, 10000);

        stdoutStream.setEncoding("utf-8");
        stderrStream.setEncoding("utf-8");
        stdoutStream.on("data", (chunk: string) => {
          stdout += chunk;
          if (stdout.includes("IRIS mock agent listening")) {
            clearTimeout(timer);
            resolve(stdout);
          }
        });
        stderrStream.on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`mock-agent exited early with code ${code}. stderr: ${stderr}`));
        });
      });

      const url = /http:\/\/[^\s]+/.exec(output)?.[0];
      expect(url).toBeDefined();
      const health = await fetch(`${url}/health`).then((response) => response.json());
      expect(health).toEqual({ ok: true, channels: 0 });
    } finally {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }, 15000);
});
