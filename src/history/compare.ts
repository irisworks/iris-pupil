import { Verdict, verdictSeverity, type RunResult, type ScenarioResult } from "../core/types.js";
import type { TargetIdentity } from "../core/types.js";

export type ScenarioComparisonStatus =
  "unchanged" | "regressed" | "fixed" | "still_failing" | "new" | "removed";

export interface TargetMismatchEntry {
  field: "system" | "environment" | "version" | "mode" | "fixtureSet";
  severity: "hard" | "soft";
  base: string | undefined;
  current: string | undefined;
}

export interface MetricDelta {
  metric: string;
  before?: number;
  after?: number;
  delta?: number;
  regression: boolean;
  threshold?: number;
}

export interface ScenarioComparison {
  scenarioId: string;
  scenarioName?: string;
  status: ScenarioComparisonStatus;
  beforeVerdict?: Verdict;
  afterVerdict?: Verdict;
  metrics: MetricDelta[];
  regression: boolean;
  reasons: string[];
}

export interface RunComparison {
  baseRunId: string;
  currentRunId: string;
  scenarios: ScenarioComparison[];
  hasRegressions: boolean;
  targetMismatch: TargetMismatchEntry[];
  targetIdentityUnknown: boolean;
  summary: Record<ScenarioComparisonStatus, number> & {
    metricRegressions: number;
  };
}

export interface CompareRunsOptions {
  latencyRegressionThresholdMs?: number;
  latencyRegressionThresholdPct?: number;
  metricRegressionThresholds?: Record<string, number>;
}

function isPassing(verdict: Verdict | undefined): boolean {
  return verdict !== undefined && verdictSeverity(verdict) <= verdictSeverity(Verdict.Pass);
}

function scenarioStatus(
  before: ScenarioResult | undefined,
  after: ScenarioResult | undefined,
): ScenarioComparisonStatus {
  if (!before) return "new";
  if (!after) return "removed";
  if (isPassing(before.verdict) && !isPassing(after.verdict)) return "regressed";
  if (!isPassing(before.verdict) && isPassing(after.verdict)) return "fixed";
  if (!isPassing(before.verdict) && !isPassing(after.verdict)) return "still_failing";
  return "unchanged";
}

const DEFAULT_LATENCY_REGRESSION_PERCENT = 0.2;

function roundThreshold(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function metricThreshold(
  metric: string,
  beforeValue: number | undefined,
  options: CompareRunsOptions,
): number | undefined {
  const explicit = options.metricRegressionThresholds?.[metric];
  if (explicit !== undefined) return explicit;
  if (metric === "latency_ms") {
    if (options.latencyRegressionThresholdMs !== undefined) {
      return options.latencyRegressionThresholdMs;
    }
    return beforeValue !== undefined
      ? roundThreshold(
          beforeValue *
            (options.latencyRegressionThresholdPct ?? DEFAULT_LATENCY_REGRESSION_PERCENT),
        )
      : undefined;
  }
  return undefined;
}

function compareMetrics(
  before: ScenarioResult | undefined,
  after: ScenarioResult | undefined,
  options: CompareRunsOptions,
): MetricDelta[] {
  const metricNames = new Set([
    ...Object.keys(before?.metrics ?? {}),
    ...Object.keys(after?.metrics ?? {}),
  ]);

  return [...metricNames].sort().map((metric): MetricDelta => {
    const beforeValue = before?.metrics[metric];
    const afterValue = after?.metrics[metric];
    const delta =
      beforeValue !== undefined && afterValue !== undefined ? afterValue - beforeValue : undefined;
    const threshold = metricThreshold(metric, beforeValue, options);
    const regression = delta !== undefined && threshold !== undefined && delta > threshold;

    return {
      metric,
      before: beforeValue,
      after: afterValue,
      delta,
      regression,
      threshold,
    };
  });
}

function indexByScenarioId(run: RunResult): Map<string, ScenarioResult> {
  return new Map(run.results.map((result) => [result.scenarioId, result]));
}

const TARGET_FIELDS: [keyof TargetIdentity, "hard" | "soft"][] = [
  ["system", "hard"],
  ["mode", "hard"],
  ["fixtureSet", "hard"],
  ["environment", "soft"],
  ["version", "soft"],
];

function detectTargetMismatches(base: RunResult, current: RunResult): TargetMismatchEntry[] {
  const bt = base.target ?? ({} as TargetIdentity);
  const ct = current.target ?? ({} as TargetIdentity);

  const mismatches: TargetMismatchEntry[] = [];

  for (const [field, severity] of TARGET_FIELDS) {
    const bv = bt[field] as string | undefined;
    const cv = ct[field] as string | undefined;
    if (bv === cv) continue;
    // Hard fields (system/mode/fixtureSet) treat one side being unset as a
    // mismatch too: a stubbed run vs. an undeclared one — including a run
    // that predates target-identity tracking entirely — is exactly the
    // contamination this check exists to catch. Soft fields (environment/
    // version) stay lenient so a merely-incomplete target doesn't warn.
    const bothPresent = bv !== undefined && cv !== undefined;
    if (severity === "hard" || bothPresent) {
      mismatches.push({ field, severity, base: bv, current: cv });
    }
  }

  return mismatches;
}

export function compareRuns(
  base: RunResult,
  current: RunResult,
  options: CompareRunsOptions = {},
): RunComparison {
  const beforeById = indexByScenarioId(base);
  const afterById = indexByScenarioId(current);
  const scenarioIds = [...new Set([...beforeById.keys(), ...afterById.keys()])].sort();

  const scenarios = scenarioIds.map((scenarioId): ScenarioComparison => {
    const before = beforeById.get(scenarioId);
    const after = afterById.get(scenarioId);
    const status = scenarioStatus(before, after);
    const metrics = compareMetrics(before, after, options);
    const metricRegressions = metrics.filter((metric) => metric.regression);
    const reasons = [
      ...(status === "regressed"
        ? [`Verdict regressed from ${before?.verdict} to ${after?.verdict}`]
        : []),
      ...metricRegressions.map(
        (metric) =>
          `${metric.metric} increased by ${metric.delta} beyond threshold ${metric.threshold}`,
      ),
    ];

    return {
      scenarioId,
      scenarioName: after?.scenarioName ?? before?.scenarioName,
      status,
      beforeVerdict: before?.verdict,
      afterVerdict: after?.verdict,
      metrics,
      regression: status === "regressed" || metricRegressions.length > 0,
      reasons,
    };
  });

  const summary = {
    unchanged: 0,
    regressed: 0,
    fixed: 0,
    still_failing: 0,
    new: 0,
    removed: 0,
    metricRegressions: 0,
  };
  for (const scenario of scenarios) {
    summary[scenario.status] += 1;
    summary.metricRegressions += scenario.metrics.filter((metric) => metric.regression).length;
  }

  return {
    baseRunId: base.runId,
    currentRunId: current.runId,
    scenarios,
    hasRegressions: scenarios.some((scenario) => scenario.regression),
    targetMismatch: detectTargetMismatches(base, current),
    targetIdentityUnknown: !base.target || !current.target,
    summary,
  };
}

function formatValue(value: number | undefined): string {
  return value === undefined ? "<missing>" : String(value);
}

function formatDelta(delta: number | undefined): string {
  if (delta === undefined) return "n/a";
  return delta > 0 ? `+${delta}` : String(delta);
}

function formatTargetTable(
  entries: TargetMismatchEntry[],
  baseRunId: string,
  currentRunId: string,
): string {
  const gap = 2;
  const leftHeader = `  Base (${baseRunId})`;
  const rightHeader = `Current (${currentRunId})`;
  const leftCells = entries.map((m) => `  ${m.field}: ${m.base ?? ""}`);
  const rightCells = entries.map((m) => `${m.field}: ${m.current ?? ""}`);
  const col = Math.max(leftHeader.length, ...leftCells.map((cell) => cell.length)) + gap;

  const header = leftHeader.padEnd(col) + rightHeader;
  const divider = "─".repeat(leftHeader.length).padEnd(col) + "─".repeat(rightHeader.length);
  const rows = entries.map((_, i) => leftCells[i]!.padEnd(col) + rightCells[i]);
  return [header, divider, ...rows].join("\n");
}

function formatTargetMismatches(
  mismatches: TargetMismatchEntry[],
  baseRunId: string,
  currentRunId: string,
): string {
  const hard = mismatches.filter((m) => m.severity === "hard");
  const soft = mismatches.filter((m) => m.severity === "soft");
  const parts: string[] = [];

  if (hard.length > 0) {
    const table = formatTargetTable(hard, baseRunId, currentRunId);
    parts.push(
      [
        "⚠ Comparison may be invalid",
        "",
        table,
        "",
        "  Regression metrics may not be meaningful.",
      ].join("\n"),
    );
  }

  if (soft.length > 0) {
    const table = formatTargetTable(soft, baseRunId, currentRunId);
    parts.push(
      [
        "⚠ Cross-target comparison",
        "",
        table,
        "",
        "  Metrics may not be comparable across environments or versions.",
      ].join("\n"),
    );
  }

  return parts.join("\n\n");
}

function formatTargetIdentityUnknown(): string {
  return [
    "ℹ Target identity unknown",
    "",
    "  One or both runs predate target identity tracking.",
    "  Comparison provenance cannot be verified.",
    "  Re-baseline with `pupil baseline <runId>` once both runs carry target identity.",
  ].join("\n");
}

export function formatRunComparison(comparison: RunComparison): string {
  const blocks: string[] = [];

  const mismatchBlock = formatTargetMismatches(
    comparison.targetMismatch,
    comparison.baseRunId,
    comparison.currentRunId,
  );
  if (mismatchBlock) blocks.push(mismatchBlock);
  if (comparison.targetIdentityUnknown) blocks.push(formatTargetIdentityUnknown());

  const lines = [
    `Comparison ${comparison.baseRunId} -> ${comparison.currentRunId}`,
    `Summary: regressed=${comparison.summary.regressed} fixed=${comparison.summary.fixed} still_failing=${comparison.summary.still_failing} new=${comparison.summary.new} removed=${comparison.summary.removed} unchanged=${comparison.summary.unchanged} metric_regressions=${comparison.summary.metricRegressions}`,
  ];

  for (const scenario of comparison.scenarios) {
    const marker = scenario.regression ? "REGRESSION" : scenario.status.toUpperCase();
    lines.push(
      `${marker} ${scenario.scenarioId}: ${scenario.beforeVerdict ?? "<missing>"} -> ${
        scenario.afterVerdict ?? "<missing>"
      }`,
    );
    for (const reason of scenario.reasons) {
      lines.push(`  reason: ${reason}`);
    }
    for (const metric of scenario.metrics) {
      const suffix = metric.regression ? " regression" : "";
      lines.push(
        `  metric ${metric.metric}: ${formatValue(metric.before)} -> ${formatValue(
          metric.after,
        )} (delta ${formatDelta(metric.delta)})${suffix}`,
      );
    }
  }

  const body = `${lines.join("\n")}\n`;
  return blocks.length > 0 ? `${blocks.join("\n\n")}\n\n${body}` : body;
}
