import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadPupilConfig } from "./config.js";

let tmpRoot: string | undefined;

afterEach(async () => {
  if (tmpRoot) {
    await rm(tmpRoot, { recursive: true, force: true });
    tmpRoot = undefined;
  }
});

describe("loadPupilConfig", () => {
  it("returns defaults when no config file exists", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "pupil-config-"));

    await expect(loadPupilConfig({ cwd: tmpRoot })).resolves.toEqual({
      scenarios: "examples/scenarios",
      driver: { type: "rest", config: {} },
      history: { dir: ".pupil" },
      langfuse: { enabled: "auto" },
    });
  });

  it("fails when an explicit config path does not exist", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "pupil-config-"));

    await expect(loadPupilConfig({ cwd: tmpRoot, configPath: "missing.yaml" })).rejects.toThrow(
      /Pupil config file does not exist: .*missing\.yaml/,
    );
  });
  it("accepts the full langfuse block, including waitMs, timeoutMs, and initialDelayMs", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "pupil-config-"));
    await writeFile(
      join(tmpRoot, "pupil.config.yaml"),
      "driver:\n  config:\n    baseUrl: http://localhost:5050\nlangfuse:\n  host: http://langfuse.local\n  publicKey: pk\n  secretKey: sk\n  waitMs: 30000\n  timeoutMs: 15000\n  initialDelayMs: 8000\n",
    );

    const config = await loadPupilConfig({ cwd: tmpRoot });

    expect(config.langfuse).toEqual({
      enabled: "auto",
      host: "http://langfuse.local",
      publicKey: "pk",
      secretKey: "sk",
      waitMs: 30000,
      timeoutMs: 15000,
      initialDelayMs: 8000,
    });
  });

  it("loads config and resolves environment references", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "pupil-config-"));
    await writeFile(
      join(tmpRoot, "pupil.config.yaml"),
      `scenarios: scenarios\ndriver:\n  type: rest\n  preset: iris-http\n  config:\n    baseUrl: \${IRIS_BASE_URL}\n    token: \${IRIS_TOKEN:-}\nhistory:\n  dir: .pupil-test\n`,
    );

    const config = await loadPupilConfig({
      cwd: tmpRoot,
      env: { IRIS_BASE_URL: "http://127.0.0.1:3000" },
    });

    expect(config.driver).toEqual({
      type: "rest",
      preset: "iris-http",
      config: { baseUrl: "http://127.0.0.1:3000", token: "" },
    });
    expect(config.history.dir).toBe(".pupil-test");
  });

  it("substitutes a set-but-empty value for plain ${VAR}, matching bash", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "pupil-config-"));
    await writeFile(
      join(tmpRoot, "pupil.config.yaml"),
      "driver:\n  config:\n    baseUrl: ${IRIS_BASE_URL}\n",
    );

    const config = await loadPupilConfig({ cwd: tmpRoot, env: { IRIS_BASE_URL: "" } });

    expect(config.driver.config.baseUrl).toBe("");
  });

  it("still falls back for ${VAR:-fallback} when VAR is set but empty", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "pupil-config-"));
    await writeFile(
      join(tmpRoot, "pupil.config.yaml"),
      "driver:\n  config:\n    baseUrl: ${IRIS_BASE_URL:-http://127.0.0.1:3000}\n",
    );

    const config = await loadPupilConfig({ cwd: tmpRoot, env: { IRIS_BASE_URL: "" } });

    expect(config.driver.config.baseUrl).toBe("http://127.0.0.1:3000");
  });

  it("fails with file and path context for missing env vars", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "pupil-config-"));
    await writeFile(
      join(tmpRoot, "pupil.config.yaml"),
      "driver:\n  config:\n    baseUrl: ${MISSING_URL}\n",
    );

    await expect(loadPupilConfig({ cwd: tmpRoot, env: {} })).rejects.toThrow(
      /pupil\.config\.yaml:driver\.config\.baseUrl/,
    );
  });

  it("fails invalid YAML with config file context", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "pupil-config-"));
    await writeFile(join(tmpRoot, "pupil.config.yaml"), "driver:\n  type: [rest\n");

    await expect(loadPupilConfig({ cwd: tmpRoot })).rejects.toThrow(
      /Invalid YAML in .*pupil\.config\.yaml/,
    );
  });

  it("rejects unknown config fields with path context", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "pupil-config-"));
    await writeFile(join(tmpRoot, "pupil.config.yaml"), "randomThing: true\n");

    await expect(loadPupilConfig({ cwd: tmpRoot })).rejects.toThrow(
      /pupil\.config\.yaml:<root>: Unrecognized key\(s\) in object: 'randomThing'/,
    );
  });

  it("rejects unknown nested config fields with path context", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "pupil-config-"));
    await writeFile(
      join(tmpRoot, "pupil.config.yaml"),
      "driver:\n  presett: iris-http\nlangfuse:\n  hostt: http://localhost:3000\n",
    );

    await expect(loadPupilConfig({ cwd: tmpRoot })).rejects.toThrow(
      /pupil\.config\.yaml:driver: Unrecognized key\(s\) in object: 'presett'/,
    );
  });
});
