import { PupilError } from "../core/types.js";
import type { ObservePopulationConfig } from "../core/config.js";
import type { TracePopulationQuery } from "../trace/index.js";

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

  // Spreading `since` back in (now known to be a string) narrows the type
  // without an `as` cast papering over the guard above.
  return { ...merged, since: merged.since };
}
