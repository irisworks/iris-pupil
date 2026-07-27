import { Verdict, verdictSeverity, type RunResult, type ScenarioResult } from "../core/types.js";

export type ScenarioComparisonStatus =
  "unchanged" | "regressed" | "fixed" | "still_failing" | "new" | "removed";

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
  summary: Record<ScenarioComparisonStatus, number> & {
    metricRegressions: number;
  };
}

export interface CompareRunsOptions {
  latencyRegressionThresholdMs?: number;
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

function metricThreshold(metric: string, options: CompareRunsOptions): number | undefined {
  const explicit = options.metricRegressionThresholds?.[metric];
  if (explicit !== undefined) return explicit;
  if (metric === "latency_ms") return options.latencyRegressionThresholdMs ?? 0;
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
    const threshold = metricThreshold(metric, options);
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

export function formatRunComparison(comparison: RunComparison): string {
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

  return `${lines.join("\n")}\n`;
}
