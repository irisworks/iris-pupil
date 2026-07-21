import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createIrisMockAgent } from "../mock/irisMockAgent.js";

const cliPath = join(process.cwd(), "dist", "cli", "index.js");

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

  it("runs a scenario end to end against the mock agent", async () => {
    const mock = createIrisMockAgent({
      port: 0,
      rules: [{ match: "hello", reply: "online" }],
    });
    const address = await mock.listen();
    const dir = await mkdtemp(join(tmpdir(), "pupil-run-"));
    const scenarioPath = join(dir, "scenario.yaml");

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
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      child.stdout.setEncoding("utf-8");
      child.stderr.setEncoding("utf-8");

      const output = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
        (resolve, reject) => {
          let stdout = "";
          let stderr = "";
          const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`pupil run did not finish. stderr: ${stderr}`));
          }, 10000);

          child.stdout.on("data", (chunk: string) => {
            stdout += chunk;
          });
          child.stderr.on("data", (chunk: string) => {
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
        },
      );

      expect(output.code).toBe(0);
      expect(output.stderr).toBe("");
      expect(output.stdout).toContain("START cli-run");
      expect(output.stdout).toContain("PASS cli-run");
      expect(output.stdout).toContain("Run ");
    } finally {
      await mock.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("starts mock-agent as a standalone server", async () => {
    const child = spawn(process.execPath, [cliPath, "mock-agent", "--port", "0"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      const output = await new Promise<string>((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
          reject(new Error(`mock-agent did not start. stderr: ${stderr}`));
        }, 10000);

        child.stdout.setEncoding("utf-8");
        child.stderr.setEncoding("utf-8");
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
          if (stdout.includes("IRIS mock agent listening")) {
            clearTimeout(timer);
            resolve(stdout);
          }
        });
        child.stderr.on("data", (chunk: string) => {
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
