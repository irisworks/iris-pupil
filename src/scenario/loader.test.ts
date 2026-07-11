import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
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
});
