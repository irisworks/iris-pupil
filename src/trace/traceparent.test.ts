import { describe, expect, it } from "vitest";
import { formatTraceparent, generateSpanId, generateTraceId } from "./traceparent.js";

describe("traceparent", () => {
  it("generates a 32-character lowercase hex trace id", () => {
    expect(generateTraceId()).toMatch(/^[0-9a-f]{32}$/);
  });

  it("generates distinct trace ids across calls", () => {
    expect(generateTraceId()).not.toBe(generateTraceId());
  });

  it("generates a 16-character lowercase hex span id", () => {
    expect(generateSpanId()).toMatch(/^[0-9a-f]{16}$/);
  });

  it("generates distinct span ids across calls", () => {
    expect(generateSpanId()).not.toBe(generateSpanId());
  });

  it("formats a well-formed W3C traceparent header value", () => {
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const spanId = "00f067aa0ba902b7";
    expect(formatTraceparent(traceId, spanId)).toBe(
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    );
  });
});
