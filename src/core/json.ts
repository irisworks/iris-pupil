export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Recursively merges `overrides` onto `base`. Plain objects merge key by key;
 * arrays and scalars replace wholesale, and an `undefined` override is ignored
 * so callers can pass sparse option bags.
 */
export function deepMerge<T>(base: T, overrides: unknown): T {
  if (!isRecord(base) || !isRecord(overrides)) {
    return overrides === undefined ? base : (overrides as T);
  }

  const merged: JsonRecord = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    merged[key] = deepMerge(merged[key], value);
  }
  return merged as T;
}
