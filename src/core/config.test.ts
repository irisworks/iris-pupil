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
