import { describe, expect, it } from "vitest";
import { PupilError, type Scenario, type ToolCall } from "../core/types.js";
import type { RestConversation, RestDriverResponse, SeedHistoryEntry } from "../driver/index.js";
import {
  assertSeedCapability,
  filterSeedPhaseToolCalls,
  runSeedPhase,
  seedTurnsToHistory,
  type SeedCapableDriver,
} from "./seed.js";

function baseScenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: "seed-test",
    name: "Seed test",
    tags: [],
    metadata: {},
    driver: { type: "rest", config: {} },
    turns: [{ user: "the real question", expect: [] }],
    expect: { assertions: [], thresholds: [] },
    ...overrides,
  };
}

class FakeSeedDriver implements SeedCapableDriver {
  readonly sent: string[] = [];
  readonly forkedFrom: string[] = [];
  readonly injectedHistories: readonly SeedHistoryEntry[][] = [];
  private nextId = 0;

  constructor(private readonly capabilities: { fork?: boolean; inject?: boolean } = {}) {
    if (capabilities.fork) this.fork = this.forkImpl.bind(this);
    if (capabilities.inject) this.inject = this.injectImpl.bind(this);
  }

  fork?: (conversation: RestConversation) => Promise<RestConversation>;
  inject?: (
    history: readonly SeedHistoryEntry[],
    context?: Record<string, string | number | boolean | null | undefined>,
  ) => Promise<RestConversation>;

  async createConversation(): Promise<RestConversation> {
    this.nextId += 1;
    return { id: `conv-${this.nextId}`, raw: {} };
  }

  async send(_conversation: RestConversation, message: string): Promise<RestDriverResponse> {
    this.sent.push(message);
    return { text: `reply to ${message}`, raw: {} };
  }

  supportsSeedStrategy(strategy: "replay" | "fork" | "inject"): boolean {
    if (strategy === "replay") return true;
    if (strategy === "fork") return Boolean(this.capabilities.fork);
    return Boolean(this.capabilities.inject);
  }

  private async forkImpl(conversation: RestConversation): Promise<RestConversation> {
    this.forkedFrom.push(conversation.id);
    this.nextId += 1;
    return { id: `fork-${this.nextId}`, raw: {} };
  }

  private async injectImpl(history: readonly SeedHistoryEntry[]): Promise<RestConversation> {
    (this.injectedHistories as SeedHistoryEntry[][]).push([...history]);
    this.nextId += 1;
    return { id: `inject-${this.nextId}`, raw: {} };
  }
}

describe("assertSeedCapability", () => {
  it("allows replay unconditionally", () => {
    const scenario = baseScenario({ seed: { strategy: "replay", turns: [{ user: "warm up" }] } });
    expect(() => assertSeedCapability(scenario, new FakeSeedDriver())).not.toThrow();
  });

  it("throws immediately when fork is requested but unsupported", () => {
    const scenario = baseScenario({ seed: { strategy: "fork", turns: [{ user: "warm up" }] } });
    expect(() => assertSeedCapability(scenario, new FakeSeedDriver())).toThrow(PupilError);
  });

  it("passes when fork is requested and supported", () => {
    const scenario = baseScenario({ seed: { strategy: "fork", turns: [{ user: "warm up" }] } });
    expect(() => assertSeedCapability(scenario, new FakeSeedDriver({ fork: true }))).not.toThrow();
  });

  it("does nothing when the scenario has no seed block", () => {
    expect(() => assertSeedCapability(baseScenario(), new FakeSeedDriver())).not.toThrow();
  });
});

describe("seedTurnsToHistory", () => {
  it("converts seed turns into user-role history entries", () => {
    expect(seedTurnsToHistory([{ user: "a" }, { user: "b" }])).toEqual([
      { role: "user", content: "a" },
      { role: "user", content: "b" },
    ]);
  });
});

describe("runSeedPhase", () => {
  it("creates a plain conversation and returns no seed turns when there is no seed block", async () => {
    const driver = new FakeSeedDriver();
    const result = await runSeedPhase(baseScenario(), driver, {});
    expect(result.turns).toEqual([]);
    expect(result.conversation.id).toBe("conv-1");
  });

  it("replays seed turns against the created conversation and flags them isSeed", async () => {
    const driver = new FakeSeedDriver();
    const scenario = baseScenario({
      seed: { strategy: "replay", turns: [{ user: "warm up one" }, { user: "warm up two" }] },
    });

    const result = await runSeedPhase(scenario, driver, {});

    expect(driver.sent).toEqual(["warm up one", "warm up two"]);
    expect(result.turns).toHaveLength(2);
    expect(result.turns.every((turn) => turn.isSeed)).toBe(true);
    expect(result.turns[0].response?.text).toBe("reply to warm up one");
    expect(result.conversation.id).toBe("conv-1");
  });

  it("replays seed turns then forks, returning the forked conversation", async () => {
    const driver = new FakeSeedDriver({ fork: true });
    const scenario = baseScenario({
      seed: { strategy: "fork", turns: [{ user: "warm up" }] },
    });

    const result = await runSeedPhase(scenario, driver, {});

    expect(driver.sent).toEqual(["warm up"]);
    expect(driver.forkedFrom).toEqual(["conv-1"]);
    expect(result.conversation.id).toBe("fork-2");
    expect(result.turns).toHaveLength(1);
  });

  it("injects history directly without replaying and without seed turn records", async () => {
    const driver = new FakeSeedDriver({ inject: true });
    const scenario = baseScenario({
      seed: { strategy: "inject", turns: [{ user: "seeded question" }] },
    });

    const result = await runSeedPhase(scenario, driver, {});

    expect(driver.sent).toEqual([]);
    expect(driver.injectedHistories).toEqual([[{ role: "user", content: "seeded question" }]]);
    expect(result.turns).toEqual([]);
    expect(result.conversation.id).toBe("inject-1");
  });

  it("attaches the conversation and partial turns to SeedPhaseError when a seed turn fails mid-replay", async () => {
    class FailingSeedDriver extends FakeSeedDriver {
      async send(conversation: RestConversation, message: string): Promise<RestDriverResponse> {
        if (message === "warm up two") throw new Error("mock seed failure");
        return super.send(conversation, message);
      }
    }
    const driver = new FailingSeedDriver();
    const scenario = baseScenario({
      seed: { strategy: "replay", turns: [{ user: "warm up one" }, { user: "warm up two" }] },
    });

    await expect(runSeedPhase(scenario, driver, {})).rejects.toMatchObject({
      conversation: { id: "conv-1" },
      turns: [
        expect.objectContaining({ user: "warm up one", isSeed: true }),
        expect.objectContaining({ user: "warm up two", isSeed: true, error: "mock seed failure" }),
      ],
    });
  });
});

describe("filterSeedPhaseToolCalls", () => {
  const calls: ToolCall[] = [
    { name: "seed-tool", index: 0, startedAt: "2026-01-01T00:00:00.000Z" },
    { name: "asserted-tool", index: 1, startedAt: "2026-01-01T00:00:30.000Z" },
    { name: "unknown-timing-tool", index: 2 },
  ];

  it("keeps calls well after the boundary and drops clearly seed-phase ones", () => {
    const filtered = filterSeedPhaseToolCalls(calls, "2026-01-01T00:00:20.000Z");
    expect(filtered?.map((call) => call.name)).toEqual(["asserted-tool", "unknown-timing-tool"]);
  });

  it("keeps calls inside the clock-skew tolerance below the boundary", () => {
    const skewed = [
      ...calls,
      { name: "skewed-tool", index: 3, startedAt: "2026-01-01T00:00:17.000Z" },
    ];
    const filtered = filterSeedPhaseToolCalls(skewed, "2026-01-01T00:00:20.000Z");
    expect(filtered?.map((call) => call.name)).toEqual([
      "asserted-tool",
      "unknown-timing-tool",
      "skewed-tool",
    ]);
  });

  it("keeps calls with an unparseable startedAt rather than guessing them away", () => {
    const malformed = [
      ...calls,
      { name: "malformed-tool", index: 3, startedAt: "not-a-timestamp" },
    ];
    const filtered = filterSeedPhaseToolCalls(malformed, "2026-01-01T00:00:20.000Z");
    expect(filtered?.map((call) => call.name)).toEqual([
      "asserted-tool",
      "unknown-timing-tool",
      "malformed-tool",
    ]);
  });

  it("keeps calls with no startedAt even when a boundary is set", () => {
    const filtered = filterSeedPhaseToolCalls(calls, "2026-01-01T00:00:20.000Z");
    expect(filtered?.map((call) => call.name)).toContain("unknown-timing-tool");
  });

  it("returns calls unchanged when there is no boundary", () => {
    expect(filterSeedPhaseToolCalls(calls, undefined)).toBe(calls);
  });

  it("disables filtering when the boundary itself does not parse", () => {
    expect(filterSeedPhaseToolCalls(calls, "not-a-timestamp")).toBe(calls);
  });

  it("returns undefined unchanged when there is no evidence at all", () => {
    expect(filterSeedPhaseToolCalls(undefined, "2026-01-01T00:00:00.000Z")).toBeUndefined();
  });
});
