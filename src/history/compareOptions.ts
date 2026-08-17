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
  const latencyRegressionThresholdMs = overrides.latencyThresholdMs ?? config?.latencyThresholdMs;
  const latencyRegressionThresholdPct = percentToFraction(
    overrides.latencyThresholdPct ?? config?.latencyThresholdPct,
  );
  const metricRegressionThresholds = config?.metricThresholds;

  return {
    ...(latencyRegressionThresholdMs !== undefined && { latencyRegressionThresholdMs }),
    ...(latencyRegressionThresholdPct !== undefined && { latencyRegressionThresholdPct }),
    ...(metricRegressionThresholds !== undefined && { metricRegressionThresholds }),
  };
}
