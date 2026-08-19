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
      requireTrace: false,
      driver: { type: "rest", config: {} },
      history: { dir: ".pupil" },
      langfuse: { enabled: "auto" },
      target: {},
      compare: {},
      profiles: {},
    });
  });

  it("reads requireTrace from the config file", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "pupil-config-"));
    await writeFile(
      join(tmpRoot, "pupil.config.yaml"),
      "scenarios: examples/scenarios\nrequireTrace: true\n",
      "utf8",
    );

    const config = await loadPupilConfig({ cwd: tmpRoot });

    expect(config.requireTrace).toBe(true);
  });

  it("lets an environment profile turn requireTrace on", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "pupil-config-"));
    await writeFile(
      join(tmpRoot, "pupil.config.yaml"),
      [
        "scenarios: examples/scenarios",
        "requireTrace: false",
        "profiles:",
        "  staging:",
        "    requireTrace: true",
        "",
      ].join("\n"),
      "utf8",
    );

    await expect(loadPupilConfig({ cwd: tmpRoot })).resolves.toMatchObject({
      requireTrace: false,
    });
    await expect(loadPupilConfig({ cwd: tmpRoot, profile: "staging" })).resolves.toMatchObject({
      requireTrace: true,
    });
  });

  it("lets a profile's requireTrace be a ${VAR:-default} template", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "pupil-config-"));
    await writeFile(
      join(tmpRoot, "pupil.config.yaml"),
      [
        "scenarios: examples/scenarios",
        "profiles:",
        "  ci:",
        "    requireTrace: ${PUPIL_REQUIRE_TRACE:-false}",
        "",
      ].join("\n"),
      "utf8",
    );

    await expect(loadPupilConfig({ cwd: tmpRoot, profile: "ci", env: {} })).resolves.toMatchObject({
      requireTrace: false,
    });
    await expect(
      loadPupilConfig({ cwd: tmpRoot, profile: "ci", env: { PUPIL_REQUIRE_TRACE: "true" } }),
    ).resolves.toMatchObject({ requireTrace: true });
  });

  it("resolves an unresolved ${VAR:-false} template for requireTrace to false, not true", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "pupil-config-"));
    await writeFile(
      join(tmpRoot, "pupil.config.yaml"),
      "scenarios: examples/scenarios\nrequireTrace: ${PUPIL_REQUIRE_TRACE:-false}\n",
      "utf8",
    );

    const config = await loadPupilConfig({ cwd: tmpRoot, env: {} });

    expect(config.requireTrace).toBe(false);
  });

  it("resolves a ${VAR:-false} template for requireTrace to true when the env var is set to true", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "pupil-config-"));
    await writeFile(
      join(tmpRoot, "pupil.config.yaml"),
      "scenarios: examples/scenarios\nrequireTrace: ${PUPIL_REQUIRE_TRACE:-false}\n",
      "utf8",
    );

    const config = await loadPupilConfig({
      cwd: tmpRoot,
      env: { PUPIL_REQUIRE_TRACE: "true" },
    });

    expect(config.requireTrace).toBe(true);
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

  it("applies a selected profile after resolving only the effective config", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "pupil-config-"));
    await writeFile(
      join(tmpRoot, "pupil.config.yaml"),
      [
        "driver:",
        "  preset: iris-http",
        "  config:",
        "    baseUrl: ${LOCAL_URL}",
        "    originChannel: pupil-local",
        "profiles:",
        "  staging:",
        "    driver:",
        "      config:",
        "        baseUrl: ${STAGING_URL}",
        "        originChannel: pupil-staging",
        "  prod:",
        "    driver:",
        "      config:",
        "        baseUrl: ${PROD_URL}",
        "",
      ].join("\n"),
    );

    const config = await loadPupilConfig({
      cwd: tmpRoot,
      profile: "staging",
      env: { STAGING_URL: "https://staging.example.test" },
    });

    expect(config.driver).toMatchObject({
      preset: "iris-http",
      config: {
        baseUrl: "https://staging.example.test",
        originChannel: "pupil-staging",
      },
    });
  });

  it("fails when a selected profile does not exist", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "pupil-config-"));
    await writeFile(
      join(tmpRoot, "pupil.config.yaml"),
      "profiles:\n  local:\n    history:\n      dir: .pupil-local\n",
    );

    await expect(loadPupilConfig({ cwd: tmpRoot, profile: "missing" })).rejects.toThrow(
      /Pupil config profile does not exist: missing/,
    );
  });

  it("accepts ${VAR} templates for numeric fields inside a profile", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "pupil-config-"));
    await writeFile(
      join(tmpRoot, "pupil.config.yaml"),
      [
        "langfuse:",
        "  waitMs: 25000",
        "profiles:",
        "  staging:",
        "    langfuse:",
        "      waitMs: ${STAGING_WAIT_MS:-40000}",
        "      timeoutMs: ${STAGING_TIMEOUT_MS:-9000}",
        "      initialDelayMs: ${STAGING_INITIAL_DELAY_MS:-1500}",
        "    compare:",
        "      latencyThresholdPct: ${STAGING_LATENCY_PCT:-35}",
        "",
      ].join("\n"),
    );

    const config = await loadPupilConfig({ cwd: tmpRoot, profile: "staging", env: {} });

    expect(config.langfuse).toMatchObject({ waitMs: 40000, timeoutMs: 9000, initialDelayMs: 1500 });
    expect(config.compare).toMatchObject({ latencyThresholdPct: 35 });
  });

  it("applies target overrides from a profile", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "pupil-config-"));
    await writeFile(
      join(tmpRoot, "pupil.config.yaml"),
      [
        "target:",
        "  system: support-agent",
        "  environment: local",
        "profiles:",
        "  staging:",
        "    target:",
        "      environment: staging",
        "",
      ].join("\n"),
    );

    const config = await loadPupilConfig({ cwd: tmpRoot, profile: "staging" });

    expect(config.target).toEqual({ system: "support-agent", environment: "staging" });
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

  it("rejects unknown fields inside a profile with a profiles.<name> path", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "pupil-config-"));
    await writeFile(
      join(tmpRoot, "pupil.config.yaml"),
      "profiles:\n  staging:\n    driver:\n      unknownField: nope\n",
    );

    await expect(loadPupilConfig({ cwd: tmpRoot })).rejects.toThrow(
      /pupil\.config\.yaml:profiles\.staging\.driver: Unrecognized key\(s\) in object: 'unknownField'/,
    );
  });

  it("rejects unknown fields in a profile even when it is not selected", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "pupil-config-"));
    await writeFile(join(tmpRoot, "pupil.config.yaml"), "profiles:\n  unused:\n    bogus: true\n");

    await expect(loadPupilConfig({ cwd: tmpRoot })).rejects.toThrow(
      /pupil\.config\.yaml:profiles\.unused: Unrecognized key\(s\) in object: 'bogus'/,
    );
  });
  it("parses a full target block and resolves env refs", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "pupil-config-"));
    await writeFile(
      join(tmpRoot, "pupil.config.yaml"),
      [
        "target:",
        "  system: support-agent",
        "  environment: ${DEPLOY_ENV:-staging}",
        "  version: ${DEPLOY_SHA:-}",
        "  fixtureSet: live",
      ].join("\n"),
    );

    const config = await loadPupilConfig({
      cwd: tmpRoot,
      env: { DEPLOY_ENV: "production", DEPLOY_SHA: "abc1234" },
    });

    expect(config.target).toEqual({
      system: "support-agent",
      environment: "production",
      version: "abc1234",
      fixtureSet: "live",
    });
  });

  it("target defaults to an empty block when absent", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "pupil-config-"));

    const config = await loadPupilConfig({ cwd: tmpRoot });

    expect(config.target).toEqual({});
  });

  it("coerces an empty string in target fields to absent", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "pupil-config-"));
    await writeFile(
      join(tmpRoot, "pupil.config.yaml"),
      'target:\n  system: ""\n  environment: ""\n  version: ""\n  fixtureSet: ""\n',
    );

    const config = await loadPupilConfig({ cwd: tmpRoot });

    expect(config.target).toEqual({});
  });

  it("rejects unknown fields in target block", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "pupil-config-"));
    await writeFile(join(tmpRoot, "pupil.config.yaml"), "target:\n  commit: abc123\n");

    await expect(loadPupilConfig({ cwd: tmpRoot })).rejects.toThrow(/Unrecognized key/);
  });

  it("rejects a mode field in target block", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "pupil-config-"));
    await writeFile(join(tmpRoot, "pupil.config.yaml"), "target:\n  mode: observed\n");

    await expect(loadPupilConfig({ cwd: tmpRoot })).rejects.toThrow(
      /Unrecognized key\(s\) in object: 'mode'/,
    );
  });

  it("parses a compare block with latency and per-metric thresholds", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "pupil-config-"));
    await writeFile(
      join(tmpRoot, "pupil.config.yaml"),
      [
        "scenarios: examples/scenarios",
        "compare:",
        "  latencyThresholdMs: 500",
        "  latencyThresholdPct: 20",
        "  metricThresholds:",
        "    cost_usd: 0.01",
        "",
      ].join("\n"),
    );

    const config = await loadPupilConfig({ cwd: tmpRoot });

    expect(config.compare).toEqual({
      latencyThresholdMs: 500,
      latencyThresholdPct: 20,
      metricThresholds: { cost_usd: 0.01 },
    });
  });

  it("defaults the compare block to an empty object", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "pupil-config-"));
    await writeFile(join(tmpRoot, "pupil.config.yaml"), "scenarios: examples/scenarios\n");

    const config = await loadPupilConfig({ cwd: tmpRoot });

    expect(config.compare).toEqual({});
  });
});
