import type { ToolCall } from "../core/types.js";
import type { TraceRecord, TraceSource } from "../trace/index.js";

export class MockTraceSource implements TraceSource {
  readonly metadataKey = "mock";

  constructor(private readonly store: ReadonlyMap<string, readonly ToolCall[]>) {}

  resolve(correlationKey: string): Promise<TraceRecord | undefined> {
    const spans = this.store.get(correlationKey);
    if (spans === undefined) return Promise.resolve(undefined);
    return Promise.resolve({ traceCount: 1, toolCalls: [...spans] });
  }
}
