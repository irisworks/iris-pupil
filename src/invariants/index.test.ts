import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadInvariantFile } from "./index.js";

let tmpRoot: string | undefined;

afterEach(async () => {
  if (tmpRoot) {
    await rm(tmpRoot, { recursive: true, force: true });
    tmpRoot = undefined;
  }
});

describe("loadInvariantFile", () => {
  it("loads repository policy checks with repo source metadata", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "pupil-invariants-"));
    const file = join(tmpRoot, "invariants.yaml");
    await writeFile(
      file,
      [
        "invariants:",
        "  - assertion:",
        "      type: tool_not_called",
        "      tool: deprecated.legacy_search",
        "  - threshold:",
        "      metric: tool_invocations",
        "      max: 4",
        "    maxViolationRate: 0.02",
        "",
      ].join("\n"),
      "utf8",
    );

    await expect(loadInvariantFile(file)).resolves.toEqual([
      {
        source: "repo",
        check: {
          assertion: { type: "tool_not_called", tool: "deprecated.legacy_search", match: "exact" },
        },
      },
      {
        source: "repo",
        check: {
          threshold: { metric: "tool_invocations", max: 4 },
          maxViolationRate: 0.02,
        },
      },
    ]);
  });

  it("rejects missing and malformed policy files with file context", async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "pupil-invariants-"));
    const missing = join(tmpRoot, "missing.yaml");
    await expect(loadInvariantFile(missing)).rejects.toMatchObject({ context: { file: missing } });

    const malformed = join(tmpRoot, "malformed.yaml");
    await writeFile(malformed, "invariants:\n  - assertion: {}\n", "utf8");
    await expect(loadInvariantFile(malformed)).rejects.toMatchObject({ context: { file: malformed } });
  });
});
