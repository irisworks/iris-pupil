import type { CompareRunsOptions } from "./compare.js";

/**
 * The `compare` block of `pupil.config.yaml`. Field names deliberately match
 * the CLI flag names (`latencyThresholdMs` for `--latency-threshold-ms`), and
 * `latencyThresholdPct` is a percent, so `20` means 20%.
 *
 * Structural rather than derived from `PupilConfig` so `src/history` does not
 * need to depend on `src/core/config`.
 */
export interface CompareConfig {
  latencyThresholdMs?: number;
  latencyThresholdPct?: number;
  metricThresholds?: Record<string, number>;
}

/** CLI flag values, which override config. Percent units, same as config. */
export interface CompareOptionOverrides {
  latencyThresholdMs?: number;
  latencyThresholdPct?: number;
}

function percentToFraction(percent: number | undefined): number | undefined {
  return percent === undefined ? undefined : percent / 100;
}

/**
 * Single source of comparison options for both `pupil run --baseline` and
 * `pupil compare`, so the two commands cannot disagree about how runs are
 * compared. Precedence is CLI override, then config, then the built-in default
 * in `compare.ts` — which is why an unset value resolves to `undefined` here
 * rather than to a hardcoded fallback.
 */
export function resolveCompareOptions(
  config: CompareConfig | undefined,
  overrides: CompareOptionOverrides = {},
): CompareRunsOptions {
  // The two latency knobs are a mutually exclusive unit at the override layer:
  // if the caller supplies EITHER one, that expresses "use my latency policy
  // for this invocation," so both of config's latency values are dropped
  // rather than letting one leftover config value silently combine with the
  // override. `compare.ts` prefers an absolute ms threshold over a percent
  // one when both are present, so a config ms ceiling would otherwise defeat
  // an override that only set a percent.
  const overridesLatency =
    overrides.latencyThresholdMs !== undefined || overrides.latencyThresholdPct !== undefined;

  const latencyRegressionThresholdMs = overridesLatency
    ? overrides.latencyThresholdMs
    : config?.latencyThresholdMs;
  const latencyRegressionThresholdPct = percentToFraction(
    overridesLatency ? overrides.latencyThresholdPct : config?.latencyThresholdPct,
  );
  const metricRegressionThresholds = config?.metricThresholds;

  return {
    ...(latencyRegressionThresholdMs !== undefined && { latencyRegressionThresholdMs }),
    ...(latencyRegressionThresholdPct !== undefined && { latencyRegressionThresholdPct }),
    ...(metricRegressionThresholds !== undefined && { metricRegressionThresholds }),
  };
}
