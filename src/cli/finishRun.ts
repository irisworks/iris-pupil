import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { PupilError, type RunResult } from "../core/types.js";
import {
  compareRuns,
  formatRunComparison,
  JsonRunHistoryStore,
  resolveCompareOptions,
  type CompareConfig,
  type RunComparison,
} from "../history/index.js";
import {
  buildRunJson,
  buildStepSummaryMarkdown,
  countToolEvidenceSkips,
  formatJUnitXml,
  isStrictFailure,
} from "./reporting.js";

export interface FinishRunOptions {
  historyDir: string;
  baseline: boolean;
  strict: boolean;
  json: boolean;
  junit?: string;
  latencyThresholdMs?: number;
  latencyThresholdPct?: number;
  compareConfig: CompareConfig | undefined;
  /** First human-readable line printed when --json is not set (e.g. "Run <id>: pass (...)"). */
  summaryLine: (result: RunResult) => string;
  /** Noun used in the "N <noun>(s) skipped" warning, e.g. "tool assertion" or "invariant check". */
  skipNoun: string;
}

/**
 * Writes history, optionally compares against a baseline, optionally writes a
 * JUnit report and a GitHub step summary, prints JSON or human-readable output,
 * and sets process.exitCode — the full CI-gating tail shared by `pupil run`
 * and `pupil observe`.
 */
export async function finishRun(result: RunResult, options: FinishRunOptions): Promise<void> {
  const store = new JsonRunHistoryStore({ dir: options.historyDir });
  let stored;
  try {
    stored = await store.writeRun(result);
  } catch (error) {
    throw new PupilError(
      `Failed to save run history: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let comparison: RunComparison | undefined;
  if (options.baseline) {
    const baselineRunId = await store.getBaselineRunId();
    if (!baselineRunId) {
      console.error(
        "WARNING: --baseline was requested but no baseline run is set, so no regression comparison ran. Set one with `pupil baseline <runId>`.",
      );
    } else {
      const baselineRun = await store.readRun(baselineRunId);
      comparison = compareRuns(
        baselineRun,
        result,
        resolveCompareOptions(options.compareConfig, {
          latencyThresholdMs: options.latencyThresholdMs,
          latencyThresholdPct: options.latencyThresholdPct,
        }),
      );
    }
  }

  if (options.junit) {
    try {
      await mkdir(dirname(options.junit), { recursive: true });
      await writeFile(options.junit, formatJUnitXml(result, { strict: options.strict }), "utf-8");
    } catch (error) {
      throw new PupilError(
        `Failed to write JUnit report to ${options.junit}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const stepSummaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummaryPath) {
    try {
      await appendFile(stepSummaryPath, buildStepSummaryMarkdown(result, { comparison }), "utf-8");
    } catch (error) {
      console.error(
        `WARNING: failed to write the GitHub step summary to ${stepSummaryPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        buildRunJson(result, {
          strict: options.strict,
          historyPath: stored.runPath,
          comparison,
          baselineRequested: options.baseline,
        }),
        null,
        2,
      ),
    );
  } else {
    console.log(`Saved run: ${stored.runPath}`);
    console.log(options.summaryLine(result));
    const toolSkips = countToolEvidenceSkips(result);
    if (toolSkips > 0) {
      console.log(
        `WARNING: ${toolSkips} ${options.skipNoun}${toolSkips === 1 ? "" : "s"} skipped — no trace evidence. ` +
          "Run with --require-trace to fail instead of skipping.",
      );
    }
    if (comparison) {
      process.stdout.write(formatRunComparison(comparison));
    }
  }

  if (isStrictFailure(result.verdict, options.strict)) {
    process.exitCode = 1;
  } else if (comparison !== undefined) {
    const hasHardTargetMismatch = comparison.targetMismatch.some(
      (mismatch) => mismatch.severity === "hard",
    );
    if (hasHardTargetMismatch) {
      // A hard mismatch (e.g. stubbed vs. live) means the comparison is not
      // meaningful. Use exit 2 so CI can distinguish "refused to compare"
      // from "compared and regressed" — mirrors the `pupil compare` behaviour.
      process.exitCode = 2;
    } else if (comparison.hasRegressions) {
      process.exitCode = 1;
    }
  }
}
