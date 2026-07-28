# Pupil — Product Direction

Status: draft for review · 2026-07-28 · baseline commit `281a12c`

## 1. Vision (as stated)

Pupil is a **CLI tool you drop into a CI/CD pipeline to evaluate an agent** — not a prompt,
not a single-turn completion, but a full multi-turn, tool-calling agent.

Three commitments follow from that:

1. **Drive the agent through its own interface.** REST today; RPC and code-wrapping
   (in-process / subprocess) next. The agent under test needs no Pupil SDK inside it.
2. **Evaluate the trajectory, not just the final string.** Turns, tool calls, tool order,
   recovery, cost, latency — the things that actually break when a model or prompt changes.
3. **Evaluate a _running_ agent too.** Read its Langfuse traces and detect drift and
   regression on real production traffic, without driving it at all.

Mode 2 and mode 3 share the same scenario definitions, the same metric vocabulary, and the
same regression verdict. A regression caught in CI and a drift caught in production are the
same signal, expressed against the same baseline.

## 2. Situation report

### What exists and works

Phase 1 is roughly 80% built. `main` = `281a12c`; 4,600 lines of TypeScript, 103 tests.

| Area                                                                                      | State                                                   |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Scenario schema + loader (zod, YAML, dir scan, flat-`input` shorthand)                    | done                                                    |
| IRIS-compatible mock HTTP agent                                                           | done                                                    |
| Generic REST driver (`{{var}}` templates, jsonpath extract, retry on 408/429/5xx)         | done                                                    |
| `iris-http` preset (deep-merged over driver config)                                       | done                                                    |
| Runner (multi-turn, concurrency, per-scenario timeout, retry in a fresh conversation)     | done                                                    |
| Assertion evaluator (`contains`/`not_contains`/`equals`/`regex`/`jsonpath`)               | done                                                    |
| Threshold evaluator (`turns`, `latency_ms`, `cost_usd` with alias normalization)          | done                                                    |
| JSON run history (`.pupil/runs/*.json`, `index.jsonl`, `baseline`)                        | done                                                    |
| Regression comparison (regressed / fixed / still-failing / new / removed + metric deltas) | done                                                    |
| CLI: `validate`, `discover`, `run`, `compare`, `mock-agent`                               | done                                                    |
| CLI: `list`, `report`, `baseline`                                                         | **open in PR #26**, review requested, idle since Jul 28 |

### Gaps, in order of how much they hurt

1. **No tool-call awareness anywhere.** `grep -ri tool src/` returns nothing outside tests.
   `TurnRecord.response` is `{text, raw}`. Metrics are `turns`, `latency_ms`, `retries`.
   Today Pupil evaluates an _HTTP endpoint that returns a string_, which is the one thing the
   vision explicitly rules out. This is the single largest vision-to-code gap.
2. **Langfuse is a 4-line stub.** `src/langfuse/index.ts` declares two optional fields and
   nothing else. Consequences: `cost_usd` thresholds always SKIP, and mode 3 does not exist.
3. **No CI story at all.** No `.github/workflows/` — the repo does not even run its own
   `npm run check`. No `--json`, no JUnit/SARIF, no step-summary output, no
   `run --baseline` auto-compare, no `--strict`. For a tool whose entire premise is
   "drop it in CI", this is the second-biggest gap.

   Concretely: **`npm run check` is currently red on `main`.** `prettier --check` fails on
   `CLAUDE.md` and `src/history/compare.ts`. Verified by stashing all local changes at
   `281a12c` — this is pre-existing and reached `main` because no workflow enforces the gate.

4. **`pupil.config.yaml` is dead config.** `loadPupilConfig()` is implemented, tested, and
   exported — and called by no CLI command. `run` takes only flags. Every scenario file
   therefore hardcodes `baseUrl: http://127.0.0.1:3000`.
5. **Driver abstraction is REST-shaped and not pluggable.** `Driver` is `{ readonly type }`;
   the runner hardcodes `if (scenario.driver.type !== "rest") throw`. No registry. RPC and
   code-wrapping drivers have nowhere to plug in.
6. **No LLM judge.** Free-form agent replies can only be asserted with substring and regex,
   which is brittle for exactly the responses agents produce. Judge config parses; nothing
   consumes it.
7. **No manual scoring flow.** `ManualScoringConfig` is in the type model; no `pupil score`
   command, so `NEEDS_REVIEW` is unreachable and unresolvable.

### Inferred Linear state

No Linear connector was available in this session, so the following is reconstructed from
`IRIS-xx` refs in git history and `phase-plan.md` milestones — **verify before planning
against it**. Landed: 84, 85, 86, 87, 89, 90, 91, 92, 93, 94, 98. In review: 95 (PR #26).
Unaccounted for: 88 (template engine — the code exists inside `driver/index.ts`, so this is
likely closed or folded into 87), 96 (manual scoring, per M6), 97 (Langfuse, per M7).

## 3. Competitive landscape

### Where the market sits, mid-2026

The eval space has consolidated into three bands.

**Commercial platforms** — LangSmith (~$39/seat, LangChain-native, strongest on LangGraph
trajectories), Braintrust (~$249/mo, $800M valuation after an $80M Series B; dataset-first,
sandboxed custom scorers), plus Arize, Galileo, Patronus, Maxim. All are backend-first: you
send them your data, you evaluate inside their product, you pay per seat or per trace.

**Open-source observability platforms that grew evals** — Langfuse, Opik (Comet), Arize
Phoenix, LangWatch, MLflow. Langfuse in particular now ships online evals (LLM-judge scoring
of live production traces), datasets, and experiments. This matters for us: **Langfuse is
simultaneously our evidence source and our nearest neighbour in mode 3.**

**CLI/framework-first tools** — Promptfoo, DeepEval (Confident AI), Ragas, and LangWatch's
`scenario`. These are the band Pupil competes in.

Two events reshaped this band in 2026:

- **OpenAI acquired Promptfoo** (announced March 9, 2026; 11-person team, ~$86M post-money
  valuation, 150k+ developers, >25% of the Fortune 500). It stays open source under its
  current license and gets folded into OpenAI Frontier. Promptfoo was the default answer for
  "declarative YAML evals + red teaming in CI" — and it is now owned by a model vendor.
- **LangWatch open-sourced `scenario`** (March 2026), which is the closest thing to Pupil's
  mode 2: an agent-under-test, a simulated user, and a judge, run multi-turn under pytest in
  CI, with documented **black-box adapters** for HTTP/CLI/SDK targets and a `RedTeamAgent`
  (Crescendo escalation, refusal detection, backtracking) as a drop-in user simulator.

### Read on red/blue teaming

Adversarial testing is a separate, more mature market: Garak (NVIDIA, 37+ probe modules),
PyRIT (Microsoft, multi-turn attack orchestration), Giskard, and Promptfoo (50+ vulnerability
types, CI-integrated) — now with OpenAI's distribution behind it. Recommended practice is
already "Garak for coverage, Promptfoo for CI regression, PyRIT for adversarial refinement."

**Pupil should not enter this market.** We would be entering a security category, against
vendors with dedicated threat research, using our vision's weakest surface. The correct
posture is _composability_: because Pupil drives an agent through its public interface and
stores git-diffable results, a red-team suite can be expressed as Pupil scenarios, and
Garak/PyRIT findings can be pinned as Pupil regression cases. Sell "your adversarial findings
become permanent CI gates," not "we red-team your agent."

### Where Pupil sits

Honest positioning: **the deterministic, config-first, self-hosted CI gate for tool-calling
agents, with bring-your-own observability.**

Four defensible differentiators:

1. **Deterministic by default, judge-optional.** Scenario's three-agent triangle needs an LLM
   user simulator _and_ an LLM judge on every run — nondeterministic, metered, and flaky as a
   merge gate. Pupil's scripted turns + assertions + thresholds are reproducible: a red build
   is a real regression, not judge variance. Judge and simulated-user become opt-in _additions_
   to a deterministic core, never the substrate. Nobody else in this band leads with this.
2. **No SDK, no test code, no backend.** Promptfoo is YAML but prompt/model-centric; DeepEval
   and `scenario` are pytest — they need an ML-literate engineer writing Python. Pupil is one
   binary plus YAML, targeting the QA engineer and the platform/SRE team who own the pipeline
   and never touch agent code. `.pupil/` JSON in the repo means no account, no database, no
   per-trace bill, and results that show up in a diff.
3. **Bring-your-own observability.** Every platform in bands one and two wants to _be_ your
   tracing layer. Pupil treats Langfuse as evidence and never as the source of truth. Teams
   that already standardized on Langfuse/OTEL get evals without a second data plane.
4. **Vendor neutrality is now a live buying criterion.** Post-acquisition, "our eval and
   security gate is owned by a model vendor" is a real objection for teams running Anthropic,
   Gemini, or self-hosted models. A neutral, self-hostable, MIT-licensed CLI has a wedge that
   did not exist in February 2026.

The honest caveat: `scenario` already occupies a lot of this ground and has a real company
behind it. Our differentiation is **determinism and zero-instrumentation operational fit**,
not novelty of concept — and it only holds if we ship trajectory evaluation, because
final-output-only evaluation reportedly passes 20–40% more cases than trajectory evaluation
does. Until tool-call assertions exist, our headline claim is not true.

### What is actually blank space, claim by claim

Graded honestly, because three of these four are the reason to keep building and one is not.

| Capability                                               | Blank?             | Evidence                                                                                                                                                                                                                     |
| -------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drive an agent over REST from declarative config in CI   | **No**             | Promptfoo's HTTP provider does this well: server-side session-ID extraction from response headers, client-side session generation via `transformVars`, explicitly for multi-turn evals. We are not first, and we are behind. |
| Start / health-check / stop the agent under test         | **Yes**            | Promptfoo assumes the endpoint is already running. `scenario` needs a hand-written adapter. Precedent is Playwright `webServer` / Testcontainers, outside the eval space.                                                    |
| Assert on which tools the agent chose to call, black-box | **Largely**        | Promptfoo's "tool calling" support injects tool _definitions_ into a model request — model-centric, not "which tools did my agent pick." `scenario` judges tool calls but via an LLM judge inside its own platform.          |
| Read traces from any tracing backend, vendor-neutrally   | **Yes, but early** | Every platform couples to its own backend. See the OTel caveat below.                                                                                                                                                        |
| Cheap, deterministic per-PR agent runs                   | **Yes**            | Nobody in this band ships record/replay of the agent's model and tool edges. Section 4, layer 3.                                                                                                                             |

**The OTel caveat, which constrains the architecture.** As of 17 July 2026 no GenAI span,
event, metric, or attribute is marked Stable. In the v1.42.0 release (12 June 2026) all
`gen_ai.*` attributes moved out of the main semantic-conventions repo into a dedicated GenAI
repo — a release-cadence change, not a graduation. That dedicated repo has no releases or tags
yet and its schema-URL section is still a TODO. Agent and framework spans are experimental,
though reportedly stable in practice through Q1 2026.

Implication: **do not architect on OTel GenAI as a pinned contract yet.** Define Pupil's own
small internal trace model, shaped after the `gen_ai.*` conventions so convergence is cheap
later, and read it through a `TraceSource` interface with per-backend implementations —
Langfuse first, OTLP/Phoenix second. Vendor neutrality is then our property, not something we
inherit from a standard that isn't finished.

### So are we building something useless?

No, but the current Phase 1 scope on its own would be. Everything landed so far — REST
driving, text assertions, thresholds, run history — is table stakes that Promptfoo already
does better, and it is now backed by OpenAI's distribution. Stopping at Phase 1 as originally
written produces a worse Promptfoo.

The four things that make Pupil worth building are the target lifecycle, black-box trajectory
assertions, backend-agnostic trace evidence, and replay-based cheap determinism. None of them
are in Phase 1. The existing code is the necessary substrate for all four, so it is not wasted
work — but it is substrate, not product, and the roadmap should stop treating Phase 1
completion as the goal.

## 4. The target problem: who brings the agent up in CI?

Pupil cannot evaluate an agent that isn't running and configured. Everything above assumed a
live target at `baseUrl` and never said where that comes from. It decomposes into three layers
that must be owned by three different places, and conflating them is how CI eval projects die.

### Layer 1 — process lifecycle: build, start, wait for ready, tear down

**Owner: Pupil.** This is currently nobody's job, which means it lands in each consuming
repo's workflow YAML, hand-rolled, with the classic race between "process started" and
"process ready."

This is a confirmed blank space in the eval tooling market. Promptfoo's HTTP provider
assumes the endpoint is already running — no lifecycle, no health check, no readiness wait.
LangWatch `scenario` requires you to hand-write an adapter in Python or TypeScript. The
precedent worth copying sits outside the eval space entirely: **Playwright's `webServer`
config** and Testcontainers. `webServer` is a large part of why Playwright feels drop-in for
e2e, and it is roughly 200 lines of spawn / poll / kill.

Proposed `target:` block in `pupil.config.yaml`:

```yaml
target:
  start: docker compose -f docker-compose.ci.yaml up --wait
  healthcheck: http://127.0.0.1:3000/health
  readyTimeoutMs: 60000
  stop: docker compose -f docker-compose.ci.yaml down -v
  reuseExisting: true # skip start if healthcheck already passes (local dev)
```

`reuseExisting` matters: the same config then works unchanged for a developer running against
a local agent and for CI starting one from scratch.

### Layer 2 — dependency configuration: model keys, DB, vector store, auth

**Owner: the agent's repo, not Pupil.** The agent must be startable in a test configuration
by its own repository — a committed `docker-compose.ci.yaml` plus a `.env.ci` profile. Pupil
references that; it must never own or duplicate it.

State this as a hard boundary, because it is a testability requirement rather than a feature
request: **if an agent cannot be brought up in a deterministic test configuration from its own
repo, that is a defect in the agent repo that Pupil will expose, not a gap for Pupil to fill.**
Same category as needing dependency injection before you can unit-test a class.

### Layer 3 — determinism and cost at the agent's edges

This is the layer that decides whether CI evals are actually cheap and non-flaky, and it is
the most valuable open space of the three. A per-PR run that calls the real model and real
tool backends costs money on every push, flakes on third-party availability, and needs
production secrets in CI. No amount of runner polish fixes that.

The answer is **record/replay at the agent's outbound edges** — the VCR/Polly pattern applied
to model and tool traffic. Record cassettes once against live dependencies; replay them in CI
from disk. Consequences, stated honestly:

- Runs become deterministic, free, and fast — seconds, no secrets, no network.
- You are no longer testing the model. You are testing the agent's orchestration: routing,
  tool selection given a fixed model response, argument construction, error handling, state
  across turns. **For a prompt or code change, that is exactly the right thing to gate on.**
- Model upgrades and quality drift need real traffic and cannot use replay.

So the product has two tiers, and they are different products in the same binary:

| Tier                     | Mode   | Cadence               | Cost  | Role                            |
| ------------------------ | ------ | --------------------- | ----- | ------------------------------- |
| Orchestration regression | replay | every PR              | ~zero | **blocking merge gate**         |
| Quality and cost drift   | live   | nightly / pre-release | real  | tracked, alerting, not blocking |

This is what "easy and cheap in CI" actually requires, and it compounds with the
determinism differentiator in section 3 rather than sitting beside it.

### Where scenarios live

**In the agent's repo, next to the agent.** `iris-core/evals/*.yaml`, not
`iris-pupil/examples/`. A prompt change and the eval change that covers it belong in the same
pull request, reviewed together. Pupil is the runner and the npm dependency; each agent repo
owns its suite and its baseline. `examples/` in this repo stays demo-only.

## 5. What to build next

The reprioritization that matters: **Langfuse moves from M7-additive to critical path.**
IRIS's `POST /sessions/:id/message` returns `{text}` only, so traces are the only route to
tool calls, cost, and tokens without waiting on the deferred SSE endpoint. Langfuse is
therefore load-bearing for commitment 2, not just enrichment — and the same client unlocks
mode 3.

Sequenced, each step shippable:

1. **Land PR #26** (`list`/`report`/`baseline`). It is blocking review, not work.
2. **Wire `loadPupilConfig()` into `run`** — `--config`, flags override file, scenarios inherit
   driver config. Removes hardcoded `baseUrl` from every scenario file. Half a day; unblocks
   running the same suite against local, staging, and CI targets.
3. **CI-gate ergonomics.** `run --baseline` (auto-compare + exit 1 on regression), `--strict`
   (NEEDS_REVIEW fails), `--json`, JUnit XML, and a markdown summary for
   `$GITHUB_STEP_SUMMARY`. Add the repo's own `npm run check` workflow. Publish a composite
   GitHub Action.
4. **`target:` lifecycle management** (section 4, layer 1). Spawn, poll healthcheck, kill on
   exit, `reuseExisting` for local dev. Small build, and it is the difference between "drop
   Pupil into CI" being a claim and being true.
5. **Trajectory model + trace client.** Extend `TurnRecord` with `toolCalls: [{name, args,
result, latencyMs, error}]`; add `tool_calls`, `cost_usd`, `tokens` to `metrics`. Add the
   read-only Langfuse reader (raw fetch, Basic auth, poll for async ingestion) behind a
   `TraceSource` interface, plus a mock agent that emits tool events so this is testable
   without live IRIS.
6. **Tool assertions** — `tool_called`, `tool_not_called`, `tool_call_count`,
   `tool_order`, `tool_args` (jsonpath over args). This is the release that makes the
   "tool-calling agent" claim true.
7. **Record/replay cassettes** (section 4, layer 3). `pupil record` against live
   dependencies, replay from disk in CI. The largest build on this list and the one that makes
   per-PR evaluation free and deterministic.
8. **LLM judge** for semantic assertions, opt-in per scenario, with the deterministic
   pass/fail unaffected when the judge is unconfigured.
9. **`pupil observe`** — mode 3. Point at a trace source, a session/tag filter, and a time
   window; apply metric thresholds to real traffic; write the same `RunResult` shape into the
   same history store so `compare` works unchanged across driven and observed runs.
10. **Second `TraceSource`** — OTLP / Phoenix, proving the interface is real. See the
    OTel caveat in section 3.
11. **Driver registry + second driver.** Registry first, then whichever of RPC or
    in-process/subprocess wrapping a real internal target needs.
12. **Manual scoring** (`pupil score`) — completes Phase 1, but nothing else depends on it.

## 6. Release plan and internal adoption point

| Release                            | Contents   | What it unlocks                                                                           |
| ---------------------------------- | ---------- | ----------------------------------------------------------------------------------------- |
| **v0.2 — CI-gateable**             | steps 1–4  | Pupil runs in `iris-core` CI **advisory / non-blocking**, and starts its own target.      |
| **v0.3 — Agent-aware**             | steps 5–6  | **Internal adoption point.** Blocking merge gate.                                         |
| **v0.4 — Cheap and deterministic** | step 7     | Per-PR runs cost ~nothing and stop flaking. Live mode splits to nightly.                  |
| **v0.5 — Semantic + drift**        | steps 8–10 | Production drift alerting on live IRIS; judge for free-form replies; second trace source. |
| **v0.6 — Multi-target**            | step 11    | Second internal target beyond IRIS; case for open-source launch.                          |

**Answering "when do we start using it internally": start at v0.2, trust it at v0.3.**

The distinction is deliberate. At v0.2 Pupil can run per-PR and produce a comparison, but its
only assertions are over reply text — so it will miss the regressions that actually matter
(agent silently stops calling a tool, calls it twice, calls them out of order) while producing
false reds on benign wording changes. Gating merges on that trains the team to ignore it,
which is the one failure mode a quality tool cannot recover from.

v0.3 is the first release where a red Pupil build means something specific and true: _this
change altered the agent's trajectory or blew a cost/latency budget._ That is the point it
earns merge authority.

Two adoption preconditions worth stating now, because they are cheap before v0.3 and
expensive after:

- **Own CI first.** Pupil's own `npm run check` workflow must be green on every PR before we
  ask another repo to depend on it (step 3).
- **Baseline hygiene.** Decide now whether the baseline is committed (`.pupil/baseline` in
  git, reviewable, PR-scoped) or CI-cached. Committed is the better fit for the
  "git-diffable, no backend" differentiator and should be the documented default.

## 7. Worked example: evaluating iris-core

Written against the IRIS interface documented in `phase-plan.md` — plain Node HTTP on
`127.0.0.1:3000`, `GET /health`, `POST /sessions`, `POST /sessions/:id/message` blocking until
reply and returning `{text}`, `POST /sessions/:id/reset`, Langfuse via LiteLLM, no OTel.
**The `iris-core` repo was not in this session's scope, so the specific assertions below are a
shape, not a reviewed suite.** Confirm against the real repo before building.

### Where things sit

```
iris-core/
├── docker-compose.ci.yaml     # agent + postgres + redis + tool stubs   (agent repo owns)
├── .env.ci                    # test-profile config, no prod secrets    (agent repo owns)
├── evals/
│   ├── pupil.config.yaml      # target: block + driver + history        (agent repo owns)
│   ├── routing/*.yaml         # scenarios, colocated with the agent     (agent repo owns)
│   └── .pupil/baseline        # committed, reviewed in PRs              (agent repo owns)
└── .github/workflows/pupil.yml
```

Pupil is a devDependency of `iris-core`. Nothing about `iris-core` lives in this repo.

### The CI workflow, post-v0.2

```yaml
- run: npm ci
- run: npx pupil run evals/ --config evals/pupil.config.yaml --baseline --strict --junit results.xml
```

Two lines, because `target:` handles compose up, the health poll, and teardown. Before v0.2
this is the same thing written out by hand in the workflow with a `curl --retry` readiness loop.

### What is worth asserting

The generic shape, pending a look at the real repo: routing (did the right skill get picked),
tool selection (`tool_called: calendar.create` exactly once, `tool_not_called: email.send`),
clarification behaviour (did it ask a question when it already had enough information),
`turns <= 2`, `cost_usd <= 0.05`, and no-leak assertions on the reply text.

Only the last two are expressible today.

### The blocker specific to iris-core

`POST /sessions/:id/message` returns `{text}` and nothing else, so **tool calls are invisible
black-box.** Every trajectory assertion above depends on trace evidence, which is why the
Langfuse reader is on the critical path rather than in M7. Two ways to get it in CI without a
network dependency or an account:

1. **Self-hosted Langfuse container** in `docker-compose.ci.yaml`, Pupil reads it over
   localhost. Works today with the existing API, heaviest option.
2. **LiteLLM exports OTLP to a local collector or file** that Pupil reads directly. Lighter,
   no database, and it forces the `TraceSource` abstraction to be real from day one rather than
   retrofitted. Constrained by the OTel GenAI caveat in section 3 — the conventions are usable
   but not pinnable.

Option 2 is the better architectural bet; option 1 is the faster path to a first green run.
Doing 1 first and 2 at step 10 is a defensible sequence, provided `TraceSource` is introduced
at step 5 so option 1 does not harden into an assumption.

## Sources

- [OpenAI to acquire Promptfoo](https://openai.com/index/openai-to-acquire-promptfoo/) ·
  [TechCrunch](https://techcrunch.com/2026/03/09/openai-acquires-promptfoo-to-secure-its-ai-agents/) ·
  [Promptfoo announcement](https://www.promptfoo.dev/blog/promptfoo-joining-openai/)
- [LangWatch Scenario](https://scenario.langwatch.ai/) ·
  [Blackbox testing guide](https://langwatch.ai/scenario/testing-guides/blackbox-testing/) ·
  [Agent simulations](https://langwatch.ai/docs/agent-simulations/introduction) ·
  [MarkTechPost coverage](https://www.marktechpost.com/2026/03/04/langwatch-open-sources-the-missing-evaluation-layer-for-ai-agents-to-enable-end-to-end-tracing-simulation-and-systematic-testing/)
- [Langfuse evaluation docs](https://langfuse.com/docs/evaluation/overview) ·
  [Core concepts](https://langfuse.com/docs/evaluation/core-concepts)
- [Best CI/CD tools for testing AI agents 2026](https://www.confident-ai.com/knowledge-base/compare/best-ci-cd-tools-testing-ai-agents-before-production-2026) ·
  [AI eval tools for CI/CD](https://www.confident-ai.com/knowledge-base/compare/best-ai-evaluation-tools-for-ci-cd)
- [Best AI red teaming tools 2026](https://generalanalysis.com/guides/best-ai-red-teaming-tools) ·
  [LLM red teaming guide](https://appsecsanta.com/ai-security-tools/llm-red-teaming)
- [Detecting agent defects and drift in production](https://vadim.blog/agent-defect-drift-detection-production/) ·
  [Agent-first vs LLM-only platforms](https://latitude.so/blog/agent-first-comparison-guide-vs-braintrust)
- [Promptfoo HTTP provider docs](https://www.promptfoo.dev/docs/providers/http/) — basis for the
  "assumes the endpoint is already running" and session-handling claims in sections 3 and 4
- [State of the OpenTelemetry GenAI semantic conventions, July 2026](https://john-hodge.com/blog/opentelemetry-genai-semantic-conventions/) ·
  [GenAI convention overview](https://greptime.com/blogs/2026-05-09-opentelemetry-genai-semantic-conventions)
