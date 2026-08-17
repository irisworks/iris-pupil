import { describe, expect, it } from "vitest";
import { resolveCompareOptions } from "./compareOptions.js";

describe("resolveCompareOptions", () => {
  it("returns no options when neither config nor overrides are set", () => {
    expect(resolveCompareOptions(undefined)).toEqual({});
  });

  it("converts a config percent into the internal fraction", () => {
    expect(resolveCompareOptions({ latencyThresholdPct: 20 })).toEqual({
      latencyRegressionThresholdPct: 0.2,
    });
  });

  it("passes an absolute config millisecond threshold through unchanged", () => {
    expect(resolveCompareOptions({ latencyThresholdMs: 500 })).toEqual({
      latencyRegressionThresholdMs: 500,
    });
  });

  it("lets a CLI override win over config", () => {
    expect(
      resolveCompareOptions(
        { latencyThresholdMs: 500, latencyThresholdPct: 20 },
        { latencyThresholdMs: 900, latencyThresholdPct: 50 },
      ),
    ).toEqual({
      latencyRegressionThresholdMs: 900,
      latencyRegressionThresholdPct: 0.5,
    });
  });

  it("keeps config values that have no matching override", () => {
    expect(resolveCompareOptions({ latencyThresholdMs: 500, latencyThresholdPct: 20 }, {})).toEqual(
      {
        latencyRegressionThresholdMs: 500,
        latencyRegressionThresholdPct: 0.2,
      },
    );
  });

  it("forwards per-metric thresholds, which have no CLI override", () => {
    expect(resolveCompareOptions({ metricThresholds: { cost_usd: 0.01 } })).toEqual({
      metricRegressionThresholds: { cost_usd: 0.01 },
    });
  });

  it("treats an explicit zero as a real value, not as absent", () => {
    expect(resolveCompareOptions({ latencyThresholdMs: 0 })).toEqual({
      latencyRegressionThresholdMs: 0,
    });
  });
});
