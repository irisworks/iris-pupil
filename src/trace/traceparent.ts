import { randomBytes } from "node:crypto";

/** Generates a 32-hex-char W3C trace id (16 random bytes). */
export function generateTraceId(): string {
  return randomBytes(16).toString("hex");
}

/** Generates a 16-hex-char W3C span id (8 random bytes). */
export function generateSpanId(): string {
  return randomBytes(8).toString("hex");
}

/** Formats a W3C `traceparent` header value: version-traceid-spanid-flags. */
export function formatTraceparent(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`;
}
