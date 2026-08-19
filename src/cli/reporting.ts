import type { RunComparison } from "../history/compare.js";
import { Verdict, verdictSeverity, type RunResult } from "../core/types.js";
import { NO_TOOL_EVIDENCE_MARKER } from "../eval/toolAssertions.js";

/**
 * Stable, documented shape for `pupil run --json`. Deliberately narrower than
 * the raw RunResult (no turn transcripts or raw driver payloads) so CI
 * consumers get a shape they can parse without depending on internals that
 * change with the evaluator or driver.
 */
export interface RunJsonScore {
  name: string;
  verdict: Verdict;
  reason?: string;
}

export interface RunJsonScenario {
  scenarioId: string;
  scenarioName: string;
  verdict: Verdict;
  metrics: Record<string, number>;
  scores: RunJsonScore[];
}

export type RunJsonBaseline =
  | { status: "not_set" }
  | {
      status: "compared";
      baseRunId: string;
      hasRegressions: boolean;
      summary: RunComparison["summary"];
      regressions: Array<{ scenarioId: string; reasons: string[] }>;
    };

export interface RunJsonOutput {
  runId: string;
  verdict: Verdict;
  strict: boolean;
  summary: RunResult["summary"];
  scenarios: RunJsonScenario[];
  historyPath: string;
  baseline?: RunJsonBaseline;
  toolEvidenceSkips: number;
}

/**
 * Number of tool assertions that could not be checked because no trace evidence
 * arrived. These do not fail the run by default, so they must be visible in the
 * report — otherwise green means both "verified" and "could not verify".
 */
export function countToolEvidenceSkips(run: RunResult): number {
  return run.results.reduce(
    (total, result) =>
      total +
      result.scores.filter((score) => score.metadata.skipped === NO_TOOL_EVIDENCE_MARKER).length,
    0,
  );
}

export function isStrictFailure(verdict: Verdict, strict: boolean): boolean {
  if (verdict === Verdict.Error || verdict === Verdict.Fail) return true;
  return strict && verdictSeverity(verdict) >= verdictSeverity(Verdict.NeedsReview);
}

function toJsonBaseline(
  comparison: RunComparison | undefined,
  baselineRequested: boolean,
): RunJsonBaseline | undefined {
  if (comparison) {
    return {
      status: "compared",
      baseRunId: comparison.baseRunId,
      hasRegressions: comparison.hasRegressions,
      summary: comparison.summary,
      regressions: comparison.scenarios
        .filter((scenario) => scenario.regression)
        .map((scenario) => ({ scenarioId: scenario.scenarioId, reasons: scenario.reasons })),
    };
  }
  return baselineRequested ? { status: "not_set" } : undefined;
}

export function buildRunJson(
  run: RunResult,
  options: {
    strict: boolean;
    historyPath: string;
    comparison?: RunComparison;
    baselineRequested?: boolean;
  },
): RunJsonOutput {
  const baseline = toJsonBaseline(options.comparison, options.baselineRequested ?? false);

  return {
    runId: run.runId,
    verdict: run.verdict,
    strict: options.strict,
    summary: run.summary,
    historyPath: options.historyPath,
    toolEvidenceSkips: countToolEvidenceSkips(run),
    scenarios: [...run.results]
      .sort((a, b) => a.scenarioId.localeCompare(b.scenarioId))
      .map((result) => ({
        scenarioId: result.scenarioId,
        scenarioName: result.scenarioName,
        verdict: result.verdict,
        metrics: result.metrics,
        scores: result.scores.map((score) => ({
          name: score.name,
          verdict: score.verdict,
          ...(score.reason !== undefined && { reason: score.reason }),
        })),
      })),
    ...(baseline !== undefined && { baseline }),
  };
}

/** Characters that are illegal in XML 1.0 text. Tab, LF, and CR are legal and preserved. */
const XML_ILLEGAL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

function xmlEscape(value: string): string {
  return value
    .replace(XML_ILLEGAL_CHARS, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * JUnit XML for `--junit`. One <testsuite> for the run, one <testcase> per
 * scenario. `fail`/`error` verdicts always render as failing; `needs_review`
 * only renders as failing when `strict` is set, matching the exit-code rule.
 */
export function formatJUnitXml(run: RunResult, options: { strict: boolean }): string {
  const testcases = [...run.results]
    .sort((a, b) => a.scenarioId.localeCompare(b.scenarioId))
    .map((result) => {
      const timeSeconds = (result.metrics.latency_ms ?? 0) / 1000;
      const attrs = `name="${xmlEscape(result.scenarioId)}" classname="${xmlEscape(
        result.scenarioName,
      )}" time="${timeSeconds}"`;

      if (result.verdict === Verdict.Skip) {
        return `    <testcase ${attrs}><skipped/></testcase>`;
      }
      if (result.verdict === Verdict.Error) {
        const reason = result.scores.find((score) => score.verdict === Verdict.Error)?.reason;
        return `    <testcase ${attrs}><error message="${xmlEscape(
          reason ?? "error",
        )}">${xmlEscape(reason ?? "error")}</error></testcase>`;
      }
      if (isStrictFailure(result.verdict, options.strict)) {
        const failing = result.scores.filter(
          (score) => verdictSeverity(score.verdict) >= verdictSeverity(Verdict.NeedsReview),
        );
        const message = failing.map((score) => score.reason ?? score.name).join("; ") || "failed";
        const body = failing
          .map((score) => `${score.name}: ${score.reason ?? score.verdict}`)
          .join("\n");
        return `    <testcase ${attrs}><failure message="${xmlEscape(message)}">${xmlEscape(
          body || message,
        )}</failure></testcase>`;
      }
      return `    <testcase ${attrs}/>`;
    });

  const failures = run.results.filter(
    (result) => result.verdict !== Verdict.Error && isStrictFailure(result.verdict, options.strict),
  ).length;
  const errors = run.results.filter((result) => result.verdict === Verdict.Error).length;
  const skipped = run.results.filter((result) => result.verdict === Verdict.Skip).length;
  const timeSeconds = (Date.parse(run.completedAt) - Date.parse(run.startedAt)) / 1000 || 0;

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<testsuites>",
    `  <testsuite name="pupil" tests="${run.results.length}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${timeSeconds}">`,
    ...testcases,
    "  </testsuite>",
    "</testsuites>",
    "",
  ].join("\n");
}

/** Markdown for `$GITHUB_STEP_SUMMARY`. */
export function buildStepSummaryMarkdown(
  run: RunResult,
  options: { comparison?: RunComparison },
): string {
  const lines = [
    `## Pupil run \`${run.runId}\``,
    "",
    `**Verdict:** ${run.verdict}`,
    "",
    `| Total | Passed | Failed | Needs review | Errors |`,
    `| --- | --- | --- | --- | --- |`,
    `| ${run.summary.total} | ${run.summary.passed} | ${run.summary.failed} | ${run.summary.needsReview} | ${run.summary.errors} |`,
  ];

  if (options.comparison) {
    const comparison = options.comparison;
    lines.push(
      "",
      `### Comparison vs \`${comparison.baseRunId}\``,
      "",
      comparison.hasRegressions ? "**Regressions detected.**" : "No regressions.",
      "",
    );
    const regressed = comparison.scenarios.filter((scenario) => scenario.regression);
    if (regressed.length > 0) {
      lines.push(`| Scenario | Before | After | Reasons |`, `| --- | --- | --- | --- |`);
      for (const scenario of regressed) {
        lines.push(
          `| ${scenario.scenarioId} | ${scenario.beforeVerdict ?? "-"} | ${
            scenario.afterVerdict ?? "-"
          } | ${scenario.reasons.join("; ")} |`,
        );
      }
    }
  }

  const toolSkips = countToolEvidenceSkips(run);
  if (toolSkips > 0) {
    lines.push(
      "",
      `> ⚠️ ${toolSkips} tool assertion${toolSkips === 1 ? "" : "s"} skipped — no trace evidence. ` +
        "Run with `--require-trace` to fail instead of skipping.",
    );
  }

  lines.push("");
  return lines.join("\n");
}
