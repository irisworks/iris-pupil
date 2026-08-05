# Pupil — AI Agent Quality Engineering

Pupil is an open-source testing framework for AI agents. Think of it like Jest or Pytest, but instead of testing functions, it sends messages to your agent over HTTP and scores the responses against rules you define.

It originated in the IRIS ecosystem but works with any agent that speaks HTTP.

---

## Why does this exist?

Building an AI agent is easy. Knowing it still works after today's change is hard.

Teams hit the same questions repeatedly:
- Did this prompt change break an existing workflow?
- Is the agent taking more turns than before?
- Which tool call failed?
- Did task completion improve or regress between model versions?
- What did this run cost in tokens and dollars?

Pupil answers these with repeatable evaluations stored as JSON, compared against a baseline, and surfaced as pass / fail / regression.

---

## Core Principles

| Principle | Meaning |
|---|---|
| **Framework agnostic** | Talks to your agent through its HTTP interface. Doesn't care what's inside. |
| **Black-box by default** | Evaluates through the public interface, like a real user would. |
| **Regression first** | The primary job is detecting when a passing scenario starts failing. |
| **Observability friendly** | Langfuse traces are enriched in automatically — cost, tokens, tool calls. |
| **Open and extensible** | Drivers, evaluators, and scoring plugins are small interfaces you can swap. |

---

## Quick Start

```bash
npm install
npm run build

# validate a scenario file
node dist/cli/index.js validate examples/scenarios/iris-basic.yaml

# run against a live agent
node dist/cli/index.js run \
  --base-url https://your-agent.example.com \
  --bearer-token $IRIS_API_TOKEN
```

A minimal scenario:

```yaml
id: book-meeting
name: Book a meeting
driver:
  preset: iris-http

input: Schedule a 30-minute meeting with John tomorrow at 2 PM.

expect:
  assertions:
    - type: contains
      value: confirmed
  thresholds:
    - metric: turns
      max: 3
```

---

## Architecture

```
           CLI  (src/cli/index.ts)
            │
            ▼
          Runner  (src/runner/index.ts)
            │  retries · timeout · concurrency
            ▼
        REST Driver  (src/driver/index.ts)
            │  createConversation · send · close
            ▼
        Your AI Agent  (any HTTP endpoint)

  Side systems:
  ├── Evaluator    (src/eval/index.ts)       — assertions + thresholds → Score[]
  ├── Langfuse     (src/langfuse/index.ts)   — cost / tokens / trace url
  ├── History      (src/history/index.ts)    — .pupil/runs/*.json
  ├── Scenarios    (src/scenario/)           — YAML loader + schema
  └── Regression   (src/history/compare.ts) — diff two RunResults
```

---

## Data Flow — End to End

What happens when you run `pupil run`:

**1. Load config + scenarios**
`loadPupilConfig()` reads `pupil.config.yaml`, resolves `${ENV_VAR}` references, and validates with Zod. `loadScenarios()` recursively finds `*.yaml` files and normalizes each into a `Scenario` object.

**2. Create a driver per scenario**
`createDriverForScenario()` inspects `scenario.driver.type`. For the `iris-http` preset it builds a `RestDriver` pre-configured for the IRIS session API. For generic `rest` it uses raw config from the YAML.

**3. Execute each turn**
`executeAttempt()` calls `driver.createConversation()` to open a session, then loops over `scenario.turns`, calling `driver.send()` for each user message. Each response is recorded as a `TurnRecord` with latency timestamps.

**4. Evaluate per-turn assertions**
After each `send()`, per-turn assertions from `turn.expect` are evaluated immediately against a `Trajectory` scoped to that turn index. Results land in `turn.assertions`.

**5. Enrich with Langfuse**
Before scoring thresholds, `enrichScenarioWithLangfuse()` polls the Langfuse API for a trace matching the session ID. On success it writes `cost_usd`, `input_tokens`, `output_tokens`, `tool_calls` into `result.metrics`.

**6. Evaluate scenario assertions & thresholds**
`evaluateAssertions()` runs scenario-level checks against the full `Trajectory`. `evaluateThresholds()` compares metric values against min/max bounds. All scores collapse via `aggregateVerdicts()` into the final `Verdict`.

**7. Store results**
`JsonRunHistoryStore.writeRun()` writes the complete `RunResult` as `.pupil/runs/{uuid}.json` and appends a summary line to `.pupil/index.jsonl`. Writes are atomic (write temp → rename) so a crash never corrupts history.

**8. Compare against baseline**
`compareRuns(base, current)` diffs every scenario by ID, classifying each as *regressed*, *fixed*, *still_failing*, *unchanged*, *new*, or *removed*.

---

## Modules

### `src/core/types.ts` — Core Types

The shared vocabulary every other module speaks. Nothing here imports from anywhere else in the project.

**Verdict** — the fundamental outcome enum:

| Verdict | Severity | Meaning |
|---|---|---|
| `error` | 3 | Driver threw, scenario never completed |
| `fail` | 2 | One or more assertions / thresholds failed |
| `needs_review` | 1 | Manual scoring block is required |
| `skip` | 0 | Check was not applicable |
| `pass` | 0 | All checks satisfied |

When aggregating multiple scores, the worst verdict wins: `error > fail > needs_review > pass/skip`.

**Trajectory** — the primary data structure passed to the Evaluator. A normalized view of what happened:

```typescript
interface Trajectory {
  source: "driven" | "trace";    // how it was produced
  steps: TrajectoryStep[];       // one entry per turn
  currentStepIndex?: number;     // scopes per-turn assertions
  finalResponse?: { text, raw }; // last agent response
  metrics: Record<string, number>; // turns, latency_ms, cost_usd …
  metadata: Record<string, unknown>;
  snapshot?: ScenarioResult;     // backward-compat for result.* targets
}
```

The `"driven"` source means Pupil drove the conversation itself. A future `"trace"` source would read from Langfuse/OTel spans — the evaluator doesn't need to care which it gets.

---

### `src/core/config.ts` — Config

Loads and validates `pupil.config.yaml`.

Resolves `${VAR}` and `${VAR:-default}` references against environment variables using the same rules as bash:
- `${VAR}` — substitutes even an empty string; only errors if VAR is genuinely unset.
- `${VAR:-default}` — uses `default` when VAR is unset *or* empty.

Config shape:

```yaml
scenarios: examples/scenarios   # file or directory

driver:
  type: rest
  config:
    baseUrl: ${IRIS_BASE_URL}
    bearerToken: ${IRIS_API_TOKEN:-}

history:
  dir: .pupil

langfuse:
  enabled: auto     # auto = use if keys present
  waitMs: 10000
  timeoutMs: 3000
```

---

### `src/scenario/` — Scenarios

Parses and normalizes YAML scenario files into typed `Scenario` objects.

**Shorthand vs. multi-turn** — both normalize to the same internal shape:

```yaml
# Shorthand — single input string
id: ping
input: Hello, are you there?

---
# Multi-turn — explicit turns array
id: book-refine
turns:
  - user: Book a meeting with John tomorrow
    expect:
      - type: contains
        value: What time works
  - user: 2pm please
    expect:
      - type: contains
        value: confirmed
```

`normalizeScenario()` merges shorthand top-level `assertions`/`thresholds` into the `expect` block, fills in driver defaults, and converts `input` string to a single-turn array.

---

### `src/driver/index.ts` — REST Driver

Sends HTTP requests to the agent using configurable request templates.

Three operations:

| Method | What it calls | Returns |
|---|---|---|
| `createConversation(ctx)` | POST /sessions | `RestConversation {id, raw}` |
| `send(conv, message)` | POST /sessions/:id/message | `RestDriverResponse {text, raw}` |
| `closeConversation(conv)` | POST /sessions/:id/reset | void |

**Template system** — request paths and body values support `{{variable}}` placeholders filled at call time:

```typescript
send: {
  path: "/sessions/{{conversationId}}/message",
  body: { text: "{{message}}" }
}
// conversationId and message are injected automatically at runtime.
```

**Retry behavior** — retries on status codes `408, 429, 500, 502, 503, 504` with exponential backoff (25ms → 250ms cap). A global `AbortController` lets the Runner cancel all in-flight requests on timeout.

**IRIS HTTP Preset** (`src/driver/presets.ts`) — `createIrisHttpPreset()` returns a fully-wired `RestDriverConfig` targeting the IRIS session API. Scenario YAML only needs `preset: iris-http`.

---

### `src/runner/index.ts` — Runner

The engine that drives scenarios and collects results.

**`runScenario()`** — simplified flow:

```
for attempt in 1..maxAttempts:
  driver = createDriver(scenario)
  result = await executeAttempt(scenario, driver, timeout)

  if success:
    await enrichWithLangfuse(result)   // adds cost/tokens
    scores = evaluateAll(result)       // assertions + thresholds
    return { ...result, verdict, scores }

  if retryable error:
    continue
  break

return errorResult
```

**Concurrency** — `runScenarios(scenarios, {concurrency})` runs up to `concurrency` scenarios in parallel using a worker-pool pattern over a shared cursor. Default is 1 (sequential).

**`createDrivenTrajectory()`** — converts raw `TurnRecord[]` into a `Trajectory` the Evaluator understands. Per-turn assertions use a scoped `currentStepIndex` so they can't read a different turn's response.

---

### `src/eval/index.ts` — Evaluator

Stateless functions that take a `Trajectory` and return `Score[]`.

**Assertion types:**

| type | What it checks |
|---|---|
| `contains` | Response text includes the value (case-insensitive by default) |
| `not_contains` | Response text does *not* include the value |
| `equals` | Response text exactly equals the value |
| `regex` | Response text matches the regex pattern |
| `jsonpath` | A JSON path in the raw response exists or equals a value |

**Assertion targets** — the `target` field says *what* to check:

| target | Resolves to |
|---|---|
| `response.text` | The agent's plain-text reply |
| `response.raw` | The full JSON response body |
| `response.raw.someField` | A nested field in the raw response |
| `result.metrics.turns` | Number of turns in the scenario |
| `trajectory` | The full Trajectory object |

**Thresholds** — check numeric metrics with `min` and/or `max` bounds. Recognized metric names:

```
turns        → result.metrics.turns
latency_ms   → result.metrics.latency_ms
cost_usd     → result.metrics.cost_usd  (from Langfuse)
input_tokens → result.metrics.input_tokens
total_tokens → result.metrics.total_tokens
```

If the metric is missing (e.g. Langfuse was skipped), a `cost_usd` threshold returns `skip` rather than `fail`.

---

### `src/langfuse/index.ts` — Langfuse Enrichment

Best-effort enrichment of scenario results with trace data after each scenario finishes.

How it works:

1. **Resolve config** — checks `pupil.config.yaml`'s `langfuse` block first, then `LANGFUSE_HOST` / `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` from the environment. If keys are absent, returns silently.

2. **Find the session ID** — checks `result.metadata.sessionId`, then walks `result.turns[*].response.raw` looking for `sessionId`, `session_id`, or `id` fields.

3. **Poll with exponential backoff** — Langfuse ingests traces asynchronously, so Pupil polls `GET /api/public/traces?sessionId=…` with an initial delay (default 8s) and exponential backoff (1s → 15s cap) until `waitMs` (default 25s) is exhausted.

4. **Write enrichment into result** — on success, writes `cost_usd`, `input_tokens`, `output_tokens`, `total_tokens`, `tool_calls` into `result.metrics`, and the trace URL into `result.metadata.langfuse`.

> Langfuse failures never change a scenario's verdict. If polling times out or errors, the status is recorded as `"skipped"` or `"error"` in `metadata.langfuse` and execution continues.

Token/cost extraction checks all known field name aliases Langfuse uses (`usage.input`, `promptTokens`, `inputTokens`, …) and uses the first non-null value, so it works across Langfuse versions.

---

### `src/history/index.ts` — History Store

Persists run results to disk as newline-delimited JSON.

**File layout:**

```
.pupil/
  index.jsonl          # one JSON line per run (runId, verdict, summary, path)
  baseline             # text file containing the baseline run ID
  runs/
    {uuid}.json        # full RunResult for each run
```

**Atomic writes** — every write goes through `writeFileAtomic()`: writes to a temp file first, then `rename()` into place. A crash can never leave an index or run file half-written.

**Baseline** — `store.setBaseline(runId)` writes the run ID to `.pupil/baseline`. `store.readBaseline()` returns the `RunResult` it points to. The CLI's `compare` command uses this as the "before" side of a regression diff.

---

### `src/history/compare.ts` — Regression Comparison

Diffs two `RunResult` objects scenario-by-scenario.

**Scenario statuses:**

| Status | Meaning |
|---|---|
| `regressed` | Was passing, now failing — the important one |
| `fixed` | Was failing, now passing — good news |
| `still_failing` | Was failing, still failing — known issue |
| `unchanged` | Same verdict as before |
| `new` | Scenario only in the current run |
| `removed` | Scenario only in the base run |

**Metric deltas** — for each scenario, every metric (turns, latency_ms, cost_usd, …) is compared. If a metric increased beyond a configurable threshold, it's flagged as a metric regression even if the verdict didn't change:

```typescript
compareRuns(base, current, {
  latencyRegressionThresholdMs: 500
});
```

---

### `src/cli/index.ts` — CLI

Thin commander wrapper around the Runner, History, and Loader APIs.

| Command | What it does |
|---|---|
| `pupil run` | Execute all scenarios, store result, print summary |
| `pupil validate <file>` | Parse and validate a single scenario YAML |
| `pupil discover <dir>` | List all scenario files found recursively |
| `pupil compare <runId>` | Diff a run against the baseline; exit 1 if regressions |
| `pupil mock-agent` | Start the IRIS-compatible mock HTTP server for local tests |

---

## Scenario YAML Reference

```yaml
id: unique-kebab-id              # required
name: Human readable name         # optional, defaults to id
description: What this tests      # optional
tags: [smoke, booking]            # optional list

driver:
  preset: iris-http               # or omit for generic rest
  config:
    baseUrl: https://agent.example.com

# Option A: single-turn shorthand
input: Schedule a meeting with John

# Option B: multi-turn
turns:
  - user: Schedule a meeting with John
    expect:                         # per-turn assertions
      - type: contains
        value: what time
  - user: 2pm please
    expect:
      - type: contains
        value: confirmed

expect:
  assertions:                      # scenario-level checks (against final response)
    - type: contains
      value: calendar invite
      caseSensitive: false
    - type: jsonpath
      target: response.raw
      path: $.status
      equals: success
  thresholds:
    - metric: turns
      max: 3
    - metric: cost_usd
      max: 0.05
  manual:
    required: true
    criteria: [tone, accuracy]
```

---

## Config Reference

| Key | Default | Description |
|---|---|---|
| `scenarios` | `examples/scenarios` | File or directory path for scenario YAML |
| `driver.type` | `rest` | Driver type. Only `rest` supported in Phase 1 |
| `driver.preset` | — | Use `iris-http` for the IRIS session API preset |
| `driver.config.baseUrl` | — | Agent base URL. Required. |
| `driver.config.bearerToken` | — | Auth token sent as `Authorization: Bearer …` |
| `driver.config.timeoutMs` | `30000` | Per-request timeout in milliseconds |
| `driver.config.retries` | `0` | Number of retries on transient errors |
| `history.dir` | `.pupil` | Directory for run history JSON files |
| `langfuse.enabled` | `auto` | `true`, `false`, or `auto` (enable if keys present) |
| `langfuse.host` | `LANGFUSE_HOST` env | Langfuse base URL |
| `langfuse.waitMs` | `25000` | Total polling budget per scenario |
| `langfuse.timeoutMs` | `3000` | Per-HTTP-call timeout for Langfuse lookups |
| `langfuse.initialDelayMs` | `8000` | Wait before the first poll attempt |

Config values can reference environment variables with `${VAR}` or `${VAR:-default}`. Langfuse credentials can also be set via `LANGFUSE_HOST`, `LANGFUSE_PUBLIC_KEY`, and `LANGFUSE_SECRET_KEY` directly.
