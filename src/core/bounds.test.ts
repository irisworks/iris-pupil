import { describe, expect, it } from "vitest";
import { formatBounds } from "./bounds.js";

describe("formatBounds", () => {
  it("joins both bounds when both are set", () => {
    expect(formatBounds(2, 5)).toBe(">= 2 and <= 5");
  });

  it("renders only the bound that is set", () => {
    expect(formatBounds(2, undefined)).toBe(">= 2");
    expect(formatBounds(undefined, 5)).toBe("<= 5");
  });

  it("returns an empty string when neither bound is set", () => {
    expect(formatBounds(undefined, undefined)).toBe("");
  });

  it("keeps zero, which is a real bound rather than an absent one", () => {
    expect(formatBounds(0, 0)).toBe(">= 0 and <= 0");
  });
});
