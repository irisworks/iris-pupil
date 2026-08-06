import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LangfuseTraceSource } from "../langfuse/index.js";
import type { TraceRecord, TraceSource } from "../trace/index.js";
import { PupilError, type Scenario, type TurnRecord, Verdict } from "../core/types.js";
import {
  RestDriverError,
  type RestConversation,
  type RestDriverResponse,
} from "../driver/index.js";
import { createIrisMockAgent, type IrisMockAgent } from "../mock/irisMockAgent.js";
import { createDrivenTrajectory, runScenario, runScenarios, type RunnerDriver } from "./index.js";

let mock: IrisMockAgent | undefined;

afterEach(async () => {
  vi.useRealTimers();
  if (mock) {
    await mock.close();
    mock = undefined;
  }
});

function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: "runner-basic",
    name: "Runner basic",
    tags: [],
    metadata: {},
    driver: {
      type: "rest",
      preset: "iris-http",
      config: {},
    },
    turns: [{ user: "please schedule", expect: [] }],
    expect: { assertions: [], thresholds: [] },
    ...overrides,
  };
}

async function mockBaseUrl(options: Parameters<typeof createIrisMockAgent>[0] = {}) {
  mock = createIrisMockAgent({ port: 0, ...options });
  const address = await mock.listen();
  return `http://${address.host}:${address.port}`;
}

class FakeDriver implements RunnerDriver {
  readonly closes: string[];
  readonly disposals: { count: number };

  constructor(
    private readonly responseOrError: RestDriverResponse | Error,
    closeSink: string[],
    disposalSink: { count: number },
  ) {
    this.closes = closeSink;
    this.disposals = disposalSink;
  }

  async createConversation(): Promise<RestConversation> {
    return { id: crypto.randomUUID(), raw: {} };
  }

  async send(): Promise<RestDriverResponse> {
    if (this.responseOrError instanceof Error) {
      throw this.responseOrError;
    }
    return this.responseOrError;
  }

  async closeConversation(conversation: RestConversation): Promise<void> {
    this.closes.push(conversation.id);
  }

  dispose(): void {
    this.disposals.count += 1;
  }
}

describe("driven trajectory producer", () => {
  it("converts turn records into evaluator trajectory steps", () => {
    const trajectory = createDrivenTrajectory({
      turns: [
        {
          index: 0,
          user: "please schedule",
          response: { text: "Scheduled.", raw: { status: "ok" } },
          startedAt: "2026-07-31T00:00:00.000Z",
          completedAt: "2026-07-31T00:00:00.250Z",
          latencyMs: 250,
          assertions: [],
        },
      ],
      metrics: { turns: 1, latency_ms: 250 },
      metadata: { sessionId: "session-1" },
    });

    expect(trajectory).toMatchObject({
      source: "driven",
      finalResponse: { text: "Scheduled.", raw: { status: "ok" } },
      metrics: { turns: 1, latency_ms: 250 },
      metadata: { sessionId: "session-1" },
      steps: [
        {
          index: 0,
          input: { role: "user", content: "please schedule" },
          output: { role: "assistant", content: "Scheduled.", raw: { status: "ok" } },
          latencyMs: 250,
        },
      ],
    });
  });

  it("omits metrics by default and exposes turn scores for turn.assertions targets", () => {
    const turn: TurnRecord = {
      index: 0,
      user: "please schedule",
      response: { text: "Scheduled." },
      startedAt: "2026-07-31T00:00:00.000Z",
      assertions: [],
    };
    const trajectory = createDrivenTrajectory({ turns: [turn], currentStepIndex: 0 });

    expect(trajectory.metrics).toEqual({});
    // Scores are assigned after the trajectory is built; the step must see them.
    turn.assertions.push({
      name: "assertion:contains:response.text",
      verdict: Verdict.Pass,
      metadata: {},
    });
    expect(trajectory.steps[0]?.metadata).toEqual({ assertions: turn.assertions });
  });
});

describe("scenario runner", () => {
  it("binds each turn's assertions to that turn's own response", async () => {
    const baseUrl = await mockBaseUrl({
      rules: [
        { match: "schedule", reply: "Scheduled." },
        { match: "cancel", reply: "Cancelled." },
      ],
    });

    const result = await runScenario(
      scenario({
        turns: [
          {
            user: "please schedule",
            expect: [
              { type: "equals", target: "response.text", value: "Scheduled.", caseSensitive: true },
              {
                type: "not_contains",
                target: "response.text",
                value: "Cancelled",
                caseSensitive: true,
              },
            ],
          },
          {
            user: "please cancel",
            expect: [
              { type: "equals", target: "response.text", value: "Cancelled.", caseSensitive: true },
              {
                type: "not_contains",
                target: "response.text",
                value: "Scheduled",
                caseSensitive: true,
              },
            ],
          },
        ],
      }),
      { driverConfig: { baseUrl, originThreadTs: "thread-scoped" } },
    );

    expect(result.verdict).toBe(Verdict.Pass);
    expect(result.turns.flatMap((turn) => turn.assertions).map((score) => score.verdict)).toEqual([
      Verdict.Pass,
      Verdict.Pass,
      Verdict.Pass,
      Verdict.Pass,
    ]);
  });

  it("executes a scenario end to end against the IRIS-compatible mock agent", async () => {
    const baseUrl = await mockBaseUrl({ rules: [{ match: "schedule", reply: "Scheduled." }] });

    const result = await runScenario(scenario(), {
      driverConfig: { baseUrl, originThreadTs: "thread-1" },
    });

    expect(result.verdict).toBe(Verdict.Pass);
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0]?.response?.text).toBe("Scheduled.");
    expect(mock?.requests.map((request) => request.path)).toEqual([
      "/sessions",
      expect.stringMatching(/^\/sessions\/[0-9a-f-]+\/message$/),
      expect.stringMatching(/^\/sessions\/[0-9a-f-]+\/reset$/),
    ]);
  });

  it("evaluates turn-level assertions and aggregates failures", async () => {
    const result = await runScenario(
      scenario({
        turns: [
          {
            user: "please schedule",
            expect: [
              {
                type: "contains",
                target: "response.text",
                value: "Scheduled",
                caseSensitive: false,
              },
              {
                type: "not_contains",
                target: "response.text",
                value: "cancelled",
                caseSensitive: false,
              },
            ],
          },
        ],
      }),
      {
        driverFactory: () =>
          new FakeDriver({ text: "Scheduled.", raw: { text: "Scheduled." } }, [], { count: 0 }),
      },
    );

    expect(result.verdict).toBe(Verdict.Pass);
    expect(result.turns[0]?.assertions.map((score) => score.verdict)).toEqual([
      Verdict.Pass,
      Verdict.Pass,
    ]);
    expect(result.scores).toHaveLength(2);
  });

  it("marks scenarios failed when turn-level assertions fail", async () => {
    const result = await runScenario(
      scenario({
        turns: [
          {
            user: "please schedule",
            expect: [
              {
                type: "contains",
                target: "response.text",
                value: "Scheduled",
                caseSensitive: false,
              },
            ],
          },
        ],
      }),
      {
        driverFactory: () =>
          new FakeDriver({ text: "Could not do that.", raw: { text: "Could not do that." } }, [], {
            count: 0,
          }),
      },
    );

    expect(result.verdict).toBe(Verdict.Fail);
    expect(result.turns[0]?.assertions[0]?.verdict).toBe(Verdict.Fail);
    expect(result.scores[0]?.verdict).toBe(Verdict.Fail);
  });

  it("evaluates scenario-level assertions against the final response", async () => {
    const result = await runScenario(
      scenario({
        expect: {
          assertions: [
            {
              type: "jsonpath",
              target: "response.raw",
              path: "$.status",
              equals: "ok",
            },
          ],
          thresholds: [],
        },
      }),
      {
        driverFactory: () =>
          new FakeDriver({ text: "Scheduled.", raw: { status: "ok" } }, [], { count: 0 }),
      },
    );

    expect(result.verdict).toBe(Verdict.Pass);
    expect(result.scores[0]?.verdict).toBe(Verdict.Pass);
  });
  it("marks scenarios failed when measured thresholds fail", async () => {
    const result = await runScenario(
      scenario({
        expect: {
          assertions: [],
          thresholds: [{ metric: "maxTurns", max: 0 }],
        },
      }),
      {
        driverFactory: () =>
          new FakeDriver({ text: "Scheduled.", raw: { status: "ok" } }, [], { count: 0 }),
      },
    );

    expect(result.verdict).toBe(Verdict.Fail);
    expect(result.scores.some((score) => score.name === "threshold:maxTurns")).toBe(true);
  });

  it("skips missing cost thresholds without failing the scenario", async () => {
    const result = await runScenario(
      scenario({
        expect: {
          assertions: [],
          thresholds: [{ metric: "maxCostUsd", max: 0.01 }],
        },
      }),
      {
        driverFactory: () =>
          new FakeDriver({ text: "Scheduled.", raw: { status: "ok" } }, [], { count: 0 }),
      },
    );

    expect(result.verdict).toBe(Verdict.Pass);
    expect(result.scores.find((score) => score.name === "threshold:maxCostUsd")?.verdict).toBe(
      Verdict.Skip,
    );
  });

  it("scores cost thresholds against Langfuse-enriched metrics", async () => {
    const calls: string[] = [];
    const result = await runScenario(
      scenario({
        expect: {
          assertions: [],
          thresholds: [{ metric: "maxCostUsd", max: 0.01 }],
        },
      }),
      {
        driverFactory: () =>
          new FakeDriver({ text: "Scheduled.", raw: { status: "ok" } }, [], { count: 0 }),
        traceSource: new LangfuseTraceSource(
          { baseUrl: "http://langfuse.local", publicKey: "pk", secretKey: "sk" },
          (async (url: string) => {
            calls.push(String(url));
            return {
              ok: true,
              status: 200,
              json: async () =>
                calls.length === 1
                  ? { data: [{ id: "trace-1" }] }
                  : { id: "trace-1", totalCost: 0.02 },
            };
          }) as unknown as typeof fetch,
          { waitMs: 0 },
        ),
      },
    );

    expect(calls).toHaveLength(2);
    expect(result.metrics.cost_usd).toBe(0.02);
    expect(result.verdict).toBe(Verdict.Fail);
    expect(result.scores.find((score) => score.name === "threshold:maxCostUsd")?.verdict).toBe(
      Verdict.Fail,
    );
  });

  it("enriches errored scenarios with the conversation session id", async () => {
    const result = await runScenario(scenario(), {
      driverFactory: () =>
        new FakeDriver(new RestDriverError(400, { error: "bad request" }), [], { count: 0 }),
      traceSource: new LangfuseTraceSource(
        { baseUrl: "http://langfuse.local", publicKey: "pk", secretKey: "sk" },
        (async (url: string) => ({
          ok: true,
          status: 200,
          json: async () =>
            String(url).includes("/api/public/traces/trace-err")
              ? { id: "trace-err", url: "http://langfuse.local/t/trace-err" }
              : { data: [{ id: "trace-err" }] },
        })) as unknown as typeof fetch,
        { waitMs: 0 },
      ),
    });

    expect(result.verdict).toBe(Verdict.Error);
    expect(typeof result.metadata?.sessionId).toBe("string");
    expect(result.metadata?.langfuse).toMatchObject({
      status: "enriched",
      traceId: "trace-err",
      traceUrl: "http://langfuse.local/t/trace-err",
    });
  });

  it("counts scenario runtime toward the Langfuse initial delay", async () => {
    vi.useFakeTimers();
    const started = Date.parse("2026-07-31T00:00:00.000Z");
    vi.setSystemTime(started);
    const calls: number[] = [];

    const resultPromise = runScenario(scenario(), {
      driverFactory: () => ({
        async createConversation() {
          return { id: "session-1", raw: {} };
        },
        async send() {
          vi.setSystemTime(started + 6000);
          return { text: "Scheduled.", raw: { status: "ok" } };
        },
        async closeConversation() {},
      }),
      traceSource: new LangfuseTraceSource(
        { baseUrl: "http://langfuse.local", publicKey: "pk", secretKey: "sk" },
        (async (url: string) => {
          calls.push(Date.now());
          return {
            ok: true,
            status: 200,
            json: async () =>
              String(url).includes("/api/public/traces/trace-1")
                ? { id: "trace-1", totalCost: 0.001 }
                : { data: [{ id: "trace-1" }] },
          };
        }) as unknown as typeof fetch,
        { initialDelayMs: 8000, waitMs: 15000, initialBackoffMs: 1000 },
      ),
    });

    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;

    expect(calls[0]).toBe(started + 6000);
    expect(result.metadata?.langfuse).toMatchObject({ status: "enriched" });
  });

  it("omits metadata and skips enrichment when Langfuse is disabled", async () => {
    const result = await runScenarios([scenario()], {
      driverFactory: () =>
        new FakeDriver({ text: "Scheduled.", raw: { status: "ok" } }, [], { count: 0 }),
      traceSource: false,
    });

    expect(result.metadata.langfuse).toBeUndefined();
    expect(result.results[0]?.metadata?.langfuse).toBeUndefined();
    expect(result.results[0]?.metrics.cost_usd).toBeUndefined();
  });

  it("marks manual scenarios as needs_review", async () => {
    const result = await runScenario(
      scenario({
        expect: {
          assertions: [],
          thresholds: [],
          manual: { required: true, criteria: ["correctness"], rubric: [] },
        },
      }),
      {
        driverFactory: () =>
          new FakeDriver({ text: "Scheduled.", raw: { status: "ok" } }, [], { count: 0 }),
      },
    );

    expect(result.verdict).toBe(Verdict.NeedsReview);
    expect(result.scores.find((score) => score.name === "manual:correctness")?.verdict).toBe(
      Verdict.NeedsReview,
    );
  });

  it("emits skipped judge scores without requiring LLM judge configuration", async () => {
    const result = await runScenario(
      scenario({
        expect: {
          assertions: [],
          thresholds: [],
          judge: { enabled: true, prompt: "Judge this response.", rubric: [] },
        },
      }),
      {
        driverFactory: () =>
          new FakeDriver({ text: "Scheduled.", raw: { status: "ok" } }, [], { count: 0 }),
      },
    );

    expect(result.verdict).toBe(Verdict.Pass);
    expect(result.scores.find((score) => score.name === "judge")).toMatchObject({
      verdict: Verdict.Skip,
      reason: "LLM judge not configured",
    });
  });

  it("retries transport errors and closes failed conversations", async () => {
    const closes: string[] = [];
    const disposals = { count: 0 };
    const failures = [new RestDriverError(504, { error: "timeout" })];

    const result = await runScenario(scenario(), {
      retries: 1,
      driverFactory: () => {
        const error = failures.shift();
        return new FakeDriver(error ?? { text: "ok", raw: { text: "ok" } }, closes, disposals);
      },
    });

    expect(result.verdict).toBe(Verdict.Pass);
    expect(result.metrics.retries).toBe(1);
    expect(closes).toHaveLength(2);
    expect(disposals.count).toBe(2);
  });

  it("does not retry non-transport contract errors", async () => {
    const closes: string[] = [];
    const disposals = { count: 0 };
    let attempts = 0;

    const result = await runScenario(scenario(), {
      retries: 2,
      driverFactory: () => {
        attempts += 1;
        return new FakeDriver(
          new RestDriverError(400, { error: "bad request" }),
          closes,
          disposals,
        );
      },
    });

    expect(result.verdict).toBe(Verdict.Error);
    expect(result.metrics.retries).toBe(0);
    expect(attempts).toBe(1);
    expect(closes).toHaveLength(1);
  });

  it("retries timeout errors only when retry budget is available", async () => {
    let attempts = 0;

    const result = await runScenario(scenario(), {
      retries: 1,
      driverFactory: () => {
        attempts += 1;
        if (attempts === 1) {
          return new FakeDriver(new PupilError("REST request timed out after 10ms"), [], {
            count: 0,
          });
        }
        return new FakeDriver({ text: "ok", raw: { text: "ok" } }, [], { count: 0 });
      },
    });

    expect(result.verdict).toBe(Verdict.Pass);
    expect(attempts).toBe(2);
  });

  it("limits scenario concurrency", async () => {
    let active = 0;
    let maxActive = 0;
    const scenarios = ["a", "b", "c", "d"].map((id) => scenario({ id, name: id }));

    const result = await runScenarios(scenarios, {
      concurrency: 2,
      driverFactory: () => ({
        async createConversation() {
          active += 1;
          maxActive = Math.max(maxActive, active);
          return { id: crypto.randomUUID(), raw: {} };
        },
        async send() {
          await delay(25);
          return { text: "ok", raw: { text: "ok" } };
        },
        async closeConversation() {
          active -= 1;
        },
      }),
    });

    expect(result.verdict).toBe(Verdict.Pass);
    expect(result.summary.passed).toBe(4);
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});

describe("FakeTraceSource (AC2: second backend needs no core changes)", () => {
  class FakeTraceSource implements TraceSource {
    readonly metadataKey = "fake";
    private readonly records = new Map<string, TraceRecord>();
    private shouldThrow = false;

    seed(sessionId: string, record: TraceRecord): void {
      this.records.set(sessionId, record);
    }

    failNext(): void {
      this.shouldThrow = true;
    }

    async resolve(sessionId: string): Promise<TraceRecord | undefined> {
      await new Promise((r) => setTimeout(r, 0));
      if (this.shouldThrow) {
        this.shouldThrow = false;
        throw new Error("backend unavailable");
      }
      return this.records.get(sessionId);
    }
  }

  const SESSION_ID = "fake-session-abc123";

  function driverWithSession(response: {
    text: string;
    raw: Record<string, unknown>;
  }): RunnerDriver {
    return {
      async createConversation() {
        return { id: SESSION_ID, raw: {} };
      },
      async send() {
        return response;
      },
      async closeConversation() {},
    };
  }

  it("records skipped status when no trace record is seeded", async () => {
    const fakeSource = new FakeTraceSource();

    const result = await runScenario(scenario(), {
      driverFactory: () => driverWithSession({ text: "ok", raw: {} }),
      traceSource: fakeSource,
    });

    expect(result.verdict).toBe(Verdict.Pass);
    expect(result.metadata?.fake).toMatchObject({ status: "skipped" });
  });

  it("enriches metrics when a record is seeded for the session", async () => {
    const fakeSource = new FakeTraceSource();
    fakeSource.seed(SESSION_ID, {
      traceCount: 1,
      costUsd: 0.05,
      toolCalls: ["search", "read_file"],
    });

    const result = await runScenario(scenario(), {
      driverFactory: () => driverWithSession({ text: "ok", raw: {} }),
      traceSource: fakeSource,
    });

    expect(result.verdict).toBe(Verdict.Pass);
    expect(result.metadata?.fake).toMatchObject({ status: "enriched" });
    expect(result.metrics.cost_usd).toBe(0.05);
    expect(result.metrics.tool_calls).toBe(2);
  });

  it("records error status when resolve() throws, verdict unchanged", async () => {
    const fakeSource = new FakeTraceSource();
    fakeSource.failNext();

    const result = await runScenario(scenario(), {
      driverFactory: () => driverWithSession({ text: "ok", raw: {} }),
      traceSource: fakeSource,
    });

    expect(result.verdict).toBe(Verdict.Pass);
    expect(result.metadata?.fake).toMatchObject({
      status: "error",
      reason: "backend unavailable",
    });
  });
});
