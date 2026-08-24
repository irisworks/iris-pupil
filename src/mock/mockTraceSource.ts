import type { ToolCall } from "../core/types.js";
import type { TraceLookupContext, TraceRecord, TraceSource } from "../trace/index.js";

export class MockTraceSource implements TraceSource {
  readonly metadataKey = "mock";

  constructor(private readonly store: ReadonlyMap<string, readonly ToolCall[]>) {}

  resolve(correlationKey: string, context?: TraceLookupContext): Promise<TraceRecord | undefined> {
    if (context?.traceId) {
      const viaTraceId = this.store.get(context.traceId);
      if (viaTraceId !== undefined) {
        return Promise.resolve({
          traceCount: 1,
          toolCalls: [...viaTraceId],
          resolvedVia: "traceparent",
        });
      }
    }

    const spans = this.store.get(correlationKey);
    if (spans === undefined) return Promise.resolve(undefined);
    return Promise.resolve({ traceCount: 1, toolCalls: [...spans], resolvedVia: "session" });
  }
}
