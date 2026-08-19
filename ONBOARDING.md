# Onboarding — Pupil

For engineers joining the Pupil project. Everything below was verified against commit `d9265c6`
on 2026-08-19 with Node v22.21.0 and npm 10.9.4.

Read this first, then `docs/product-direction.md` for where the product is going and why.

---

## 1. What Pupil is

A **CLI tool you drop into a delivery pipeline to evaluate an agent** — a full multi-turn,
tool-calling agentic system, not a prompt or a single-turn completion. It must work against any
such system, including ones deployed by someone else.

The workflow: load a YAML scenario → drive the agent through its public interface → capture the
conversation and trace evidence → score it → store the result → compare against a baseline to
surface regressions.

Two things to internalise early, because they shape every design decision:

- **Black-box.** Pupil talks to the agent the way a user would. No SDK inside the agent, no
  instrumentation we require, no framework coupling.
- **We read observability, we don't collect it.** The environment already has Langfuse or an
  OTel collector. Pupil reads it. This is our main differentiator against promptfoo, which runs
  its own OTLP receiver and cannot read external backends — see
  `docs/product-direction.md` §3.

Pupil originated in the IRIS ecosystem. The first real target is IRIS, but nothing
IRIS-specific should leak outside `src/driver/presets.ts`.

---

## 2. Get it running (5 minutes)

```bash
npm install
npm run build
npx vitest run          # 288 tests, ~14s
node dist/cli/index.js --help
```

There is no `npm run dev` — during development, build first and run through
`node dist/cli/index.js`. `npm test` is `npm run build && vitest run`.

### The full loop against the mock agent

No live IRIS needed. Terminal 1:

```bash
node dist/cli/index.js mock-agent --port 5050
curl -s http://127.0.0.1:5050/health      # {"ok":true,"channels":0}
```

Terminal 2:

```bash
node dist/cli/index.js validate examples/scenarios/iris-basic.yaml
node dist/cli/index.js discover examples/scenarios
node dist/cli/index.js run examples/scenarios/iris-basic.yaml --base-url http://127.0.0.1:5050
```

Expected:

```
START iris-basic
PASS iris-basic
Saved run: .pupil/runs/<uuid>.json
Run <uuid>: pass (1/1 passed, 0 errors)
```

Then compare two runs — run it twice and pass both run IDs:

```bash
node dist/cli/index.js compare <baseRunId> <currentRunId>
```

Run history lands in `.pupil/` (gitignored here; **committed** in consuming repos — see §6).

---

## 3. Where things live

```
src/
├── cli/
│   ├── index.ts          # commander wiring. Command parsing only — no logic.
│   └── reporting.ts      # --json (RunJsonOutput), JUnit XML, $GITHUB_STEP_SUMMARY
├── core/
│   ├── types.ts          # domain model: Verdict, Scenario, TurnRecord, Score, RunResult
│   └── config.ts         # pupil.config.yaml loader + ${ENV_VAR} resolution
├── scenario/             # schema.ts (zod), loader.ts (dir scan + normalize)
├── driver/
│   ├── index.ts          # generic REST driver, {{var}} templates, jsonpath extract
│   └── presets.ts        # iris-http preset — the ONLY place IRIS specifics belong
├── eval/index.ts         # assertion + threshold evaluators, score aggregation
├── runner/index.ts       # multi-turn execution, concurrency, timeout, retry
├── history/
│   ├── index.ts          # JsonRunHistoryStore: .pupil/runs/*.json + index.jsonl
│   ├── compare.ts        # regression comparison engine
│   └── compareOptions.ts # threshold resolution shared by `run --baseline` and `compare`
├── trace/index.ts        # TraceSource interface + backend-agnostic enrichment (IRIS-158)
├── langfuse/index.ts     # Langfuse TraceSource (504 lines): GET /api/public/traces?sessionId=…,
│                         # then /api/public/traces/:traceId for the observations. Poll/retry,
│                         # cost/token/tool-call capture.
└── mock/                 # IRIS-shaped mock HTTP agent + MockTraceSource (tool spans, IRIS-160)
```

Tests sit next to their source as `*.test.ts`. Scenario fixtures are in
`src/scenario/__fixtures__/`.

### Conventions that matter

- **ESM, NodeNext.** Import specifiers end in `.js` even though the source is `.ts`:
  `import { PupilError } from "../core/types.js"`. Getting this wrong fails the build.
- **`PupilError`** for user-facing failures, with `{file, path}` context so validation errors
  point at the offending YAML.
- **Verdict severity ordering** is `error > fail > needs_review > pass`, with `skip` neutral.
  `aggregateVerdicts` takes the worst. Never bypass it.
- **Keep the CLI thin.** Commands parse args and call into modules. Logic lives in `src/`.
- **Drivers stay decoupled from CLI parsing** — a driver must be usable programmatically.
- **Run history is JSON/JSONL** so results stay git-diffable. Not SQLite; this is deliberate.
- **Langfuse is evidence, never the source of truth** for a Pupil verdict.

---

## 4. Current state

Phase 1's original scope is fully built and then some. Landed: scenario schema and loader, mock
agent, REST driver, `iris-http` preset, runner (built around a source-agnostic `Trajectory`,
IRIS-154), assertion and threshold evaluators, JSON run history, regression comparison, Langfuse
trace enrichment behind a swappable `TraceSource` (IRIS-158), a `MockTraceSource` that emits
configurable tool spans (IRIS-160), config profiles (IRIS-153), target identity (IRIS-155),
CI-gate ergonomics (IRIS-156), manual scoring, and this repo's own CI check workflow.

CLI today: `validate`, `discover`, `run`, `compare`, `mock-agent`, `list`, `report`, `baseline`,
`score` — all merged, all accepting `--config`/`--profile`.

Still missing, despite appearing in the type model or the vision:

| Thing                                 | State                                                                                                                                                                                                                                                 |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool-call **assertions**              | **absent.** Tool calls are now _read_ — `metadata.langfuse.toolCalls` and `metrics.tool_calls` come from trace enrichment (`src/trace/index.ts`) — but no assertion type consumes them. `tool_called`/`tool_order`/`tool_args` are IRIS-161, next up. |
| Trajectory from traces                | `Trajectory.source` allows `"trace"`, but only the driven producer exists. Needs IRIS-164 (`pupil observe`).                                                                                                                                          |
| `traceparent` correlation             | not started (IRIS-159) — correlation today is the `sessionId` echo, see §5                                                                                                                                                                            |
| LLM judge                             | config parses; `evaluateJudge` returns a `skip` score reading `LLM judge not configured`                                                                                                                                                              |
| Driver registry / 2nd driver          | not started — the runner hardcodes `if (scenario.driver.type !== "rest") throw`                                                                                                                                                                       |
| Invariants, seeding, 2nd trace source | not started (IRIS-163, IRIS-165, IRIS-167)                                                                                                                                                                                                            |
| Manual scoring (`pupil score`)        | **shipped** (IRIS-96)                                                                                                                                                                                                                                 |
| CI workflows                          | `.github/workflows/check.yml` runs `npm run check` on Node 20 + 22 (IRIS-152)                                                                                                                                                                         |

---

## 5. Gotchas — read before you lose an afternoon

**`npm run check` is green on `main`** (IRIS-152) — typecheck, build, 288/288 tests, and
prettier clean on every tracked file. If you see a stray prettier failure locally, check it isn't
an untracked local file (e.g. an editor/tooling settings file) before assuming `main` is red.

**`compare` uses a default latency noise band.** The default latency regression threshold is now
20% of the baseline `latency_ms`. A tiny runtime fluctuation no longer fails the comparison gate,
but a larger increase still produces `metric_regressions=1` and exit code 1. Use
`--latency-threshold-pct` to tune the percentage band, or `--latency-threshold-ms` when you need
an absolute millisecond threshold instead.

**`pupil.config.yaml` is loaded by every command that needs it.** `run` reads `scenarios`,
`driver`, `history`, `langfuse`, `target`, and `compare` from it; `--config` picks a different
file and `--profile` selects a `profiles.<name>` block to deep-merge over the rest. Driver
precedence is config < scenario < CLI flag, so the `examples/iris/*.yaml` scenarios no longer
hardcode `baseUrl` — they inherit it from the config or a profile.

**Target identity is a top-level `RunResult.target`, not `metadata`.** IRIS-155 shipped it as its
own typed field (`system`, `environment`, `version`, `fixtureSet`, and a `mode` that `run` always
stamps as `"driven"`), configured under `target:` in `pupil.config.yaml` or via
`--system`/`--environment`/`--target-version`/`--fixture-set`. `compare` exits **2** on a hard
mismatch (`system`, `mode`, `fixtureSet`), so a pre-IRIS-155 baseline — which has no `target` at
all — is a hard mismatch on `mode`. Re-establish one with `pupil baseline <newRunId>`.

**`RunResult.metadata` is a free-form bag with exactly one writer.** Trace enrichment puts its
evidence under `metadata.langfuse` (status, trace id/url, `toolCalls`). Don't assume it's empty,
and don't assume anything else populates it.

**The driver registry doesn't exist.** `src/runner/index.ts` hardcodes
`if (scenario.driver.type !== "rest") throw`. Adding a non-REST driver means building the
registry first.

**Retries only apply to transport failures.** `isRetryableRunnerError` covers 408, 429, 5xx,
timeouts, and `TypeError`. Assertion failures are never retried — deliberately. Don't "fix" it.

**`--retries` defaults to 0 on the CLI** but the `iris-http` preset sets `retries: 1`. Check
which one is in play before debugging flakiness.

---

## 6. How Pupil gets used

Pupil is a dependency of the agent's repo, not a home for other people's tests.

**Scenarios live next to the agent** — `iris-core/evals/*.yaml`, not `iris-pupil/examples/`. A
prompt change and the eval covering it belong in the same pull request. `examples/` in this repo
is demo-only.

Each consuming repo owns its scenarios, its `pupil.config.yaml`, and its **committed baseline**
so regressions are reviewable in a diff.

Pupil is indifferent to pipeline stage — it evaluates whatever agent is reachable:

| Stage       | Reachable                                         | Cadence      |
| ----------- | ------------------------------------------------- | ------------ |
| PR          | preview environment, or a locally-startable agent | every push   |
| Post-deploy | staging                                           | every deploy |
| Production  | traces only, no driving                           | nightly      |

Pupil does **not** deploy the agent, manage its lifecycle, or own its dependency config. That
belongs to the pipeline and the agent's repo respectively. If an agent can't be brought up in a
deterministic test configuration from its own repo, that's a defect in that repo — not something
Pupil should paper over.

### Gating a CI pipeline

A single `pupil run --baseline` is enough to gate a pipeline: it auto-compares against the
stored `.pupil/baseline` run and exits 1 on regression, on top of the existing exit-1-on-fail
behavior. Add `--strict` to also fail on `needs_review`, `--json` for a machine-readable summary
(see `src/cli/reporting.ts` for the stable `RunJsonOutput` shape), and `--junit` for a report
GitHub Actions' test reporting can parse. A `$GITHUB_STEP_SUMMARY` markdown summary is written
automatically whenever that variable is set — no flag needed.

```yaml
# .github/workflows/pupil-pr.yml
name: pupil
on: pull_request
jobs:
  evaluate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci && npm run build
      - run: mkdir -p .pupil
      - run: |
          node dist/cli/index.js run evals/flows \
            --config evals/pupil.config.yaml \
            --history-dir .pupil \
            --baseline --strict --json --junit .pupil/junit.xml \
            > .pupil/run.json
      - uses: dorny/test-reporter@v1
        if: always()
        with:
          name: Pupil scenarios
          path: .pupil/junit.xml
          reporter: java-junit
```

`--baseline` compares against the run id stored in `.pupil/baseline`, so that pointer and the run
it names have to survive between CI runs. Pupil gitignores `.pupil/` for its own development, so a
consuming repo has to choose one of: commit `.pupil/baseline` and the baseline run JSON, restore
`.pupil/` from an `actions/cache` step, or download it from a build artifact. Without one of those,
`run --baseline` warns on stderr that no baseline is set and gates on the run's own verdict only.

---

## 7. Working here

Branch from `main`, one Linear ticket per PR, commits prefixed with the ticket
(`IRIS-92 implement threshold evaluator`). Before pushing:

```bash
npm run typecheck
npm run build
npx vitest run
npx prettier --check <files you touched>
```

Full `npm run check` runs `prettier --check . && typecheck && build && vitest run` — green on
`main` (§5).

Add tests next to the code. Anything touching an agent goes through the mock agent, never a live
service — the suite must pass with no network and no API keys.

### Good first contributions

1. **Treat missing trace-derived metrics as `skip`, not `fail`.** `metricKey()` in
   `src/eval/index.ts` normalizes aliases for `turns`, `latency_ms`, and `cost_usd` only, and
   `evaluateThreshold` special-cases just `cost_usd` when the metric is absent. So a threshold on
   `tool_calls` or `total_tokens` — both written by trace enrichment — hard-**fails** a scenario
   whenever Langfuse is unreachable or disabled, instead of skipping like cost does. Extend the
   alias table and the skip branch to every trace-derived metric. Small, well-covered by
   `src/eval/index.test.ts`, and it removes a real false-red.
2. **Give the driver registry a seam.** `src/runner/index.ts` throws on any
   `scenario.driver.type !== "rest"`. Replacing that hardcode with a small registry lookup is
   self-contained and unblocks every future driver.

Before starting anything larger, read `docs/product-direction.md` §5–6. The evaluator seam takes
a `Trajectory` (IRIS-154) and the `TraceSource` interface plus a tool-span-emitting mock
(IRIS-158/160) have both landed, so the next sequencing constraint is downstream: tool-call
assertions (IRIS-161) and invariants (IRIS-163) need a trace-derived `Trajectory` producer, which
is IRIS-164's job.

---

## 8. Further reading

| Document                    | What it's for                                                                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/product-direction.md` | Vision, competitive landscape, build plan, release ladder. Start at §4.                                                                        |
| `phase-plan.md`             | Original Phase 1 plan. Historical — some of it is superseded, and the IRIS endpoint facts in it are the best written record of that interface. |
| `CLAUDE.md`                 | Repo conventions and command reference.                                                                                                        |
| `README.md`                 | Public-facing pitch. Note its architecture diagram shows Slack and MCP drivers that don't exist yet.                                           |
| `docs/fixtures.md`          | How to stub tool/model backends for PR-time evaluation, and how `--fixture-set` guards `compare`.                                              |
