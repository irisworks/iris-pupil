import { describe, it, expect } from "vitest";
import { PupilError } from "../core/types.js";
import { resolvePopulationQuery } from "./query.js";

describe("resolvePopulationQuery", () => {
  const populations = { "checkout-prod": { since: "24h", tags: ["prod"] } };

  it("returns the named population's config as a query", () => {
    expect(resolvePopulationQuery(populations, "checkout-prod", {})).toEqual({
      since: "24h",
      tags: ["prod"],
    });
  });

  it("lets overrides win over the config", () => {
    expect(
      resolvePopulationQuery(populations, "checkout-prod", { since: "7d", limit: 10 }),
    ).toEqual({ since: "7d", tags: ["prod"], limit: 10 });
  });

  it("throws for an unknown population with no since override", () => {
    expect(() => resolvePopulationQuery(populations, "unknown", {})).toThrow(PupilError);
  });

  it("throws when no since is available from either config or overrides", () => {
    expect(() => resolvePopulationQuery({}, "unknown", { tags: ["prod"] })).toThrow(/since/);
  });

  it("lets overrides establish a query for a population absent from config, given a since", () => {
    expect(resolvePopulationQuery({}, "ad-hoc", { since: "1h" })).toEqual({ since: "1h" });
  });
});
