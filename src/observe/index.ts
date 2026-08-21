import { randomUUID } from "node:crypto";
import {
  PupilError,
  Verdict,
  type LoadedInvariant,
  type RunResult,
  type ScenarioResult,
  type Score,
  type TargetIdentity,
  type Trajectory,
} from "../core/types.js";
import type { ObservePopulationConfig } from "../core/config.js";
import type { TracePopulationQuery } from "../trace/index.js";
import { aggregateScores } from "../eval/index.js";
import { evaluateInvariants } from "../eval/invariants.js";
import { applyTraceRequirement } from "../eval/toolAssertions.js";
import { summarizeResults } from "../runner/index.js";

/**
 * Merges a named population's config with CLI-flag overrides — overrides win,
 * matching the config-then-CLI-flag precedence `pupil run` already uses for
 * driver config. `since` must be present after merging: every population
 * fetch is time-bounded by design (see the design spec's full-table-scan
 * rationale), so there is no default to silently fall back to.
 */
export function resolvePopulationQuery(
  populations: Record<string, ObservePopulationConfig>,
  name: string,
  overrides: Partial<TracePopulationQuery>,
): TracePopulationQuery {
  const configured = populations[name];
  const merged = { ...configured, ...overrides };

  if (merged.since === undefined) {
    throw new PupilError(
      `Population "${name}" has no "since" configured in pupil.config.yaml and none was passed via --since`,
    );
  }

  return merged as TracePopulationQuery;
}

export interface BuildObserveResultOptions {
  runId?: string;
  populationName: string;
  query: TracePopulationQuery;
  trajectories: readonly Trajectory[];
  invariants: readonly LoadedInvariant[];
  defaultMaxViolationRate?: number;
  requireTrace: boolean;
  target: TargetIdentity;
}

/**
 * `aggregateScores` treats a Skip the same severity as a Pass, which is right
 * for a mixed set of scores (an unrelated skip shouldn't hide a real
 * failure) but wrong when literally every score skipped: an empty population
 * has verified nothing, and should read as Skip rather than a quiet Pass.
 */
function verdictFromScores(scores: readonly Score[]): Verdict {
  if (scores.length > 0 && scores.every((score) => score.verdict === Verdict.Skip)) {
    return Verdict.Skip;
  }
  return aggregateScores(scores);
}

/** Builds the RunResult for one `pupil observe` invocation. */
export function buildObserveResult(options: BuildObserveResultOptions): RunResult {
  const startedAt = new Date().toISOString();
  const rawScores = evaluateInvariants(options.invariants, options.trajectories, {
    defaultMaxViolationRate: options.defaultMaxViolationRate,
  });
  const scores = applyTraceRequirement(rawScores, options.requireTrace);
  const verdict = verdictFromScores(scores);
  const completedAt = new Date().toISOString();

  const scenarioResult: ScenarioResult = {
    scenarioId: options.populationName,
    scenarioName: options.populationName,
    verdict,
    scores,
    turns: [],
    startedAt,
    completedAt,
    metrics: { traceCount: options.trajectories.length },
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
    // scenario's verdict -- no re-aggregation, and no risk of the plain
    // aggregateVerdicts's Pass-biased handling of an all-Skip singleton
    // disagreeing with the scenario verdict computed above.
    verdict,
    results,
    startedAt,
    completedAt,
    summary: summarizeResults(results),
    metadata: {},
    target: options.target,
  };
}
