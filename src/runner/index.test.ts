import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LangfuseTraceSource } from "../langfuse/index.js";
import {
  NO_CORRELATION_KEY_REASON,
  type TraceLookupContext,
  type TraceRecord,
  type TraceSource,
} from "../trace/index.js";
import { PupilError, type Scenario, type TurnRecord, Verdict } from "../core/types.js";
import {
  RestDriverError,
  type RestConversation,
  type RestDriverResponse,
} from "../driver/index.js";
import {
  createIrisMockAgent,
  createMockAgentBundle,
  type IrisMockAgent,
} from "../mock/irisMockAgent.js";
import {
  createDrivenTrajectory,
  progressEventTypeForVerdict,
  runScenario,
  runScenarios,
  type RunnerDriver,
} from "./index.js";

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
  it("lets a scenario's own driver.config override project-wide driverConfig defaults", async () => {
    const seenConfigs: Record<string, unknown>[] = [];

    await runScenario(
      scenario({ driver: { type: "rest", preset: "iris-http", config: { timeoutMs: 42 } } }),
      {
        projectDriverConfig: { timeoutMs: 1000, retries: 3 },
        driverFactory: (_scenario, context) => {
          seenConfigs.push(context.config);
          return {
            async createConversation() {
              return { id: crypto.randomUUID(), raw: {} };
            },
            async send() {
              return { text: "ok", raw: {} };
            },
            async closeConversation() {},
          };
        },
      },
    );

    // Scenario-level config must win over project-wide defaults on key collision,
    // while non-conflicting project defaults still apply.
    expect(seenConfigs[0]).toMatchObject({ timeoutMs: 42, retries: 3 });
  });

  it("lets explicit driverConfig overrides win over both scenario and project config", async () => {
    const seenConfigs: Record<string, unknown>[] = [];

    await runScenario(
      scenario({ driver: { type: "rest", preset: "iris-http", config: { timeoutMs: 42 } } }),
      {
        projectDriverConfig: { timeoutMs: 1000 },
        driverConfig: { timeoutMs: 7 },
        driverFactory: (_scenario, context) => {
          seenConfigs.push(context.config);
          return {
            async createConversation() {
              return { id: crypto.randomUUID(), raw: {} };
            },
            async send() {
              return { text: "ok", raw: {} };
            },
            async closeConversation() {},
          };
        },
      },
    );

    expect(seenConfigs[0]).toMatchObject({ timeoutMs: 7 });
  });

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

  it("skips tool assertions without evidence and stays green by default", async () => {
    const result = await runScenario(
      scenario({
        expect: {
          assertions: [{ type: "tool_called", tool: "calendar.create", match: "exact" }],
          thresholds: [],
        },
      }),
      {
        driverFactory: () =>
          new FakeDriver({ text: "Scheduled.", raw: { status: "ok" } }, [], { count: 0 }),
        traceSource: false,
      },
    );

    expect(result.verdict).toBe(Verdict.Pass);
    expect(result.scores[0]?.verdict).toBe(Verdict.Skip);
  });

  it("fails tool assertions without evidence when requireTrace is set", async () => {
    const result = await runScenario(
      scenario({
        expect: {
          assertions: [{ type: "tool_called", tool: "calendar.create", match: "exact" }],
          thresholds: [],
        },
      }),
      {
        driverFactory: () =>
          new FakeDriver({ text: "Scheduled.", raw: { status: "ok" } }, [], { count: 0 }),
        traceSource: false,
        requireTrace: true,
      },
    );

    expect(result.verdict).toBe(Verdict.Fail);
    expect(result.scores[0]?.verdict).toBe(Verdict.Fail);
    expect(result.scores[0]?.reason).toContain("--require-trace");
  });

  it("does not escalate skips that are unrelated to tool evidence", async () => {
    const result = await runScenario(
      scenario({
        expect: { assertions: [], thresholds: [{ metric: "cost_usd", max: 1 }] },
      }),
      {
        driverFactory: () =>
          new FakeDriver({ text: "Scheduled.", raw: { status: "ok" } }, [], { count: 0 }),
        traceSource: false,
        requireTrace: true,
      },
    );

    expect(result.scores[0]?.verdict).toBe(Verdict.Skip);
    expect(result.verdict).toBe(Verdict.Pass);
  });

  it("scores tool assertions end to end against the mock agent", async () => {
    const bundle = createMockAgentBundle({
      port: 0,
      rules: [{ match: /book/i, reply: "Booked." }],
      traceRules: [
        {
          match: /book/i,
          toolCalls: ["search", { name: "calendar.create", args: { title: "Standup" } }],
        },
      ],
    });
    mock = bundle.agent;
    const address = await mock.listen();
    const baseUrl = `http://${address.host}:${address.port}`;

    const result = await runScenario(
      scenario({
        turns: [{ user: "book a standup", expect: [] }],
        driver: { type: "rest", preset: "iris-http", config: { baseUrl } },
        expect: {
          assertions: [
            { type: "tool_called", tool: "calendar.create", times: 1, match: "exact" },
            { type: "tool_not_called", tool: "email.send", match: "exact" },
            { type: "tool_order", tools: ["search", "calendar.create"], match: "exact" },
            {
              type: "tool_args",
              tool: "calendar.create",
              equals: { title: "Standup" },
              match: "exact",
            },
          ],
          thresholds: [],
        },
      }),
      { traceSource: bundle.traceSource },
    );

    expect(result.verdict).toBe(Verdict.Pass);
    expect(result.metrics.tool_calls).toBe(2);
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

describe("runScenarios target identity", () => {
  it("writes target onto the RunResult when provided", async () => {
    const closes: string[] = [];
    const disposals = { count: 0 };
    const fakeDriver = new FakeDriver({ text: "ok", raw: {} }, closes, disposals);

    const result = await runScenarios([scenario()], {
      traceSource: false,
      target: { mode: "driven", system: "support-agent", environment: "staging" },
      driverFactory: () => fakeDriver,
    });

    expect(result.target).toEqual({
      mode: "driven",
      system: "support-agent",
      environment: "staging",
    });
  });

  it("leaves target undefined when not provided", async () => {
    const closes: string[] = [];
    const disposals = { count: 0 };
    const fakeDriver = new FakeDriver({ text: "ok", raw: {} }, closes, disposals);

    const result = await runScenarios([scenario()], {
      traceSource: false,
      driverFactory: () => fakeDriver,
    });

    expect(result.target).toBeUndefined();
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

    readonly seen: { key: string; startedAt?: number }[] = [];

    async resolve(
      sessionId: string,
      context?: TraceLookupContext,
    ): Promise<TraceRecord | undefined> {
      this.seen.push({ key: sessionId, startedAt: context?.startedAt });
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
      toolCalls: [
        { name: "search", index: 0 },
        { name: "read_file", index: 1 },
      ],
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

  it("passes the attempt start time so backends can discount scenario runtime", async () => {
    const fakeSource = new FakeTraceSource();
    const before = Date.now();

    await runScenario(scenario(), {
      driverFactory: () => driverWithSession({ text: "ok", raw: {} }),
      traceSource: fakeSource,
    });

    expect(fakeSource.seen).toHaveLength(1);
    expect(fakeSource.seen[0]?.key).toBe(SESSION_ID);
    expect(fakeSource.seen[0]?.startedAt).toBeGreaterThanOrEqual(before);
    expect(fakeSource.seen[0]?.startedAt).toBeLessThanOrEqual(Date.now());
  });

  it("distinguishes a missing correlation key from a trace that was not found", async () => {
    const fakeSource = new FakeTraceSource();

    const result = await runScenario(scenario(), {
      driverFactory: () => ({
        async createConversation() {
          return { id: "", raw: {} };
        },
        async send() {
          return { text: "ok", raw: {} };
        },
        async closeConversation() {},
      }),
      traceSource: fakeSource,
    });

    // No key existed, so no lookup was attempted and no empty sessionId is persisted.
    expect(fakeSource.seen).toHaveLength(0);
    expect(result.metadata?.sessionId).toBeUndefined();
    expect(result.metadata?.fake).toEqual({
      status: "skipped",
      reason: NO_CORRELATION_KEY_REASON,
    });
  });

  it("skips enrichment entirely when traceSource is false", async () => {
    const result = await runScenario(scenario(), {
      driverFactory: () => driverWithSession({ text: "ok", raw: {} }),
      traceSource: false,
    });

    expect(result.metadata).toEqual({ sessionId: SESSION_ID });
  });

  it("falls back to environment Langfuse when traceSource is omitted", async () => {
    // Unconfigured environment resolves to no source, so results stay untouched.
    const result = await runScenario(scenario(), {
      driverFactory: () => driverWithSession({ text: "ok", raw: {} }),
    });

    expect(result.metadata).toEqual({ sessionId: SESSION_ID });
    expect(LangfuseTraceSource.fromSettings(undefined, {})).toBeUndefined();
    expect(
      LangfuseTraceSource.fromSettings(undefined, {
        LANGFUSE_HOST: "http://langfuse.local",
        LANGFUSE_PUBLIC_KEY: "pk",
        LANGFUSE_SECRET_KEY: "sk",
      }),
    ).toBeInstanceOf(LangfuseTraceSource);
  });

  it("copies tool calls from the trace source onto the trajectory", async () => {
    const toolSource: TraceSource = {
      metadataKey: "mock",
      resolve: () =>
        Promise.resolve({
          traceCount: 1,
          toolCalls: [
            { name: "search", index: 0 },
            { name: "search", index: 1 },
          ],
        }),
    };

    const result = await runScenario(
      scenario({
        expect: { assertions: [], thresholds: [{ metric: "tool_calls", max: 5 }] },
      }),
      {
        driverFactory: () =>
          new FakeDriver({ text: "Scheduled.", raw: { status: "ok" } }, [], { count: 0 }),
        traceSource: toolSource,
      },
    );

    expect(result.metrics.tool_calls).toBe(2);
    expect(result.verdict).toBe(Verdict.Pass);
  });

  it("places tool calls with full args onto trajectory.toolCalls, not just metrics", async () => {
    const toolSource: TraceSource = {
      metadataKey: "mock",
      resolve: () =>
        Promise.resolve({
          traceCount: 1,
          toolCalls: [{ name: "search", index: 0, args: { city: "NYC", limit: 5 } }],
        }),
    };

    const result = await runScenario(
      scenario({
        expect: {
          assertions: [
            { type: "jsonpath", target: "trajectory", path: "$.toolCalls.length", equals: 1 },
            {
              type: "jsonpath",
              target: "trajectory",
              path: "$.toolCalls[0].name",
              equals: "search",
            },
            {
              type: "jsonpath",
              target: "trajectory",
              path: "$.toolCalls[0].args.city",
              equals: "NYC",
            },
            {
              type: "jsonpath",
              target: "trajectory",
              path: "$.toolCalls[0].args.limit",
              equals: 5,
            },
          ],
          thresholds: [],
        },
      }),
      {
        driverFactory: () =>
          new FakeDriver({ text: "Scheduled.", raw: { status: "ok" } }, [], { count: 0 }),
        traceSource: toolSource,
      },
    );

    // Every assertion above reads trajectory.toolCalls, not result.metadata, so a
    // regression that routes args through the names-only metadata path (instead of
    // returning them from enrichWithTraceSource) would fail this test.
    expect(result.verdict).toBe(Verdict.Pass);
    for (const score of result.scores) {
      expect(score.verdict).toBe(Verdict.Pass);
    }
  });

  it("sets trajectory.toolCalls to [] (not undefined) when the source found evidence of no calls", async () => {
    const emptySource: TraceSource = {
      metadataKey: "mock",
      resolve: () => Promise.resolve({ traceCount: 1, toolCalls: [] }),
    };

    const result = await runScenario(
      scenario({
        expect: {
          assertions: [
            { type: "jsonpath", target: "trajectory", path: "$.toolCalls", exists: true },
            { type: "jsonpath", target: "trajectory", path: "$.toolCalls.length", equals: 0 },
          ],
          thresholds: [],
        },
      }),
      {
        driverFactory: () =>
          new FakeDriver({ text: "Scheduled.", raw: { status: "ok" } }, [], { count: 0 }),
        traceSource: emptySource,
      },
    );

    expect(result.verdict).toBe(Verdict.Pass);
    for (const score of result.scores) {
      expect(score.verdict).toBe(Verdict.Pass);
    }
  });

  it("leaves trajectory.toolCalls undefined (not []) when there is no trace evidence", async () => {
    const result = await runScenario(
      scenario({
        expect: {
          assertions: [
            { type: "jsonpath", target: "trajectory", path: "$.toolCalls", exists: false },
          ],
          thresholds: [],
        },
      }),
      {
        driverFactory: () =>
          new FakeDriver({ text: "Scheduled.", raw: { status: "ok" } }, [], { count: 0 }),
        traceSource: false,
      },
    );

    expect(result.verdict).toBe(Verdict.Pass);
    for (const score of result.scores) {
      expect(score.verdict).toBe(Verdict.Pass);
    }
  });
});

describe("progressEventTypeForVerdict", () => {
  it("maps every verdict to its own progress event type", () => {
    expect(progressEventTypeForVerdict(Verdict.Pass)).toBe("scenario:pass");
    expect(progressEventTypeForVerdict(Verdict.Skip)).toBe("scenario:skip");
    expect(progressEventTypeForVerdict(Verdict.NeedsReview)).toBe("scenario:needs_review");
    expect(progressEventTypeForVerdict(Verdict.Fail)).toBe("scenario:fail");
    expect(progressEventTypeForVerdict(Verdict.Error)).toBe("scenario:error");
  });
});
