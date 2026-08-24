import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseDocument } from "yaml";
import { PupilError, type LoadedInvariant } from "../core/types.js";
import { normalizeInvariantChecks } from "../scenario/schema.js";

/** Load repository-wide invariant policy checks from a YAML file. */
export async function loadInvariantFile(file: string): Promise<LoadedInvariant[]> {
  const absoluteFile = resolve(file);
  let raw: unknown;

  try {
    const source = await readFile(absoluteFile, "utf-8");
    const document = parseDocument(source, { prettyErrors: true });
    if (document.errors.length > 0) {
      const message = document.errors.map((error) => error.message).join("\n");
      throw new PupilError(`Invalid YAML in ${absoluteFile}\n${message}`, { file: absoluteFile });
    }
    raw = document.toJSON();
  } catch (error) {
    if (error instanceof PupilError) throw error;
    throw new PupilError(`Failed to read invariant policy ${absoluteFile}: ${String(error)}`, {
      file: absoluteFile,
    });
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PupilError(`Invalid invariant policy in ${absoluteFile}: expected an object`, {
      file: absoluteFile,
      path: "<root>",
    });
  }

  const policy = raw as Record<string, unknown>;
  const keys = Object.keys(policy);
  if (keys.length !== 1 || keys[0] !== "invariants") {
    throw new PupilError(`Invalid invariant policy in ${absoluteFile}: expected only invariants`, {
      file: absoluteFile,
      path: "<root>",
    });
  }

  return normalizeInvariantChecks(policy.invariants, absoluteFile).map((check) => ({
    check,
    source: "repo",
  }));
}
