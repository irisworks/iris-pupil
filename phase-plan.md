# Pupil — Phase 1 MVP Implementation Plan

## Context

Pupil (this repo, currently just README/LICENSE/CLAUDE.md) is an open-source framework for testing AI agents and catching regressions. The user wants a plan for the **Phase 1 MVP**: scenario runner, one driver, Langfuse integration, manual scoring, regression history.

Decisions made with the user:
- **TypeScript/Node (ESM), npm** — matches sibling IRIS repos (Node ≥20, `"type": "module"`, tsc/NodeNext, `.js` import specifiers, tsx for dev).
- **REST API driver first**; Slack/MCP are Phase 2.
- **First real target: IRIS agent** (`iris-runtime`, sibling repo). Verified facts from exploring it:
  - Plain Node http server on `127.0.0.1:3000`. `GET /health`; `POST /sessions {originChannel, originThreadTs, metadata?}` → `{sessionId}`; **`POST /sessions/:id/message {text, user?}` blocks until reply → `{text}`** (504 on timeout); `POST /sessions/:id/reset`. Optional `Authorization: Bearer $IRIS_API_TOKEN`.
  - Langfuse already integrated via LiteLLM (session tagging via `x-litellm-session-id`); **no OpenTelemetry**. No eval/test tooling exists anywhere in the IRIS ecosystem — nothing to reuse.
  - SSE `stream-message` variant exists (cloud) — deliberately deferred to Phase 2; blocking endpoint is the MVP path, cost/tokens come from Langfuse.

## Structure

**Single npm package** (no workspace). Extensibility for Phase 2 via `Driver`/`Evaluator` interfaces + registries and a `package.json` `exports` map (`"."`, `"./driver"`, `"./eval"`), so drivers can be extracted to separate packages later without breaking imports. Bin: `pupil`.

```
src/
├── index.ts                  # public programmatic API
├── cli/                      # commander: main.ts, run.ts, compare.ts, score.ts, report.ts, format.ts
├── core/                     # types.ts (domain model), config.ts, verdict.ts
├── scenario/                 # schema.ts (zod), loader.ts (dir scan + normalize)
├── driver/                   # types.ts, registry.ts, rest/{rest-driver,template,presets}.ts
├── runner/                   # runner.ts (concurrency/timeout/retry), errors.ts
├── eval/                     # types.ts, assertions.ts, thresholds.ts, manual.ts, judge.ts (stub)
├── langfuse/client.ts        # read-only, raw fetch (no SDK)
└── history/                  # store.ts (.pupil/ JSON files), compare.ts (regression diff)
test/fixtures/mock-agent.ts   # scripted IRIS-shaped HTTP agent
examples/{mock,iris}/         # runnable scenario suites
```

## Core domain model (`src/core/types.ts`)

- `Verdict = PASS | FAIL | NEEDS_REVIEW | SKIP | ERROR`
- `Scenario { name, tags?, turns: [{user, expect?: Assertion[]}], expect?, thresholds? {maxTurns, maxLatencyMs, maxCostUsd}, manual?: [{name, prompt}], judge?, timeoutMs?, retries? }` — **multi-turn first-class**; loader normalizes README's flat `input:` shorthand into one turn.
- `Assertion = contains | not_contains | regex | equals | jsonpath`
- `TurnRecord { input, reply, latencyMs, raw }`, `Score { evaluator, name, verdict, value?, expected?, detail?, scoredBy? }`
- `ScenarioResult { verdict, turns, scores, trace?: TraceSummary }`, `RunResult { runId, git?, driver, scenarios, summary }`
- Aggregation (`verdict.ts`): scenario verdict = worst score (ERROR > FAIL > NEEDS_REVIEW > PASS; SKIP ignored). Exit code 1 on FAIL/ERROR; NEEDS_REVIEW warns only (`--strict` makes it fail — for CI).

## Driver abstraction

```ts
interface Driver { name; init?(); createConversation(ctx): Promise<DriverConversation>; dispose?() }
interface DriverConversation { id; send({text, user?}, opts?): Promise<AgentReply>; close() }
```

**One generic `rest` driver, config-driven** (URL templates + `{{var}}` interpolation + jsonpath extraction), not per-agent adapter code. `iris-http` is a **preset** in `presets.ts` (canned config, deep-merged with overrides):

```yaml
driver:
  name: rest
  preset: iris-http
  config:
    baseUrl: http://127.0.0.1:3000
    auth: { type: bearer, tokenEnv: IRIS_API_TOKEN }   # header omitted if unset
    createConversation: { method: POST, path: /sessions, body: {originChannel: pupil, originThreadTs: "{{runId}}:{{scenarioSlug}}"}, conversationIdFrom: "$.sessionId" }
    sendMessage: { method: POST, path: "/sessions/{{conversationId}}/message", body: {text: "{{text}}"}, replyFrom: "$.text", timeoutStatus: [504] }
    closeConversation: { method: POST, path: "/sessions/{{conversationId}}/reset" }
```

Node 20 built-in `fetch` + `AbortSignal.timeout()` — no HTTP dependency.

## Runner

Load YAML scenarios from a dir (zod-validated, fail fast with file+path). Execute with `p-limit` (default concurrency 2), per-turn timeout (default 120s — IRIS blocks), retries (default 1) restart the scenario in a fresh conversation and apply **only** to driver/network/504 errors, never assertion failures. `close()` in `finally`. Stream one result line per scenario, then summary table; write RunResult to store.

## Scoring (pluggable `Evaluator` interface)

1. **assertions** — per-turn `expect` on that turn's reply; scenario-level `expect` on final reply; `jsonpath` runs on raw body.
2. **thresholds** — maxTurns/maxLatencyMs vs measured; maxCostUsd vs Langfuse trace (SKIP if absent).
3. **manual** — emits NEEDS_REVIEW scores; resolved post-run via `pupil score <runId> <scenario> <criterion> pass|fail --note`, which rewrites the stored run file and re-aggregates.
4. **judge** — stub only: parses `judge:` blocks, scores SKIP ("not configured"). Phase 2 hook.

## Langfuse (best-effort, optional)

Read-only client (~100 lines, raw fetch + Basic auth) against `GET /api/public/traces?sessionId=...`. Enabled `auto` iff `LANGFUSE_*` env vars set. Poll up to `waitMs` (10s, ingestion is async), build `TraceSummary {totalCostUsd, tokens, toolCalls, langfuseUrl}`. Correlation via config template `sessionIdTemplate: "{{conversationId}}"`. Any failure → warning + `trace` undefined; runs never depend on it.

## Regression history

**JSON files, not SQLite** (zero native deps, git-diffable results): `.pupil/runs/<runId>.json`, `index.jsonl`, `baseline` (text file with a runId). `compare.ts` joins scenarios by name → regressed / fixed / still-failing / new / removed + metric deltas (latency flagged beyond ±20%). Exit 1 on regression. `pupil run --baseline` auto-compares.

## CLI (commander ^13)

`pupil run [dir]` (`--config --concurrency --tag --baseline --json --strict`), `pupil list`, `pupil report [runId]`, `pupil compare <a> <b>` (accepts `baseline`/`latest`), `pupil baseline set <runId>`, `pupil score ...`. Exit codes: 0 clean, 1 failures/regressions, 2 usage error.

## Dependencies

Runtime: `commander ^13`, `yaml ^2.7`, `zod ^3.25`, `jsonpath-plus ^10.3`, `p-limit ^6.2`.
Dev: `typescript ^5.7`, `vitest ^3.1`, `tsx ^4.19`, `@types/node ^22`, `prettier ^3.5`.
Quality gate: `npm run check` = `tsc --noEmit && prettier --check . && vitest run` (future CI entry point; no ESLint for now, matching sibling repos).

## Mock agent (`test/fixtures/mock-agent.ts`)

Plain `node:http` server mimicking IRIS endpoints (`/health`, `/sessions`, `/sessions/:id/message`, `/reset`), driven by scripted rules `{match, reply, delayMs?, status?, times?}` + default echo; supports 504/500/hang for timeout/retry tests; records requests. `startMockAgent()` on port 0 for tests; also standalone via `npm run mock-agent` so `examples/mock/` and CI never need live IRIS.

## Milestones (each independently verifiable)

| # | Deliverable | Verification |
|---|---|---|
| M0 | Scaffold: package.json, tsconfigs, vitest, commander skeleton; update CLAUDE.md with real commands | `npm run build && node dist/cli/main.js --version`; `npm run check` green |
| M1 | Core types + scenario schema/loader (incl. README shorthand) | vitest: loads multi-turn + shorthand fixtures; invalid YAML rejected with file/path |
| M2 | Mock agent | vitest: full session lifecycle incl. scripted 504 |
| M3 | REST driver + template engine + iris-http preset + registry | vitest against mock agent: session create, reply/latency extraction, bearer header, 504-as-retryable |
| M4 | Runner + assertions/thresholds + verdicts + store write; wire `pupil run` | `pupil run examples/mock` prints table, writes `.pupil/runs/*.json`; scripted failure ⇒ exit 1 |
| M5 | Compare + `list`/`report`/`baseline`/`compare` commands | Run twice with a regressed mock script: compare shows 1 regressed, exit 1 |
| M6 | Manual scoring flow + judge stub | `manual:` scenario ⇒ NEEDS_REVIEW; `pupil score ... pass` ⇒ report shows PASS re-aggregated |
| M7 | Langfuse enrichment | vitest vs stubbed Langfuse HTTP fixture; missing env ⇒ clean skip |
| M8 | `examples/iris/` suite vs live local iris-runtime; docs polish | Manual: `pupil run examples/iris --baseline` against IRIS on :3000 with real Langfuse traces |

M0–M5 are the critical path (runner + regression detection); M6/M7 additive; M8 is real-world validation.

## Notes / conscious divergences

- zod over typebox (sibling runtime uses typebox) — better validation ergonomics for a config-heavy CLI.
- Blocking `/message` over SSE — simpler MVP; SSE/tool-event capture becomes a Phase 2 driver capability.
- npm package name `pupil` is almost certainly taken on the registry — publish name (e.g. `@irisworks/pupil` or `pupil-eval`) can be decided at publish time; bin stays `pupil`.
