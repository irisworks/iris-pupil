import { describe, it, expect } from "vitest";
import { resolveTimeBound } from "./time.js";

const NOW = new Date("2026-08-21T12:00:00.000Z");

describe("resolveTimeBound", () => {
  it("resolves 'now' to the reference time", () => {
    expect(resolveTimeBound("now", NOW)).toBe(NOW.toISOString());
  });

  it("resolves a relative duration to reference-time minus the duration", () => {
    expect(resolveTimeBound("24h", NOW)).toBe("2026-08-20T12:00:00.000Z");
    expect(resolveTimeBound("7d", NOW)).toBe("2026-08-14T12:00:00.000Z");
    expect(resolveTimeBound("30m", NOW)).toBe("2026-08-21T11:30:00.000Z");
    expect(resolveTimeBound("45s", NOW)).toBe("2026-08-21T11:59:15.000Z");
    expect(resolveTimeBound("2w", NOW)).toBe("2026-08-07T12:00:00.000Z");
  });

  it("passes through a parseable ISO 8601 timestamp unchanged in meaning", () => {
    expect(resolveTimeBound("2026-01-01T00:00:00.000Z", NOW)).toBe("2026-01-01T00:00:00.000Z");
  });

  it("throws PupilError for an unparseable value", () => {
    expect(() => resolveTimeBound("yesterday", NOW)).toThrow(/Invalid time bound/);
  });
});
