# Onboarding — Pupil

For engineers joining the Pupil project. Everything below was verified against commit `281a12c`
on 2026-07-28 with Node v22.22.2 and npm 10.9.7.

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
npx vitest run          # 102 tests, ~4s
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
├── langfuse/index.ts   # 4-line stub. Not implemented.
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

Phase 1 is roughly 80% built. Landed: scenario schema and loader, mock agent, REST driver,
`iris-http` preset, runner, assertion and threshold evaluators, JSON run history, regression
comparison.

CLI today: `validate`, `discover`, `run`, `compare`, `mock-agent`. `list`, `report`, and
`baseline` are in **PR #26**, awaiting review.

Not built, despite appearing in the type model:

| Thing                                 | State                                                         |
| ------------------------------------- | ------------------------------------------------------------- |
| Tool-call / trajectory awareness      | **absent** — `grep -ri tool src/` finds nothing outside tests |
| Trace reading (Langfuse or otherwise) | 4-line interface stub                                         |
| LLM judge                             | config parses, nothing consumes it                            |
| Manual scoring (`pupil score`)        | types exist, no command                                       |
| CI workflows                          | none at all                                                   |

---

## 5. Gotchas — read before you lose an afternoon

**`npm run check` is red on `main`.** `prettier --check` fails on `CLAUDE.md`.
Pre-existing, unrelated to your change. Fix with
`npm run format`, or ignore it and check only your own files:
`npx prettier --check <your-files>`. It reached `main` because no workflow enforces the gate.

**`compare` flags a regression between two identical passing runs.**
`--latency-threshold-ms` defaults to `0`, so a few milliseconds of noise produces
`metric_regressions=1` and exit code 1:

```
REGRESSION iris-basic: pass -> pass
  reason: latency_ms increased by 4 beyond threshold 0
```

`phase-plan.md:97` specifies "latency flagged beyond ±20%", so this is a divergence from the
documented intent, not the design. Pass `--latency-threshold-ms` explicitly for now. Fixing the
default to a percentage band is a good first contribution.

**`pupil.config.yaml` is not loaded by anything.** `loadPupilConfig()` in `src/core/config.ts`
is implemented, tested, and exported — and called by no CLI command. `run` takes flags only,
which is why the `examples/iris/*.yaml` scenarios hardcode `baseUrl: http://127.0.0.1:3000`.
Don't assume config works because the file exists.

**`RunResult.metadata` is an unpopulated free-form bag.** Nothing writes to it yet. It needs to
carry target identity (environment, deployed version, mode, fixture set) before baselines across
stages mean anything.

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

Full `npm run check` runs `prettier --check . && typecheck && build && vitest run` — currently
red on `main` for reasons unrelated to your change (§5).

Add tests next to the code. Anything touching an agent goes through the mock agent, never a live
service — the suite must pass with no network and no API keys.

### Good first contributions

1. Fix the `compare` latency default to a percentage band (§5). Small, self-contained, and the
   tool is unusable as a gate without it.
2. Wire `loadPupilConfig()` into `pupil run` behind `--config`, with flags overriding file
   values.
3. Add the repo's own `npm run check` GitHub Actions workflow, and green up `main`.

Before starting anything larger, read `docs/product-direction.md` §5–6. The build order there is
deliberate: the evaluator seam needs reshaping to take a `Trajectory` **before** any trajectory
feature is added, otherwise driven runs and observed traces end up with two divergent scoring
paths.

---

## 8. Further reading

| Document                    | What it's for                                                                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/product-direction.md` | Vision, competitive landscape, build plan, release ladder. Start at §4.                                                                        |
| `phase-plan.md`             | Original Phase 1 plan. Historical — some of it is superseded, and the IRIS endpoint facts in it are the best written record of that interface. |
| `CLAUDE.md`                 | Repo conventions and command reference.                                                                                                        |
| `README.md`                 | Public-facing pitch. Note its architecture diagram shows Slack and MCP drivers that don't exist yet.                                           |
