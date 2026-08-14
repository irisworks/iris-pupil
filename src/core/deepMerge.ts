export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

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
