import { PupilError } from "../core/types.js";

const RELATIVE_DURATION = /^(\d+)(s|m|h|d|w)$/;
const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Resolves a population time bound to an ISO 8601 timestamp. Accepts "now",
 * a relative duration ("24h", "7d", "30m", "45s", "2w") measured back from
 * `now`, or a literal ISO 8601 timestamp.
 */
export function resolveTimeBound(value: string, now: Date): string {
  if (value === "now") return now.toISOString();

  const relative = RELATIVE_DURATION.exec(value);
  if (relative) {
    const [, amount, unit] = relative;
    const offsetMs = Number(amount) * UNIT_MS[unit]!;
    return new Date(now.getTime() - offsetMs).toISOString();
  }

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new PupilError(
      `Invalid time bound "${value}": expected "now", a relative duration like "24h", or an ISO 8601 timestamp`,
    );
  }
  return new Date(parsed).toISOString();
}
