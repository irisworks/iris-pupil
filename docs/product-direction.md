# Pupil — Product Direction

Status: draft for review · 2026-07-28 · baseline commit `281a12c`

Revision 2. Supersedes the first draft, which assumed Pupil could build and start the agent it
evaluates, and which overstated our differentiation on trajectory assertions. Both corrected
below.

## 1. Vision

Pupil is a **CLI tool you drop into a delivery pipeline to evaluate an agent** — not a prompt,
not a single-turn completion, but a full multi-turn, tool-calling agentic system. It must work
against **any** such system, including ones deployed by someone else.

Four commitments follow:

1. **Drive the agent through its own interface**, described in config rather than mandated as a
   protocol. REST today; RPC and code-wrapping next. No Pupil SDK inside the agent.
2. **Evaluate the trajectory, not the final string.** Turns, tool calls, tool order, recovery,
   cost — what actually breaks when a model or prompt changes.
3. **Read the observability the environment already has.** Never require the agent's telemetry
   to be repointed at us.
4. **Same definitions at every stage**, from pull request to production traffic, compared
   against one baseline lineage. This is what earns the word _continuous_; see section 4.

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
   `TurnRecord.response` is `{text, raw}`; metrics are `turns`, `latency_ms`, `retries`. Today
   Pupil evaluates _an HTTP endpoint that returns a string_ — the one thing the vision rules
   out.
2. **No trace reading.** `src/langfuse/index.ts` is a 4-line interface stub. Consequently
   `cost_usd` thresholds always SKIP and commitments 2–4 above are all unreachable.
3. **The evaluator seam is drive-shaped.** `AssertionEvaluationContext` is
   `{response, turn, result}`. Section 4 depends on the evaluator taking a `Trajectory` that
   either a driven run or a fetched trace can produce. Cheap to fix now, expensive later —
   fix it late and there will be two divergent scoring paths, which is precisely how the
   continuity claim dies in implementation.
4. **No CI story.** No `.github/workflows/`, no `--json`, no JUnit, no `run --baseline`
   auto-compare, no `--strict`.

   Concretely: **`npm run check` is currently red on `main`.** `prettier --check` fails on
   `CLAUDE.md` and `src/history/compare.ts`. Verified by stashing all local changes at
   `281a12c` — pre-existing, and it reached `main` because no workflow enforces the gate.

5. **`pupil.config.yaml` is dead config.** `loadPupilConfig()` is implemented, tested, and
   exported — and called by no CLI command. Every scenario file hardcodes
   `baseUrl: http://127.0.0.1:3000`.
6. **`RunResult.metadata` is an unpopulated free-form bag.** Section 4 needs target identity
   (environment, deployed version, mode, fixture set) in there for baselines to mean anything.
7. **Driver abstraction is REST-shaped and not pluggable.** `Driver` is `{ readonly type }`;
   the runner hardcodes `if (scenario.driver.type !== "rest") throw`. No registry.
8. **No LLM judge, no manual scoring.** Both parse; neither is consumed.

### Inferred Linear state

No Linear connector was available in the session that produced this document, so the following
is reconstructed from `IRIS-xx` refs in git history and `phase-plan.md` — **verify before
planning against it**. Landed: 84, 85, 86, 87, 89, 90, 91, 92, 93, 94, 98. In review: 95
(PR #26). Unaccounted for: 88 (template engine — code exists in `driver/index.ts`, likely
folded into 87), 96 (manual scoring), 97 (Langfuse).

## 3. Competitive landscape

### Where the market sits, mid-2026

**Commercial platforms** — LangSmith (~$39/seat, LangChain-native), Braintrust (~$249/mo,
$800M valuation after an $80M Series B), Arize, Galileo, Patronus, Maxim. All backend-first.

**Open-source observability platforms that grew evals** — Langfuse, Opik, Phoenix, LangWatch,
MLflow. Langfuse ships online evals (LLM-judge scoring of live traces), datasets, experiments.
It is simultaneously our evidence source and our nearest neighbour in observe mode.

**CLI/framework-first tools** — Promptfoo, DeepEval, Ragas, LangWatch `scenario`. Our band.

Two 2026 events reshaped it:

- **OpenAI acquired Promptfoo** (announced 9 March 2026; 11-person team, ~$86M post-money,
  150k+ developers, >25% of the Fortune 500). Stays open source, folds into OpenAI Frontier.
- **LangWatch open-sourced `scenario`** (March 2026): agent-under-test + simulated user +
  judge, multi-turn under pytest, black-box HTTP/CLI/SDK adapters, plus a `RedTeamAgent`.

### Correction: promptfoo already does trajectory assertions

The first draft graded black-box trajectory assertions as largely blank space. **That was
wrong.** Promptfoo runs its own OTLP receiver (port 4318), injects a W3C `traceparent` into
provider context, and asserts over the resulting spans:

```yaml
assert:
  - type: trajectory:tool-used
    value: search_orders
  - type: trajectory:tool-sequence
  - type: trace-span-count
    min: 3
    max: 10
```

Plus `trajectory:tool-args-match` and `trajectory:goal-success`. The first three are
deterministic. So neither trajectory evaluation nor determinism is novel, and the incumbent has
OpenAI's distribution behind it.

### The actual differentiator: pull, not push

Promptfoo is a **receiver**. It _is_ the collector: the agent must export spans to promptfoo's
endpoint, and promptfoo **cannot read from an external backend** — only its own receiver, with
optional outbound forwarding.

For a target you control pre-deploy, fine. For **an agent someone else deployed**, it means
repointing `OTEL_EXPORTER_OTLP_ENDPOINT` on their deployment or fanning out their collector —
frequently impossible.

Pupil should be a **reader**: "give me read credentials to the observability you already have."
That is the difference between _reconfigure your telemetry for my test tool_ and _grant read
access_. It is the one capability gap that structurally cannot be closed by a receiver-based
design, and it exists precisely because we target post-deploy.

Promptfoo also mandates nothing about the agent's API — no schema, `sessionParser` to extract a
session ID from headers or body, `{{sessionId}}` to feed it back, or `transformVars` with
`context.uuid` for client-generated IDs. That is the correct approach and validates our
generic-driver-plus-preset design. **Do not define an "open session / send chat" protocol
agents must implement**; describe their API in config instead. The only genuinely required
capability is one bit: _can a multi-turn conversation be scoped?_

### On red/blue teaming

Garak (NVIDIA, 37+ probes), PyRIT (Microsoft, multi-turn attack orchestration), Giskard, and
Promptfoo (50+ vulnerability types). **Do not enter this market.** Compose instead: pin their
findings as Pupil regression cases. Sell "your adversarial findings become permanent gates."

### Surviving differentiators, honestly

Each pass shrinks this list. What is left:

1. **Reads existing observability instead of being the collector** — confirmed unique vs
   promptfoo, and structurally required for post-deploy targets.
2. **Baseline/regression lineage across stages as the primary artifact**, not eval scores.
   Promptfoo's regression semantics have not been examined closely enough to bank this cleanly
   — verify before it goes in marketing.
3. **Post-deploy and drift positioning**, plus vendor neutrality as a live buying criterion
   post-acquisition.
4. **Config-first with no code and no backend** — `.pupil/` JSON in a repo, no account.

### The OTel constraint

As of 17 July 2026 no GenAI span, event, metric, or attribute is marked Stable. In v1.42.0
(12 June 2026) all `gen_ai.*` attributes moved out of the main semantic-conventions repo into a
dedicated GenAI repo — a cadence change, not a graduation. That repo has no releases or tags
yet and its schema-URL section is still a TODO. Agent and framework spans are experimental,
though reportedly stable in practice through Q1 2026.

So: **do not bind to OTel GenAI as a pinned contract.** Define Pupil's own small internal trace
model shaped after `gen_ai.*` so convergence is cheap later, and read through a `TraceSource`
interface with per-backend implementations. Neutrality becomes our property rather than
something inherited from an unfinished standard.

### Is this worth building?

Yes, but Phase 1 as originally scoped is not the product. REST driving, text assertions,
thresholds, and run history are table stakes promptfoo does better. Stopping there produces a
worse promptfoo. The existing code is necessary substrate for what follows — substrate, not
product — and the roadmap should stop treating Phase 1 completion as the goal.

## 4. Earning "continuous quality engineering"

The claim is defensible only if _continuous_ means something technical: **one quality
definition, evaluated at every stage, compared against one baseline lineage.**

Nobody can claim it today because each stage uses a different tool with a different vocabulary
— unit tests with a mocked model per PR, a platform's online evals post-deploy, dashboards in
production. Three result shapes, nothing comparable, so no one can answer the question that
matters: **did the thing we asserted in the PR actually hold in production?**

Answering that question is the product. Three ingredients.

### 4.1 Split input-bound assertions from input-free invariants

`reply contains "Tuesday"` requires the scripted input "book me Tuesday" — drive mode only. But
a large class of checks need no input at all:

- `tool_order: [user.confirm, email.send]` — never send before confirming
- `tool_not_called: deprecated.legacy_search`
- `turns <= 4`, `cost_usd <= 0.05`
- `not_contains: <secret pattern>`, no error spans

These hold for _any_ conversation, which makes them **the shared currency between PR time and
production**: one YAML block, evaluated against a scripted run in CI and against ten thousand
real traces overnight.

```yaml
turns: [...] # drive mode only
expect:
  assertions: [...] # input-bound → drive mode only
invariants: [...] # both modes, same block, evaluated everywhere
```

Plus repo-level invariants applying to every scenario and all production traffic.

### 4.2 Make `Trajectory` the single evaluator input

Driving an agent produces a trajectory; fetching a trace produces a trajectory. `run` and
`observe` become two producers of one structure, and the invariant evaluator never learns which
it got. See gap 3 in section 2 — this is a small refactor now and a fork in the codebase later.

One genuine design question inside it: a driven run is **one sample**, an observation is a
**population**, and `PASS` vs `4.2% violation` are not the same verdict type. Proposed
unification: invariants carry a `maxViolationRate`, and **drive mode is n=1 with rate threshold
0**. Same evaluator, same comparison arithmetic, both stages.

### 4.3 One baseline lineage

Same history store, same `RunResult` shape, three baseline selectors over one compare engine:

| Stage           | Compared against                                     | Action          |
| --------------- | ---------------------------------------------------- | --------------- |
| PR              | last known-good main                                 | block merge     |
| Post-deploy     | the run that gated the currently-deployed prod build | block promotion |
| Nightly observe | last night's rates                                   | alert on drift  |

`src/history/compare.ts` already joins runs. What is missing is gap 6: **runs must be tagged
with target identity** — environment, deployed version/commit, mode (`driven` | `observed`), and
fixture set. Without it a staging run is indistinguishable from a production observation and the
lineage means nothing.

Get this right and Pupil can print the sentence that proves the claim, which nothing in the
landscape can produce today:

> Scenario `refund-flow` · asserted in PR #412 · passed on staging at `v2.3.1` ·
> **invariant `tool_order` violated in 4.2% of production traffic last night**

### 4.4 Honest limit on the word "quality"

There are no datasets, A/B experiments, human annotation at scale, or judge. What this
architecture delivers is **behavioural quality** — trajectory conformance, policy compliance,
cost, regression. Keep the headline, let the subtitle carry the honesty: _the same behavioural
assertions, from pull request to production traffic._ The judge later extends toward answer
quality.

## 5. Two tiers, one format

Pupil does **not** have a PR mode and a deploy mode. It has one mode — evaluate a reachable
agent — and the pipeline decides what is reachable.

| Stage       | What is reachable                                             | Cadence      |
| ----------- | ------------------------------------------------------------- | ------------ |
| PR          | preview environment, or a locally-startable first-party agent | every push   |
| PR (no env) | `pupil validate` on the suite itself                          | every push   |
| Post-deploy | staging                                                       | every deploy |
| Production  | traces only, no driving                                       | nightly      |

Preview environments matter more than they first appear: Vercel, Railway, Render, a k8s
namespace, or Argo preview apps already give a per-PR URL. Where one exists, post-deploy
black-box evaluation _is_ per-PR evaluation — same mechanism, different URL. Continuity comes
from the tool being indifferent to stage.

This is also why **`target:` lifecycle management is dropped from the roadmap entirely.**
Preview envs and staging are deployed by the pipeline, not by Pupil. The Playwright `webServer`
analogy breaks on exactly this point: e2e tests run against a build you just made; agents run
against an environment someone else deployed. For the local dev loop,
`docker compose up && pupil run` is one line of script, not a feature.

### 5.1 Trace correlation — the load-bearing mechanism

Since we read rather than receive, finding _our_ trace among a shared environment's traffic is
the central technical risk. Three strategies, in preference order, none requiring an SDK:

1. **`traceparent` propagation.** Pupil generates a trace ID and sends `traceparent` on the
   request; the agent's OTel instrumentation adopts it as parent context, which standard HTTP
   auto-instrumentation does for free. Langfuse's OTLP endpoint (`/api/public/otel`) parses
   inbound `traceparent` and nests spans inside the existing trace — so spans land in _their_
   backend under a trace ID **Pupil knew before it made the call.** No guessing, no timestamp
   matching. The happy path, and what the docs should lead with.
2. **Session/tag lookup.** The agent returns an ID its tracing already records. This is IRIS
   today: `POST /sessions` returns `sessionId`, and LiteLLM tags Langfuse via
   `x-litellm-session-id`. Also zero instrumentation.
3. **Optional shim library** — for agents that are traced but do not propagate: read an inbound
   header, stamp the correlation ID onto whatever tracer is in use. ~100 lines per ecosystem.

Tier 3 carries a real cost: the moment Pupil needs code inside the agent, "black-box by
default, no SDK in the agent" is broken — the first README principle and a differentiator.
Build it if gap cases demand it, keep it a documented fallback, and never let it become the
recommended path. If the shim becomes the happy path, Pupil has quietly become an
instrumentation vendor competing with Langfuse.

### 5.2 Seeded conversation state

Starting a scenario at turn 11 without paying for turns 1–10. The trade-off is a triangle —
cheap, faithful, universally available; pick two.

| Strategy   | Mechanism                            | Cheap | Faithful | Notes                                |
| ---------- | ------------------------------------ | ----- | -------- | ------------------------------------ |
| **inject** | `POST /sessions {history: [...]}`    | yes   | no       | not supported by IRIS today          |
| **fork**   | seed once, `POST /sessions/:id/fork` | yes   | yes      | needs agent support; the ideal shape |
| **replay** | actually run the turns, cheaply      | no    | yes      | always available                     |

`inject` tests the agent against a transcript **it did not produce**. Real histories carry its
own phrasing, tool results, and internal scaffolding — scratchpads, memory summaries, RAG state
— that a synthetic transcript lacks, so injection can produce false passes _and_ false fails on
exactly the state-dependent bugs being seeded for.

`fork` is the one item worth putting on an agent-contract wishlist — not "implement our
protocol" but "let us clone a session," which is independently useful for debugging and support
replay.

`replay` costs less than it appears: the preamble prefix is byte-identical every run, so input
tokens hit prompt cache at roughly 10%. Output tokens for the scaffolding turns are not cached,
so it remains real money at 50 scenarios per deploy.

Proposed schema, degrading by agent capability:

```yaml
seed:
  strategy: fork # inject | fork | replay
  turns: [...] # scaffolding — never asserted, optimized aggressively
turns: [...] # the asserted turns
```

The unglamorous first question per scenario: **is the preamble load-bearing?** If the assertion
concerns only turn 11, ten turns of context is often accumulated noise a single rich input
reproduces. Genuine memory and state bugs need real history; most scenarios do not.

### 5.3 Tool and model interception

Real tool backends make CI expensive, flaky, and secret-hungry. Four interception points, best
first:

1. **Per-tool base URL override.** Well-built agents already configure integrations by env
   (`SLACK_API_BASE`, `JIRA_URL`). Point them at a stub server. No TLS interception, no certs,
   no proxy semantics. The default answer.
2. **Gateway-level for the model layer.** IRIS already routes through LiteLLM — the
   interception point exists and LiteLLM caches natively. For the model side of a first-party
   agent, possibly nothing to build.
3. **MCP substitution.** Where tools are MCP servers the boundary is already a schema'd
   protocol; swapping in a recording server is far more tractable than arbitrary HTTP.
4. **Egress HTTP proxy** (`HTTPS_PROXY` + record/replay). The general solution and the last
   resort: needs TLS MITM with a CA cert in the agent's trust store, and **Node's built-in
   `fetch` does not honour `HTTP_PROXY`/`HTTPS_PROXY`** — undici requires an explicit
   `ProxyAgent`. For Node agents the proxy is silently bypassed while appearing to work, and
   everything hits live APIs.

Two structural rules:

- **Do not build a record/replay proxy.** WireMock, mitmproxy, VCR, Polly, and MSW exist.
  Pupil defines the contract — tool endpoints are configurable, here is a compose fragment —
  and the agent repo owns its stubs. What _is_ Pupil-shaped is one small thing nobody else
  does: **record the fixture set identity in run metadata**, so a stubbed run is never compared
  against a live run and reported as a regression. Cross-mode baseline contamination is a real
  failure mode and the fix is three fields.
- **Interception requires control of deployment config**, so it belongs to the pre-deploy and
  preview tier, never to someone else's staging. That is what gives the PR tier teeth: preview
  env + stubbed tools + cached model + forked state → cheap, deterministic, fast. Post-deploy
  stays real everything, small smoke suite, read-only traces.

Hazard to track: **stubs drift.** Stub Slack, Slack changes, the PR tier stays green while
production breaks. The live post-deploy tier is the backstop, and stubs need periodic
re-recording, contract-test style.

### 5.4 Ownership boundaries

Getting these wrong is how CI eval projects die.

| Concern                                               | Owner            |
| ----------------------------------------------------- | ---------------- |
| Driving the agent, assertions, invariants, history    | Pupil            |
| Trace reading and correlation                         | Pupil            |
| Fixture-set identity recorded in run metadata         | Pupil            |
| Deploying the agent, preview envs, staging            | the pipeline     |
| Model keys, DB, vector store, auth, tool stub content | the agent's repo |
| Scenario and invariant files, and the baseline        | the agent's repo |

**Scenarios live next to the agent**, e.g. `iris-core/evals/*.yaml`, so a prompt change and the
eval covering it land in the same pull request. `examples/` in this repo stays demo-only.

And a boundary worth stating as a testability requirement rather than a feature request: **if an
agent cannot be brought up in a deterministic test configuration from its own repo, that is a
defect in the agent repo that Pupil exposes, not a gap for Pupil to fill.** Same category as
needing dependency injection before a class is unit-testable.

## 6. Build plan

Ordered, each step shippable. The reprioritization that matters: **trace reading moves from
M7-additive to critical path**, because IRIS's `POST /sessions/:id/message` returns `{text}`
only, making traces the sole route to tool calls, cost, and tokens — and the same reader is
what makes observe mode and the continuity claim possible.

1. **Land PR #26** (`list`/`report`/`baseline`). Blocking review, not work.
2. **Wire `loadPupilConfig()` into `run`** — `--config`, flags override file, environment
   profiles so one suite targets preview, staging, and prod.
3. **Refactor the evaluator seam to `Trajectory`** (section 4.2). Do this before any trajectory
   feature, not after.
4. **Target identity in `RunResult.metadata`** — environment, version, mode, fixture set
   (section 4.3).
5. **CI-gate ergonomics** — `run --baseline` auto-compare with exit 1, `--strict`, `--json`,
   JUnit XML, `$GITHUB_STEP_SUMMARY`. Plus this repo's own `npm run check` workflow.
6. **`TraceSource` + Langfuse reader + `traceparent` correlation** (section 5.1), with a mock
   agent that emits tool spans so it is testable without live IRIS.
7. **Trajectory model and tool assertions** — `toolCalls[]` on the trajectory; `tool_called`,
   `tool_not_called`, `tool_call_count`, `tool_order`, `tool_args`. Add `tool_calls`,
   `cost_usd`, `tokens` metrics.
8. **Invariants** — the `invariants:` block, `maxViolationRate`, repo-level policy files
   (section 4.1).
9. **`pupil observe`** — the second `Trajectory` producer. Trace source + filter + window,
   invariant rates, same `RunResult` into the same store so `compare` works unchanged.
10. **Seeding** (section 5.2) — `seed:` block, `replay` first since it always works, then
    `fork` and `inject` as agent support allows.
11. **Fixture conventions** (section 5.3) — documented stub patterns and compose fragments, not
    a proxy implementation.
12. **Second `TraceSource`** — OTLP or Phoenix, proving the interface is real.
13. **LLM judge**, opt-in, deterministic verdicts unaffected when unconfigured.
14. **Driver registry + second driver**; then **manual scoring** (`pupil score`).

## 7. Release ladder and internal adoption

| Release                         | Steps | What it unlocks                                                                        |
| ------------------------------- | ----- | -------------------------------------------------------------------------------------- |
| **v0.2 — CI-gateable**          | 1–5   | Runs in `iris-core` CI **advisory / non-blocking**. Correct plumbing, weak assertions. |
| **v0.3 — Agent-aware**          | 6–7   | **Internal adoption point.** Blocking gate on trajectory regressions.                  |
| **v0.4 — Continuous**           | 8–9   | Invariants shared across stages; production drift watch. The claim becomes true.       |
| **v0.5 — Cheap and repeatable** | 10–11 | Seeded state and stubbed tools make the PR tier fast and free.                         |
| **v0.6 — Broad**                | 12–14 | Second trace source, judge, second driver. Open-source launch case.                    |

**Start using it at v0.2, trust it at v0.3.**

At v0.2 Pupil can run per-deploy and produce a comparison, but its only assertions are over
reply text — it will miss what matters (agent silently stops calling a tool, calls it twice,
calls them out of order) while producing false reds on benign wording changes. Gating on that
teaches the team to ignore it, the one failure mode a quality tool cannot recover from.

v0.3 is the first release where red means something specific and true: _this change altered the
agent's trajectory or blew a cost budget._ That is when it earns gate authority. v0.4 is when
the product name stops being aspirational.

Two preconditions, cheap now and expensive later:

- **Own CI first.** This repo's `npm run check` must be green on every PR before another repo
  depends on it. It is currently red — see gap 4.
- **Baseline hygiene.** Committed (`.pupil/baseline` in git, reviewable, PR-scoped) versus
  CI-cached. Committed fits the git-diffable, no-backend story and should be the documented
  default.

## 8. Worked example: irisworks/iris-core

The `iris-core` repo was **not in scope for the session that produced this document**, so the
specifics below are a shape derived from the IRIS interface documented in `phase-plan.md` —
plain Node HTTP on `127.0.0.1:3000`, `GET /health`, `POST /sessions`,
`POST /sessions/:id/message` blocking and returning `{text}`, `POST /sessions/:id/reset`,
Langfuse via LiteLLM, no OTel. **Confirm against the real repo before building.**

### Layout

```
iris-core/
├── evals/
│   ├── pupil.config.yaml      # environment profiles: preview | staging | prod
│   ├── invariants.yaml        # repo-wide policy, applies in both modes
│   ├── flows/*.yaml           # scenarios
│   └── .pupil/baseline        # committed, reviewed in PRs
└── .github/workflows/
    ├── pupil-preview.yml      # per PR, against the preview URL
    ├── pupil-staging.yml      # per deploy, gates promotion
    └── pupil-drift.yml        # nightly, observe mode over production traces
```

### The blocker specific to iris-core

`POST /sessions/:id/message` returns `{text}` and nothing else, so **tool calls are invisible
black-box.** Every trajectory assertion depends on trace evidence. Correlation route today is
strategy 2 from section 5.1 — `sessionId` from session creation, matched against Langfuse's
`x-litellm-session-id` tagging. Strategy 1 (`traceparent`) would be better and needs IRIS to
propagate inbound trace context; worth raising with that team since it is a small change with
value beyond eval.

Because IRIS routes through LiteLLM, the model-layer interception point for the PR tier already
exists (section 5.3, point 2). Tool stubs and session forking do not.

### Candidate assertions

Pending a real look: routing (correct skill selected), tool selection
(`tool_called: calendar.create` once, `tool_not_called: email.send`), clarification behaviour
(did it ask when it already had enough information), `turns <= 2`, `cost_usd <= 0.05`, no-leak
invariants on reply text. Only the last two are expressible today.

## Sources

- [OpenAI to acquire Promptfoo](https://openai.com/index/openai-to-acquire-promptfoo/) ·
  [TechCrunch](https://techcrunch.com/2026/03/09/openai-acquires-promptfoo-to-secure-its-ai-agents/) ·
  [Promptfoo announcement](https://www.promptfoo.dev/blog/promptfoo-joining-openai/)
- [Promptfoo tracing](https://www.promptfoo.dev/docs/tracing/) — OTLP receiver, `traceparent`
  injection, trajectory assertions, and the confirmed inability to read external backends
- [Promptfoo HTTP provider](https://www.promptfoo.dev/docs/providers/http/) — `sessionParser`,
  `transformVars`, and "no formal schema is mandated"
- [Langfuse OTel integration](https://langfuse.com/integrations/native/opentelemetry) ·
  [Langfuse with an existing OTel setup](https://langfuse.com/faq/all/existing-otel-setup) —
  `/api/public/otel` parses inbound `traceparent`
- [Langfuse evaluation docs](https://langfuse.com/docs/evaluation/overview) ·
  [Core concepts](https://langfuse.com/docs/evaluation/core-concepts)
- [LangWatch Scenario](https://scenario.langwatch.ai/) ·
  [Blackbox testing guide](https://langwatch.ai/scenario/testing-guides/blackbox-testing/) ·
  [Agent simulations](https://langwatch.ai/docs/agent-simulations/introduction)
- [State of the OpenTelemetry GenAI semantic conventions, July 2026](https://john-hodge.com/blog/opentelemetry-genai-semantic-conventions/) ·
  [GenAI convention overview](https://greptime.com/blogs/2026-05-09-opentelemetry-genai-semantic-conventions)
- [Best AI red teaming tools 2026](https://generalanalysis.com/guides/best-ai-red-teaming-tools) ·
  [LLM red teaming guide](https://appsecsanta.com/ai-security-tools/llm-red-teaming)
- [Best CI/CD tools for testing AI agents 2026](https://www.confident-ai.com/knowledge-base/compare/best-ci-cd-tools-testing-ai-agents-before-production-2026) ·
  [Detecting agent defects and drift in production](https://vadim.blog/agent-defect-drift-detection-production/)
