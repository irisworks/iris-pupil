import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        return listFiles(path);
      }
      return [path];
    }),
  );

  return files.flat();
}

describe("build output", () => {
  it("does not compile test files into dist", async () => {
    const files = await listFiles(join(process.cwd(), "dist"));
    const compiledTests = files
      .map((file) => relative(process.cwd(), file).replaceAll("\\", "/"))
      .filter((file) => /\.test\.(js|d\.ts|js\.map)$/.test(file));

    expect(compiledTests).toEqual([]);
  });
});
