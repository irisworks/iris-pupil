# Onboarding — Pupil

For engineers joining the Pupil project. Everything below was verified against commit `bd3f768`
on 2026-08-06 with Node v22.22.2 and npm 10.9.7.

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
npx vitest run          # 159 tests, ~6s
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
├── cli/index.ts        # commander wiring. Command parsing only — no logic.
├── core/
│   ├── types.ts        # domain model: Verdict, Scenario, TurnRecord, Score, RunResult
│   └── config.ts       # pupil.config.yaml loader + ${ENV_VAR} resolution
├── scenario/           # schema.ts (zod), loader.ts (dir scan + normalize)
├── driver/
│   ├── index.ts        # generic REST driver, {{var}} templates, jsonpath extract
│   └── presets.ts      # iris-http preset — the ONLY place IRIS specifics belong
├── eval/index.ts       # assertion + threshold evaluators, score aggregation
├── runner/index.ts     # multi-turn execution, concurrency, timeout, retry
├── history/
│   ├── index.ts        # JsonRunHistoryStore: .pupil/runs/*.json + index.jsonl
│   └── compare.ts      # regression comparison engine
├── langfuse/index.ts   # Real Langfuse reader (601 lines): sessionId→observations lookup,
│                       # /api/public/sessions/:id fallback, poll/retry, cost/token capture.
│                       # Not yet behind a swappable TraceSource interface (IRIS-158, in review).
└── mock/               # IRIS-shaped mock HTTP agent
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
agent, REST driver, `iris-http` preset, runner (now built around a source-agnostic `Trajectory`,
IRIS-154), assertion and threshold evaluators, JSON run history, regression comparison, Langfuse
trace enrichment, manual scoring, and this repo's own CI check workflow.

CLI today: `validate`, `discover`, `run`, `compare`, `mock-agent`, `list`, `report`, `baseline`,
`score` — all merged. `run --config`/`--profile` (IRIS-153) is open in **PR #42**, in review.

Not built, despite appearing in the type model:

| Thing                                 | State                                                                                                                                                                                  |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool-call / trajectory awareness      | **absent** — `grep -ri tool src/` finds nothing outside tests. IRIS-158/160 (TraceSource extraction, mock trace spans) are in review; IRIS-161 (the assertions themselves) is next up. |
| Trace reading (Langfuse or otherwise) | **implemented** for Langfuse (IRIS-97) — not yet behind a swappable `TraceSource` interface (IRIS-158, in review)                                                                      |
| LLM judge                             | config parses, nothing consumes it                                                                                                                                                     |
| Manual scoring (`pupil score`)        | **shipped** (IRIS-96)                                                                                                                                                                  |
| CI workflows                          | `.github/workflows/check.yml` runs `npm run check` on Node 20 + 22 (IRIS-152)                                                                                                          |

---

## 5. Gotchas — read before you lose an afternoon

**`npm run check` is green on `main`** (IRIS-152) — typecheck, build, 159/159 tests, and
prettier clean on every tracked file. If you see a stray prettier failure locally, check it isn't
an untracked local file (e.g. an editor/tooling settings file) before assuming `main` is red.

**`compare` uses a default latency noise band.** The default latency regression threshold is now
20% of the baseline `latency_ms`. A tiny runtime fluctuation no longer fails the comparison gate,
but a larger increase still produces `metric_regressions=1` and exit code 1. Use
`--latency-threshold-pct` to tune the percentage band, or `--latency-threshold-ms` when you need
an absolute millisecond threshold instead.

**`pupil.config.yaml` is not loaded by anything — on `main`.** `loadPupilConfig()` in
`src/core/config.ts` is implemented, tested, and exported, but `run` on `main` still takes flags
only. **IRIS-153 fixes this** (`--config`/`--profile`, environment profiles) and is in review as
PR #42 — check whether it has landed before assuming config is still dead.

**`RunResult.metadata` is an unpopulated free-form bag — on `main`.** Nothing writes to it yet.
**IRIS-155 (in progress)** is adding target identity (environment, deployed version, mode,
fixture set) so baselines across stages mean something.

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

The three items previously listed here (latency-default fix, config wiring, CI workflow) have
all shipped or are in review (IRIS-151, IRIS-152, IRIS-153). Check `docs/product-direction.md`
§6 (build plan) for the current front of the queue — as of this writing that's IRIS-156
(CI-gate ergonomics), independent of any in-flight work, followed by IRIS-159 (traceparent
propagation) once IRIS-158/160 land.

Before starting anything larger, read `docs/product-direction.md` §5–6. The evaluator-seam
refactor to take a `Trajectory` (IRIS-154) is done — driven runs and (once IRIS-158/160/161
land) observed traces now share one scoring path. The next sequencing constraint is that
tool-call assertions (IRIS-161) and invariants (IRIS-163) both need trace-derived trajectories,
so they depend on the `TraceSource` work landing first.

---

## 8. Further reading

| Document                    | What it's for                                                                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/product-direction.md` | Vision, competitive landscape, build plan, release ladder. Start at §4.                                                                        |
| `phase-plan.md`             | Original Phase 1 plan. Historical — some of it is superseded, and the IRIS endpoint facts in it are the best written record of that interface. |
| `CLAUDE.md`                 | Repo conventions and command reference.                                                                                                        |
| `README.md`                 | Public-facing pitch. Note its architecture diagram shows Slack and MCP drivers that don't exist yet.                                           |
