import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Verdict, type RunResult } from "../core/types.js";
import { JsonRunHistoryStore } from "../history/index.js";
import { createIrisMockAgent } from "../mock/irisMockAgent.js";
import { program } from "./index.js";

const cliPath = join(process.cwd(), "dist", "cli", "index.js");

const minimalScenarioYaml = [
  "id: target-test-scenario",
  "name: Target test scenario",
  "driver:",
  "  type: rest",
  "  preset: iris-http",
  "input: hello",
].join("\n");

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

async function writeCompareRuns(
  historyDir: string,
  current: { verdict?: Verdict; latencyMs?: number },
): Promise<void> {
  await mkdir(join(historyDir, "runs"), { recursive: true });
  const baseRun = runResult("base-run");
  const currentVerdict = current.verdict ?? Verdict.Pass;
  const currentRun: RunResult = {
    ...runResult("current-run", currentVerdict),
    results: [
      {
        ...baseRun.results[0],
        verdict: currentVerdict,
        metrics: { turns: 1, latency_ms: current.latencyMs ?? 1000 },
      },
    ],
    summary: {
      total: 1,
      passed: currentVerdict === Verdict.Pass ? 1 : 0,
      failed: currentVerdict === Verdict.Fail ? 1 : 0,
      needsReview: currentVerdict === Verdict.NeedsReview ? 1 : 0,
      errors: currentVerdict === Verdict.Error ? 1 : 0,
    },
  };

  await writeFile(join(historyDir, "runs", "base-run.json"), JSON.stringify(baseRun));
  await writeFile(join(historyDir, "runs", "current-run.json"), JSON.stringify(currentRun));
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

    try {
      await writeCompareRuns(historyDir, { verdict: Verdict.Fail, latencyMs: 1600 });

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

  it("exits with a distinct code and does not report a regression when targets have a hard mismatch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pupil-compare-target-"));
    const historyDir = join(dir, "history");

    try {
      await mkdir(join(historyDir, "runs"), { recursive: true });
      const baseRun: RunResult = {
        ...runResult("base-run", Verdict.Pass),
        target: { mode: "driven", fixtureSet: "stubbed" },
      };
      const currentRun: RunResult = {
        ...runResult("current-run", Verdict.Fail),
        target: { mode: "observed" },
      };
      await writeFile(join(historyDir, "runs", "base-run.json"), JSON.stringify(baseRun));
      await writeFile(join(historyDir, "runs", "current-run.json"), JSON.stringify(currentRun));

      const result = spawnSync(
        process.execPath,
        [cliPath, "compare", "base-run", "current-run", "--history-dir", historyDir],
        { encoding: "utf-8" },
      );

      expect(result.status).toBe(2);
      expect(result.stdout).toContain("⚠ Comparison may be invalid");
      expect(result.stdout).toContain("mode: driven");
      expect(result.stdout).toContain("mode: observed");
      expect(result.stdout).toContain("fixtureSet: stubbed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15000);

  it("uses the default latency percentage band for compare", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pupil-compare-default-"));
    const historyDir = join(dir, "history");

    try {
      await writeCompareRuns(historyDir, { latencyMs: 1001 });

      const result = spawnSync(
        process.execPath,
        [cliPath, "compare", "base-run", "current-run", "--history-dir", historyDir],
        { encoding: "utf-8" },
      );

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("metric_regressions=0");
      expect(result.stdout).toContain("UNCHANGED scenario-1: pass -> pass");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15000);

  it("allows compare to use an explicit latency percentage threshold", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pupil-compare-pct-"));
    const historyDir = join(dir, "history");

    try {
      await writeCompareRuns(historyDir, { latencyMs: 1011 });

      const result = spawnSync(
        process.execPath,
        [
          cliPath,
          "compare",
          "base-run",
          "current-run",
          "--history-dir",
          historyDir,
          "--latency-threshold-pct",
          "1",
        ],
        { encoding: "utf-8" },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("metric_regressions=1");
      expect(result.stdout).toContain("latency_ms increased by 11 beyond threshold 10");
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

  it("prints machine-readable JSON on stdout under --json, with progress on stderr", async () => {
    const mock = createIrisMockAgent({ port: 0, rules: [{ match: "hello", reply: "online" }] });
    const address = await mock.listen();
    const dir = await mkdtemp(join(tmpdir(), "pupil-run-"));
    const scenarioPath = join(dir, "scenario.yaml");
    const historyDir = join(dir, "history");

    try {
      await writeFile(
        scenarioPath,
        [
          "id: cli-run-json",
          "name: CLI run json",
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
          "--json",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      const output = await waitForCli(child);

      expect(output.code).toBe(0);
      expect(output.stderr).toContain("START cli-run-json");
      expect(output.stderr).toContain("PASS cli-run-json");
      expect(output.stdout).not.toContain("START");

      const parsed = JSON.parse(output.stdout);
      expect(parsed).toMatchObject({
        verdict: "pass",
        strict: false,
        scenarios: [{ scenarioId: "cli-run-json", verdict: "pass" }],
      });
      expect(parsed.historyPath).toContain(historyDir);
    } finally {
      await mock.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 15000);

  it("fails under --strict when the verdict is needs_review, and not otherwise", async () => {
    const mock = createIrisMockAgent({ port: 0, rules: [{ match: "hello", reply: "online" }] });
    const address = await mock.listen();
    const dir = await mkdtemp(join(tmpdir(), "pupil-run-"));
    const scenarioPath = join(dir, "scenario.yaml");
    const historyDir = join(dir, "history");

    try {
      await writeFile(
        scenarioPath,
        [
          "id: cli-run-strict",
          "name: CLI run strict",
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

      const lenient = await waitForCli(
        spawn(
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
        ),
      );
      expect(lenient.code).toBe(0);
      expect(lenient.stdout).toContain("REVIEW cli-run-strict");

      const strict = await waitForCli(
        spawn(
          process.execPath,
          [
            cliPath,
            "run",
            scenarioPath,
            "--base-url",
            `http://${address.host}:${address.port}`,
            "--origin-thread-ts",
            "thread-2",
            "--history-dir",
            historyDir,
            "--strict",
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        ),
      );
      expect(strict.code).toBe(1);
      expect(strict.stdout).toContain("REVIEW cli-run-strict");
    } finally {
      await mock.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 15000);

  it("writes a JUnit XML report under --junit", async () => {
    const mock = createIrisMockAgent({ port: 0, rules: [{ match: "hello", reply: "online" }] });
    const address = await mock.listen();
    const dir = await mkdtemp(join(tmpdir(), "pupil-run-"));
    const scenarioPath = join(dir, "scenario.yaml");
    const historyDir = join(dir, "history");
    const junitPath = join(dir, "junit.xml");

    try {
      await writeFile(
        scenarioPath,
        [
          "id: cli-run-junit",
          "name: CLI run junit",
          "driver:",
          "  type: rest",
          "  preset: iris-http",
          "input: hello",
          "",
        ].join("\n"),
      );

      const output = await waitForCli(
        spawn(
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
            "--junit",
            junitPath,
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        ),
      );
      expect(output.code).toBe(0);

      const xml = await readFile(junitPath, "utf-8");
      expect(xml).toContain('<testsuite name="pupil" tests="1" failures="0" errors="0"');
      expect(xml).toContain('<testcase name="cli-run-junit"');
    } finally {
      await mock.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 15000);

  it("run --baseline skips comparison with no baseline set, then gates on regression once one is", async () => {
    const mock = createIrisMockAgent({
      port: 0,
      rules: [{ match: "hello", reply: "online" }],
    });
    const address = await mock.listen();
    const dir = await mkdtemp(join(tmpdir(), "pupil-run-"));
    const scenarioPath = join(dir, "scenario.yaml");
    const historyDir = join(dir, "history");
    const baseUrl = `http://${address.host}:${address.port}`;

    try {
      await writeFile(
        scenarioPath,
        [
          "id: cli-run-baseline",
          "name: CLI run baseline",
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

      const first = await waitForCli(
        spawn(
          process.execPath,
          [
            cliPath,
            "run",
            scenarioPath,
            "--base-url",
            baseUrl,
            "--origin-thread-ts",
            "thread-1",
            "--history-dir",
            historyDir,
            "--baseline",
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        ),
      );
      expect(first.code).toBe(0);
      expect(first.stderr).toContain("no baseline run is set");
      const firstRunId = /Run ([^:]+):/.exec(first.stdout)?.[1];
      expect(firstRunId).toBeDefined();

      const setBaseline = spawnSync(
        process.execPath,
        [cliPath, "baseline", firstRunId as string, "--history-dir", historyDir],
        { encoding: "utf-8" },
      );
      expect(setBaseline.status).toBe(0);

      await mock.close();
      const failingMock = createIrisMockAgent({
        port: address.port,
        rules: [{ match: "hello", reply: "offline" }],
      });
      await failingMock.listen();

      try {
        const second = await waitForCli(
          spawn(
            process.execPath,
            [
              cliPath,
              "run",
              scenarioPath,
              "--base-url",
              baseUrl,
              "--origin-thread-ts",
              "thread-2",
              "--history-dir",
              historyDir,
              "--baseline",
              "--json",
            ],
            { stdio: ["ignore", "pipe", "pipe"] },
          ),
        );
        expect(second.code).toBe(1);
        const parsed = JSON.parse(second.stdout);
        expect(parsed.baseline).toMatchObject({ baseRunId: firstRunId, hasRegressions: true });
      } finally {
        await failingMock.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20000);

  it("warns on stderr and reports status not_set when --baseline finds no baseline", async () => {
    const mock = createIrisMockAgent({ port: 0, rules: [{ match: "hello", reply: "online" }] });
    const address = await mock.listen();
    const dir = await mkdtemp(join(tmpdir(), "pupil-run-"));
    const scenarioPath = join(dir, "scenario.yaml");
    const historyDir = join(dir, "history");

    try {
      await writeFile(
        scenarioPath,
        [
          "id: cli-run-no-baseline",
          "name: CLI run no baseline",
          "driver:",
          "  type: rest",
          "  preset: iris-http",
          "input: hello",
          "",
        ].join("\n"),
      );

      const output = await waitForCli(
        spawn(
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
            "--baseline",
            "--json",
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        ),
      );

      expect(output.code).toBe(0);
      expect(output.stderr).toContain("no baseline run is set");

      const payload = JSON.parse(output.stdout) as { baseline?: { status: string } };
      expect(payload.baseline).toEqual({ status: "not_set" });
    } finally {
      await mock.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 15000);

  it("appends a run summary to $GITHUB_STEP_SUMMARY when it is set", async () => {
    const mock = createIrisMockAgent({ port: 0, rules: [{ match: "hello", reply: "online" }] });
    const address = await mock.listen();
    const dir = await mkdtemp(join(tmpdir(), "pupil-run-"));
    const scenarioPath = join(dir, "scenario.yaml");
    const historyDir = join(dir, "history");
    const summaryPath = join(dir, "step-summary.md");
    await writeFile(summaryPath, "");

    try {
      await writeFile(
        scenarioPath,
        [
          "id: cli-run-summary",
          "name: CLI run summary",
          "driver:",
          "  type: rest",
          "  preset: iris-http",
          "input: hello",
          "",
        ].join("\n"),
      );

      const output = await waitForCli(
        spawn(
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
          {
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, GITHUB_STEP_SUMMARY: summaryPath },
          },
        ),
      );
      expect(output.code).toBe(0);

      const summary = await readFile(summaryPath, "utf-8");
      expect(summary).toContain("## Pupil run `");
      expect(summary).toContain("**Verdict:** pass");
    } finally {
      await mock.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 15000);

  it("creates missing parent directories for the --junit report path", async () => {
    const mock = createIrisMockAgent({ port: 0, rules: [{ match: "hello", reply: "online" }] });
    const address = await mock.listen();
    const dir = await mkdtemp(join(tmpdir(), "pupil-run-"));
    const scenarioPath = join(dir, "scenario.yaml");
    const historyDir = join(dir, "history");
    const junitPath = join(dir, "reports", "nested", "junit.xml");

    try {
      await writeFile(
        scenarioPath,
        [
          "id: cli-run-junit-nested",
          "name: CLI run junit nested",
          "driver:",
          "  type: rest",
          "  preset: iris-http",
          "input: hello",
          "",
        ].join("\n"),
      );

      const output = await waitForCli(
        spawn(
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
            "--junit",
            junitPath,
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        ),
      );

      expect(output.code).toBe(0);
      expect(await readFile(junitPath, "utf-8")).toContain('<testsuite name="pupil"');
    } finally {
      await mock.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 15000);

  it("warns but still succeeds when the step summary path is unwritable", async () => {
    const mock = createIrisMockAgent({ port: 0, rules: [{ match: "hello", reply: "online" }] });
    const address = await mock.listen();
    const dir = await mkdtemp(join(tmpdir(), "pupil-run-"));
    const scenarioPath = join(dir, "scenario.yaml");
    const historyDir = join(dir, "history");

    try {
      await writeFile(
        scenarioPath,
        [
          "id: cli-run-summary-failure",
          "name: CLI run summary failure",
          "driver:",
          "  type: rest",
          "  preset: iris-http",
          "input: hello",
          "",
        ].join("\n"),
      );

      const output = await waitForCli(
        spawn(
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
          {
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, GITHUB_STEP_SUMMARY: join(dir, "missing", "summary.md") },
          },
        ),
      );

      expect(output.code).toBe(0);
      expect(output.stderr).toContain("failed to write the GitHub step summary");
    } finally {
      await mock.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 15000);

  it("accepts an explicit --config path on run", async () => {
    const mock = createIrisMockAgent({ port: 0, rules: [{ match: "hello", reply: "online" }] });
    const address = await mock.listen();
    const dir = await mkdtemp(join(tmpdir(), "pupil-run-"));
    const scenarioPath = join(dir, "scenario.yaml");
    const configPath = join(dir, "custom.config.yaml");
    const historyDir = join(dir, "history");

    try {
      await writeFile(
        scenarioPath,
        [
          "id: cli-run-config",
          "name: CLI run config",
          "driver:",
          "  type: rest",
          "  preset: iris-http",
          "input: hello",
          "",
        ].join("\n"),
      );
      await writeFile(
        configPath,
        ["scenarios: examples/scenarios", "compare:", "  latencyThresholdPct: 50", ""].join("\n"),
      );

      const output = await waitForCli(
        spawn(
          process.execPath,
          [
            cliPath,
            "run",
            scenarioPath,
            "--config",
            configPath,
            "--base-url",
            `http://${address.host}:${address.port}`,
            "--origin-thread-ts",
            "thread-1",
            "--history-dir",
            historyDir,
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        ),
      );

      expect(output.code).toBe(0);
      expect(output.stderr).not.toContain("unknown option");
    } finally {
      await mock.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 15000);

  it("applies the config compare threshold when gating compare", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pupil-compare-"));
    const historyDir = join(dir, "history");
    const configPath = join(dir, "custom.config.yaml");

    try {
      await writeCompareRuns(historyDir, { latencyMs: 1500 });
      await writeFile(
        configPath,
        ["scenarios: examples/scenarios", "compare:", "  latencyThresholdPct: 100", ""].join("\n"),
      );

      const tolerant = await waitForCli(
        spawn(
          process.execPath,
          [
            cliPath,
            "compare",
            "base-run",
            "current-run",
            "--history-dir",
            historyDir,
            "--config",
            configPath,
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        ),
      );

      expect(tolerant.code).toBe(0);
      expect(tolerant.stdout).not.toContain("REGRESSION");

      const strictConfig = join(dir, "strict.config.yaml");
      await writeFile(
        strictConfig,
        ["scenarios: examples/scenarios", "compare:", "  latencyThresholdPct: 10", ""].join("\n"),
      );

      const strict = await waitForCli(
        spawn(
          process.execPath,
          [
            cliPath,
            "compare",
            "base-run",
            "current-run",
            "--history-dir",
            historyDir,
            "--config",
            strictConfig,
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        ),
      );

      expect(strict.code).toBe(1);
      expect(strict.stdout).toContain("REGRESSION");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15000);

  it("applies the config compare threshold when gating run --baseline", async () => {
    // A slow baseline lets the mock agent's response delay push the current
    // run's measured latency comfortably past a strict threshold while
    // staying comfortably under a tolerant one, regardless of scheduling
    // jitter in the child process.
    const mock = createIrisMockAgent({
      port: 0,
      rules: [{ match: "hello", reply: "online" }],
      defaultDelayMs: 500,
    });
    const address = await mock.listen();
    const dir = await mkdtemp(join(tmpdir(), "pupil-run-baseline-config-"));
    const scenarioPath = join(dir, "scenario.yaml");
    const historyDir = join(dir, "history");
    const tolerantConfigPath = join(dir, "tolerant.config.yaml");
    const strictConfigPath = join(dir, "strict.config.yaml");
    const baseUrl = `http://${address.host}:${address.port}`;

    try {
      await writeFile(
        scenarioPath,
        [
          "id: cli-run-baseline-config",
          "name: CLI run baseline config",
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
      await writeFile(
        tolerantConfigPath,
        ["scenarios: examples/scenarios", "compare:", "  latencyThresholdPct: 2000", ""].join("\n"),
      );
      await writeFile(
        strictConfigPath,
        ["scenarios: examples/scenarios", "compare:", "  latencyThresholdPct: 5", ""].join("\n"),
      );

      const store = new JsonRunHistoryStore({ dir: historyDir });
      const baselineRun: RunResult = {
        runId: "baseline-run",
        verdict: Verdict.Pass,
        results: [
          {
            scenarioId: "cli-run-baseline-config",
            scenarioName: "CLI run baseline config",
            verdict: Verdict.Pass,
            scores: [
              {
                name: "assertion:contains:response.text",
                verdict: Verdict.Pass,
                reason: "Expected response.text to contain online",
                metadata: {},
              },
            ],
            turns: [],
            startedAt: "2026-07-27T00:00:00.000Z",
            completedAt: "2026-07-27T00:00:00.050Z",
            metrics: { turns: 1, latency_ms: 50 },
          },
        ],
        startedAt: "2026-07-27T00:00:00.000Z",
        completedAt: "2026-07-27T00:00:00.050Z",
        summary: { total: 1, passed: 1, failed: 0, needsReview: 0, errors: 0 },
        metadata: {},
      };
      await store.writeRun(baselineRun);
      await store.setBaseline("baseline-run");

      const tolerant = await waitForCli(
        spawn(
          process.execPath,
          [
            cliPath,
            "run",
            scenarioPath,
            "--base-url",
            baseUrl,
            "--origin-thread-ts",
            "thread-1",
            "--history-dir",
            historyDir,
            "--config",
            tolerantConfigPath,
            "--baseline",
            "--json",
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        ),
      );

      expect(tolerant.code).toBe(0);
      const tolerantPayload = JSON.parse(tolerant.stdout) as {
        baseline?: { status: string; hasRegressions?: boolean };
      };
      expect(tolerantPayload.baseline).toMatchObject({ status: "compared", hasRegressions: false });

      const strict = await waitForCli(
        spawn(
          process.execPath,
          [
            cliPath,
            "run",
            scenarioPath,
            "--base-url",
            baseUrl,
            "--origin-thread-ts",
            "thread-2",
            "--history-dir",
            historyDir,
            "--config",
            strictConfigPath,
            "--baseline",
            "--json",
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        ),
      );

      expect(strict.code).toBe(1);
      const strictPayload = JSON.parse(strict.stdout) as {
        baseline?: { status: string; hasRegressions?: boolean };
      };
      expect(strictPayload.baseline).toMatchObject({ status: "compared", hasRegressions: true });
    } finally {
      await mock.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 15000);
});

describe("run command target flags", () => {
  it("passes target from CLI flags to runScenarios", async () => {
    const mock = createIrisMockAgent({ port: 0 });
    const address = await mock.listen();
    const scenarioDir = await mkdtemp(join(tmpdir(), "pupil-target-scenario-"));
    const historyDir = await mkdtemp(join(tmpdir(), "pupil-target-history-"));
    const scenarioPath = join(scenarioDir, "scenario.yaml");

    try {
      await writeFile(scenarioPath, minimalScenarioYaml);
      await program.parseAsync([
        "node",
        "pupil",
        "run",
        "--base-url",
        `http://${address.host}:${address.port}`,
        "--history-dir",
        historyDir,
        "--system",
        "support-agent",
        "--environment",
        "staging",
        "--target-version",
        "abc1234",
        "--fixture-set",
        "live",
        "--no-langfuse",
        scenarioPath,
      ]);
    } finally {
      await mock.close();
      await rm(scenarioDir, { recursive: true, force: true });
    }

    const store = new JsonRunHistoryStore({ dir: historyDir });
    const [entry] = await store.listRuns();
    const stored = await store.readRun(entry.runId);
    await rm(historyDir, { recursive: true, force: true });

    expect(stored.target).toMatchObject({
      system: "support-agent",
      environment: "staging",
      version: "abc1234",
      fixtureSet: "live",
      mode: "driven",
    });
  }, 15000);

  it("pupil run always stamps mode: driven, with no --mode flag available", async () => {
    const mock = createIrisMockAgent({ port: 0 });
    const address = await mock.listen();
    const historyDir = await mkdtemp(join(tmpdir(), "pupil-history-"));
    const scenarioDir = await mkdtemp(join(tmpdir(), "pupil-scenario-"));
    const scenarioPath = join(scenarioDir, "scenario.yaml");
    await writeFile(scenarioPath, minimalScenarioYaml);

    try {
      await program.parseAsync([
        "node",
        "pupil",
        "run",
        "--base-url",
        `http://${address.host}:${address.port}`,
        "--history-dir",
        historyDir,
        "--no-langfuse",
        scenarioPath,
      ]);
    } finally {
      await mock.close();
      await rm(scenarioDir, { recursive: true, force: true });
    }

    const store = new JsonRunHistoryStore({ dir: historyDir });
    const [entry] = await store.listRuns();
    const stored = await store.readRun(entry.runId);
    await rm(historyDir, { recursive: true, force: true });

    expect(stored.target?.mode).toBe("driven");
  }, 15000);

  it("CLI flags override config.target fields (flags win)", async () => {
    const mock = createIrisMockAgent({ port: 0 });
    const address = await mock.listen();
    const historyDir = await mkdtemp(join(tmpdir(), "pupil-history-"));
    const configDir = await mkdtemp(join(tmpdir(), "pupil-cfg-"));
    const scenarioPath = join(configDir, "scenario.yaml");

    await writeFile(
      join(configDir, "pupil.config.yaml"),
      ["target:", "  system: support-agent", "  environment: staging"].join("\n"),
    );
    await writeFile(scenarioPath, minimalScenarioYaml);

    const originalCwd = process.cwd();
    process.chdir(configDir);
    try {
      await program.parseAsync([
        "node",
        "pupil",
        "run",
        "--base-url",
        `http://${address.host}:${address.port}`,
        "--history-dir",
        historyDir,
        "--environment",
        "production",
        "--no-langfuse",
        scenarioPath,
      ]);
    } finally {
      process.chdir(originalCwd);
      await mock.close();
    }

    const store = new JsonRunHistoryStore({ dir: historyDir });
    const [entry] = await store.listRuns();
    const stored = await store.readRun(entry.runId);

    expect(stored.target).toMatchObject({
      system: "support-agent",
      environment: "production",
      mode: "driven",
    });
  }, 15000);
});

describe("report command target output", () => {
  it("prints target fields when present", async () => {
    const historyDir = await mkdtemp(join(tmpdir(), "pupil-report-target-"));
    const store = new JsonRunHistoryStore({ dir: historyDir });

    const fakeRun: RunResult = {
      runId: "target-run",
      verdict: Verdict.Pass,
      results: [],
      startedAt: "2026-08-06T10:00:00.000Z",
      completedAt: "2026-08-06T10:01:00.000Z",
      summary: { total: 0, passed: 0, failed: 0, needsReview: 0, errors: 0 },
      metadata: {},
      target: {
        system: "support-agent",
        environment: "staging",
        version: "v2.3.1",
        mode: "driven",
        fixtureSet: "live",
      },
    };
    await store.writeRun(fakeRun);

    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => lines.push(args.join(" "));
    try {
      await program.parseAsync([
        "node",
        "pupil",
        "report",
        "target-run",
        "--history-dir",
        historyDir,
      ]);
    } finally {
      console.log = origLog;
    }

    expect(lines.join("\n")).toContain(
      "Target: system=support-agent environment=staging version=v2.3.1 mode=driven fixtureSet=live",
    );
  });

  it("omits target line when run has no target", async () => {
    const historyDir = await mkdtemp(join(tmpdir(), "pupil-report-notarget-"));
    const store = new JsonRunHistoryStore({ dir: historyDir });

    const fakeRun: RunResult = {
      runId: "no-target-run",
      verdict: Verdict.Pass,
      results: [],
      startedAt: "2026-08-06T10:00:00.000Z",
      completedAt: "2026-08-06T10:01:00.000Z",
      summary: { total: 0, passed: 0, failed: 0, needsReview: 0, errors: 0 },
      metadata: {},
    };
    await store.writeRun(fakeRun);

    const lines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => lines.push(args.join(" "));
    try {
      await program.parseAsync([
        "node",
        "pupil",
        "report",
        "no-target-run",
        "--history-dir",
        historyDir,
      ]);
    } finally {
      console.log = origLog;
    }

    expect(lines.join("\n")).not.toContain("Target:");
  });
});
