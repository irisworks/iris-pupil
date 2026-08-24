import { randomUUID } from "node:crypto";
import {
  type LoadedInvariant,
  type RunResult,
  type ScenarioResult,
  type TargetIdentity,
  type Trajectory,
} from "../core/types.js";
import type { TracePopulationQuery } from "../trace/index.js";
import { aggregateScores } from "../eval/index.js";
import { evaluateInvariants } from "../eval/invariants.js";
import { applyTraceRequirement } from "../eval/toolAssertions.js";
import { summarizeResults } from "../runner/index.js";

export interface BuildObserveResultOptions {
  runId?: string;
  populationName: string;
  query: TracePopulationQuery;
  trajectories: readonly Trajectory[];
  invariants: readonly LoadedInvariant[];
  defaultMaxViolationRate?: number;
  requireTrace: boolean;
  target: TargetIdentity;
  /** The population source's metadataKey (e.g. "langfuse"), if known, so the
   * RunResult records which backend produced this population. */
  sourceMetadataKey?: string;
}

/** Builds the RunResult for one `pupil observe` invocation. */
export function buildObserveResult(options: BuildObserveResultOptions): RunResult {
  const startedAt = new Date().toISOString();
  const rawScores = evaluateInvariants(options.invariants, options.trajectories, {
    defaultMaxViolationRate: options.defaultMaxViolationRate,
  });
  const scores = applyTraceRequirement(rawScores, options.requireTrace);
  const verdict = aggregateScores(scores);
  const completedAt = new Date().toISOString();

  // "How many samples were actually usable for the least-restrictive check" --
  // the max across scores' evaluatedCount, since per-check skips can make
  // individual checks see fewer usable samples than others.
  const evaluatedCount = scores.reduce((max, entry) => {
    const value = entry.metadata.evaluatedCount;
    return typeof value === "number" && value > max ? value : max;
  }, 0);

  const scenarioResult: ScenarioResult = {
    scenarioId: options.populationName,
    scenarioName: options.populationName,
    verdict,
    scores,
    turns: [],
    startedAt,
    completedAt,
    metrics: { traceCount: options.trajectories.length, evaluatedCount },
    metadata: {
      observe: {
        population: options.populationName,
        filters: options.query,
        traceCount: options.trajectories.length,
      },
    },
  };

  const results = [scenarioResult];
  return {
    runId: options.runId ?? randomUUID(),
    // Always exactly one synthetic scenario, so the run's verdict is just its
    // scenario's verdict -- no re-aggregation needed. Verdict.Skip shares
    // severity 0 with Verdict.Pass by design (see VERDICT_SEVERITY), so an
    // all-skip scores array (e.g. an empty population) rolls up to Pass here,
    // same as everywhere else in the codebase; the skip count is surfaced
    // separately via metadata.observe.traceCount.
    verdict,
    results,
    startedAt,
    completedAt,
    summary: summarizeResults(results),
    metadata: options.sourceMetadataKey
      ? { [options.sourceMetadataKey]: { populationSource: true } }
      : {},
    target: options.target,
  };
}
