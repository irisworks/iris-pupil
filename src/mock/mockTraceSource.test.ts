import { describe, expect, it } from "vitest";
import { MockTraceSource } from "./mockTraceSource.js";

describe("MockTraceSource", () => {
  it("resolve returns undefined for an unknown session ID", async () => {
    const store = new Map<string, string[]>();
    const source = new MockTraceSource(store);

    await expect(source.resolve("nonexistent-id")).resolves.toBeUndefined();
  });

  it("resolve returns traceCount 1 with empty toolCalls for a session that produced no spans", async () => {
    const store = new Map<string, string[]>([["session-1", []]]);
    const source = new MockTraceSource(store);

    await expect(source.resolve("session-1")).resolves.toEqual({
      traceCount: 1,
      toolCalls: [],
    });
  });

  it("resolve returns accumulated spans after one turn", async () => {
    const store = new Map<string, string[]>([["session-1", ["web_search"]]]);
    const source = new MockTraceSource(store);

    await expect(source.resolve("session-1")).resolves.toEqual({
      traceCount: 1,
      toolCalls: ["web_search"],
    });
  });

  it("resolve returns accumulated spans after multiple turns in emission order", async () => {
    const store = new Map<string, string[]>([
      ["session-1", ["web_search", "calendar_create", "email_send"]],
    ]);
    const source = new MockTraceSource(store);

    await expect(source.resolve("session-1")).resolves.toEqual({
      traceCount: 1,
      toolCalls: ["web_search", "calendar_create", "email_send"],
    });
  });

  it("returns a copy of spans — mutations to the returned array do not affect the store", async () => {
    const spans = ["web_search"];
    const store = new Map<string, string[]>([["session-1", spans]]);
    const source = new MockTraceSource(store);

    const record = await source.resolve("session-1");
    (record!.toolCalls as string[]).push("mutated");

    // Store is unaffected
    expect(store.get("session-1")).toEqual(["web_search"]);
  });

  it("metadataKey is 'mock'", () => {
    const source = new MockTraceSource(new Map());
    expect(source.metadataKey).toBe("mock");
  });
});
