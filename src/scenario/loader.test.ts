import { mkdtemp, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { discoverScenarioFiles, loadScenarios } from "./loader.js";

let tmpRoot: string | undefined;

afterEach(async () => {
  if (tmpRoot) {
    await rm(tmpRoot, { recursive: true, force: true });
    tmpRoot = undefined;
  }
});

describe("scenario loader", () => {
  it("loads valid fixture scenarios recursively in stable id order", async () => {
    const fixtureRoot = resolve("src/scenario/__fixtures__/valid");

    const scenarios = await loadScenarios(fixtureRoot);

    expect(scenarios.map((scenario) => scenario.id)).toEqual(["a-multi-turn", "z-shorthand"]);
    expect(scenarios[0]?.tags).toEqual(["regression"]);
    expect(scenarios[0]?.metadata).toEqual({ owner: "irisflow" });
    expect(scenarios[0]?.turns).toHaveLength(2);
    expect(scenarios[1]?.tags).toEqual(["smoke", "shorthand"]);
    expect(scenarios[1]?.metadata).toEqual({ owner: "pupil" });
    expect(scenarios[1]?.turns).toEqual([{ user: "Hello from shorthand.", expect: [] }]);
  });

  it("fails invalid fixture scenarios with actionable file and path context", async () => {
    const fixtureRoot = resolve("src/scenario/__fixtures__/invalid");

    await expect(loadScenarios(fixtureRoot)).rejects.toThrow(/missing-id\.yaml:id:/);
  });
  it("discovers YAML recursively in stable order", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "pupil-loader-"));
    await mkdir(join(tmpRoot, "nested"));
    await writeFile(join(tmpRoot, "b.yaml"), "id: b\ninput: hello\n");
    await writeFile(join(tmpRoot, "nested", "a.yml"), "id: a\ninput: hello\n");
    await writeFile(join(tmpRoot, "ignore.txt"), "nope\n");

    const files = await discoverScenarioFiles(tmpRoot);
    expect(files.map((file) => file.replaceAll("\\", "/"))).toEqual([
      `${tmpRoot.replaceAll("\\", "/")}/b.yaml`,
      `${tmpRoot.replaceAll("\\", "/")}/nested/a.yml`,
    ]);

    const scenarios = await loadScenarios(tmpRoot);
    expect(scenarios.map((scenario) => scenario.id)).toEqual(["a", "b"]);
  });

  it("fails invalid scenario layouts", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "pupil-loader-"));
    await writeFile(join(tmpRoot, "bad.yaml"), "name: Bad\ninput: hello\n");

    await expect(loadScenarios(tmpRoot)).rejects.toThrow(/bad\.yaml:id:/);
  });

  it("rejects duplicate scenario ids across nested folders with both files in the error", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "pupil-loader-"));
    await mkdir(join(tmpRoot, "nested"));
    await writeFile(join(tmpRoot, "one.yaml"), "id: duplicate\ninput: hello\n");
    await writeFile(join(tmpRoot, "nested", "two.yaml"), "id: duplicate\ninput: hello again\n");

    await expect(loadScenarios(tmpRoot)).rejects.toThrow(/Duplicate scenario id "duplicate"/);
    await expect(loadScenarios(tmpRoot)).rejects.toThrow(/one\.yaml/);
    await expect(loadScenarios(tmpRoot)).rejects.toThrow(/two\.yaml/);
  });
  it("does not loop forever on a symlinked directory cycle", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "pupil-loader-"));
    await mkdir(join(tmpRoot, "nested"));
    await writeFile(join(tmpRoot, "nested", "a.yaml"), "id: a\ninput: hello\n");
    await symlink(tmpRoot, join(tmpRoot, "nested", "loop"), "dir");

    const files = await discoverScenarioFiles(tmpRoot);
    expect(files.map((file) => file.replaceAll("\\", "/"))).toEqual([
      `${tmpRoot.replaceAll("\\", "/")}/nested/a.yaml`,
    ]);
  });
});
