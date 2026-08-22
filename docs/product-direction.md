# Pupil — Product Direction

Status: draft for review · 2026-08-19 · baseline commit `d9265c6`

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

Phase 1's original scope is done, M6 (CI-gateable) has closed except for this document, and M7
(Agent-aware) is underway. `main` = `d9265c6`; ~4,650 lines of TypeScript (excl. tests, ~11,350
incl.), 288 tests across 20 files.

| Area                                                                                       | State                 |
| ------------------------------------------------------------------------------------------ | --------------------- |
| Scenario schema + loader (zod, YAML, dir scan, flat-`input` shorthand)                     | done                  |
| IRIS-compatible mock HTTP agent                                                            | done                  |
| Generic REST driver (`{{var}}` templates, jsonpath extract, retry on 408/429/5xx)          | done                  |
| `iris-http` preset (deep-merged over driver config)                                        | done                  |
| Runner (multi-turn, concurrency, per-scenario timeout, retry in a fresh conversation)      | done                  |
| Evaluator seam takes a `Trajectory`, not a raw response (IRIS-154)                         | done                  |
| Assertion evaluator (`contains`/`not_contains`/`equals`/`regex`/`jsonpath`)                | done                  |
| Threshold evaluator (`turns`, `latency_ms`, `cost_usd` with alias normalization)           | done                  |
| `compare` latency regression threshold as a percentage band, not a 0ms default (IRIS-151)  | done                  |
| JSON run history (`.pupil/runs/*.json`, `index.jsonl`, `baseline`)                         | done                  |
| Regression comparison (regressed / fixed / still-failing / new / removed + metric deltas)  | done                  |
| CLI: `validate`, `discover`, `run`, `compare`, `mock-agent`, `list`, `report`, `baseline`  | done                  |
| Manual scoring (`pupil score`) (IRIS-96)                                                   | done                  |
| Langfuse trace enrichment — session→trace lookup, poll/retry, cost/tokens (IRIS-97)        | done                  |
| This repo's own CI check workflow, Node 20 + 22 (IRIS-152)                                 | done                  |
| `loadPupilConfig()` wired into `run` behind `--config`/`--profile` (IRIS-153)              | done, PR #55          |
| Target identity as a typed `RunResult.target` + `compare` exit 2 on mismatch (IRIS-155)    | done, PR #53          |
| `TraceSource` interface + Langfuse reader behind it (IRIS-158)                             | done, PR #54          |
| Mock agent emits configurable tool spans, plus `MockTraceSource` (IRIS-160)                | done, PR #60          |
| CI-gate ergonomics: `--baseline`, `--strict`, `--json`, `--junit`, step summary (IRIS-156) | done, PR #59          |
| Fixture and stub conventions documented (IRIS-166)                                         | **in review**, PR #57 |

### Gaps, in order of how much they hurt

1. **~~Tool calls are read but not assertable.~~ RESOLVED (IRIS-161).** `TraceRecord.toolCalls`
   exists, `src/trace/index.ts` writes `metrics.tool_calls`, `metrics.tool_invocations`, and `metadata.<source>.toolCalls`
   onto every enriched run, and `MockTraceSource` can emit configurable spans for tests. Five
   assertion types now read that data: `tool_called`, `tool_not_called`, `tool_call_count`,
   `tool_order`, and `tool_args`, scenario-scoped (`src/eval/toolAssertions.ts`), with
   `--require-trace` to fail instead of skip when trace evidence is missing.
2. **Trace reading is swappable, but there is still only one implementation.** IRIS-158 landed
   the seam: `TraceSource` in `src/trace/index.ts`, with the Langfuse reader
   (`src/langfuse/index.ts`, 504 lines, IRIS-97) as one implementation behind it and
   `MockTraceSource` as another. Lookup is `GET /api/public/traces?sessionId=…` followed by
   `GET /api/public/traces/:traceId` for observations, with poll/retry; `cost_usd` and token
   thresholds score against the enriched metrics rather than always skipping. The remaining gap
   is proof the interface is real — a second production backend (OTel, Phoenix), IRIS-167.
3. **~~The evaluator seam is drive-shaped.~~ RESOLVED (IRIS-154).** The runner now builds a
   `Trajectory` (`{source: "driven"|"trace", steps[], ...}`) and assertions/thresholds evaluate
   that, not a raw `{response, turn, result}` shape. This is the foundation gap 1 and gap 9
   (§2.4, §6 step 9) build on.
4. **~~CI story is partial.~~ RESOLVED (IRIS-152 + IRIS-156).**
   `.github/workflows/check.yml` runs `npm run check` on Node 20 + 22, and PR #59 added the
   gating surface: `run --baseline` auto-compare with exit 1, `--strict` to fail on
   `needs_review`, `--json` (stable `RunJsonOutput` in `src/cli/reporting.ts`), `--junit <path>`,
   and an automatic `$GITHUB_STEP_SUMMARY` append. What remains is documentation and adoption,
   not code.

   `npm run check` **is green on `main`** as of `d9265c6` — typecheck, build, 288/288 tests,
   prettier clean on every tracked file. (An earlier revision of this document reported it red
   due to a `CLAUDE.md` formatting issue; that was fixed.)

5. **`pupil.config.yaml` is wired in.** Every command that needs it loads it, `--config` points
   at another file, and `--profile` deep-merges a `profiles.<name>` block over the top-level
   blocks. Driver precedence is config < scenario < CLI flag; the `examples/iris/*.yaml`
   scenarios inherit `baseUrl` instead of hardcoding it.
6. **~~`RunResult.metadata` is an unpopulated free-form bag.~~ RESOLVED (IRIS-155), differently
   than section 4 proposed.** Target identity landed as its own typed top-level field,
   `RunResult.target` (`system`, `environment`, `version`, `fixtureSet`, `mode`), not as keys
   inside `metadata` — and `compare` now exits 2 on a hard mismatch of `system`/`mode`/
   `fixtureSet` rather than scoring an invalid comparison. `metadata` remains free-form and holds
   trace evidence under `metadata.<traceSource>`. Section 4.3 records the shipped shape and the
   baseline-migration consequence.
7. **Driver abstraction is REST-shaped and not pluggable.** `Driver` is `{ readonly type }`;
   the runner hardcodes `if (scenario.driver.type !== "rest") throw`. No registry.
8. **No LLM judge; manual scoring shipped.** Judge config parses and nothing consumes it —
   still a gap. Manual scoring (`pupil score`) landed in IRIS-96 and is no longer a gap.

### Verified Linear state (irisflow team, iris-pupil project)

Replaces the git-history reconstruction in the prior revision now that the Linear connector is
available. Grouped by milestone; verify against Linear directly before planning, this is a
snapshot as of `d9265c6`. The M6/M7/M9 rows below were re-derived from merged pull requests
rather than a live Linear query, so treat issue states as PR-accurate and Linear-unconfirmed.

| Milestone                        | Issues                                                                                                                              |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| M0 Scaffold and CLI              | 82 done                                                                                                                             |
| M1 Scenario Schema and Loader    | 83, 84, 85, 86 done                                                                                                                 |
| M2 Mock Agent and Driver         | 87, 89 done; 88 (template engine) canceled — folded into 87                                                                         |
| M3 Runner Scoring and History    | 90, 91, 92, 93 done                                                                                                                 |
| M4 Compare, Report, and Baseline | 94, 95, 96 done                                                                                                                     |
| M5 Langfuse and Live IRIS        | 97, 98 done; 99 (docs polish) canceled — superseded by this issue, IRIS-157                                                         |
| M6 v0.2 CI-gateable              | 151, 152, 153, 154, 155, 156 done · **157 (this doc)** in progress — the milestone's last open item                                 |
| M7 v0.3 Agent-aware              | 158, 160 done · 161 (tool assertions) todo, now unblocked · 159 (traceparent) not started                                           |
| M8 v0.4 Continuous               | 163 (invariants), 164 (`pupil observe`) not started                                                                                 |
| M9 v0.5 Cheap and repeatable     | 166 (fixture conventions) in review, PR #57 · 165 (seeding) not started                                                             |
| M10 v0.6 Broad                   | 167 (second TraceSource, LLM judge, driver registry) not started — deliberately left as one placeholder, to be split when M9 closes |

Small hardening issues not tied to a milestone (all done): 104 (reject dual input/turns), 105
(error on missing explicit configPath), 106 (reject duplicate scenario ids), 107 (PR #1 review
follow-ups), 108 (set-but-empty env var semantics).

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
it got. **This part shipped** — gap 3 in section 2 is resolved (IRIS-154): the runner already
builds a `Trajectory`, so `observe` (§6 step 9, not yet started) only needs to be the second
producer of the same shape, not a second scoring path.

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

`src/history/compare.ts` already joins runs, and **target identity shipped** (IRIS-155, PR #53):
every run carries `RunResult.target` with `system`, `environment`, `version`, `fixtureSet`, and
`mode` (`run` always stamps `"driven"`; `"observed"` arrives with `pupil observe`, step 9). Without
it a staging run was indistinguishable from a production observation; now `compare` refuses the
comparison outright — exit 2 — when `system`, `mode`, or `fixtureSet` disagree, and warns on
`environment`/`version`. Note this landed as a typed top-level field, not as keys inside
`metadata` as earlier revisions of this section proposed. One migration consequence: any run
recorded before IRIS-155 has no `target`, which reads as a hard `mode` mismatch, so the first
`compare` after upgrading needs a fresh `pupil baseline <newRunId>`.

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
  does: **record the fixture set identity on the run** (`RunResult.target.fixtureSet`, shipped in
  IRIS-155), so a stubbed run is never compared against a live run and reported as a regression. Cross-mode baseline contamination is a real
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
| Fixture-set identity recorded in `RunResult.target`   | Pupil            |
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
M7-additive to critical path**, because IRIS's `POST /sessions/:id/message` returns `{text,
sessionId}` — the `sessionId` was added specifically for trace correlation, but no tool-call
data — making traces the sole route to tool calls, cost, and tokens. The same reader is what
makes observe mode and the continuity claim possible.

1. **✅ Done — Land PR #26** (`list`/`report`/`baseline`). Merged.
2. **✅ Done (IRIS-153, PR #55) — Wire `loadPupilConfig()` into `run`** — `--config`, flags
   override file, environment profiles so one suite targets preview, staging, and prod.
3. **✅ Done (IRIS-154) — Refactor the evaluator seam to `Trajectory`** (section 4.2).
4. **✅ Done (IRIS-155, PR #53) — Target identity** — shipped as a typed `RunResult.target`
   (`system`, `environment`, `version`, `fixtureSet`, `mode`) rather than loose keys in
   `metadata`, with `compare` exiting 2 on a hard mismatch (section 4.3).
5. **✅ Done — CI-gate ergonomics.** This repo's own `npm run check` workflow shipped
   (IRIS-152), and IRIS-156 (PR #59) added `run --baseline` auto-compare with exit 1, `--strict`,
   `--json`, `--junit`, and the automatic `$GITHUB_STEP_SUMMARY` append.
6. **🟡 Partial — `TraceSource` + Langfuse reader + `traceparent` correlation** (section 5.1).
   The interface extraction (IRIS-158, PR #54) and a mock agent that emits tool spans plus a
   `MockTraceSource` (IRIS-160, PR #60) have both landed. `traceparent` correlation itself
   (IRIS-159) is not started, so correlation is still the `sessionId` echo — strategy 2.
7. **✅ Done (IRIS-161) — Tool assertions** — `tool_called`, `tool_not_called`,
   `tool_call_count`, `tool_order`, `tool_args` over the `toolCalls` the `TraceSource` already
   returns. The trace-derived metrics themselves (`tool_calls`, `tool_invocations`, `cost_usd`, `input_tokens`,
   `output_tokens`, `total_tokens`) shipped with IRIS-97/158 and are **not** part of this step.
8. **⬜ Not started (IRIS-163) — Invariants** — the `invariants:` block, `maxViolationRate`,
   repo-level policy files (section 4.1).
9. **⬜ Not started (IRIS-164) — `pupil observe`** — the second `Trajectory` producer. Trace
   source + filter + window, invariant rates, same `RunResult` into the same store so `compare`
   works unchanged.
10. **✅ Done (IRIS-165) — Seeding** (section 5.2) — `seed:` block, `replay`, `fork` (driver
    declares support via a `fork` request template), `inject` (same, via an `inject` template).
11. **🔵 In review (IRIS-166, PR #57) — Fixture conventions** (section 5.3) — documented stub
    patterns and compose fragments, not a proxy implementation.
12. **⬜ Not started — Second `TraceSource`** — OTLP or Phoenix, proving the interface is real.
13. **⬜ Not started — LLM judge**, opt-in, deterministic verdicts unaffected when unconfigured.
14. **Driver registry + second driver: ⬜ not started. Manual scoring (`pupil score`): ✅ done**
    (IRIS-96, shipped ahead of this build-plan position).

Steps 12–14 are held as one Linear placeholder (IRIS-167), deliberately not split into
individual issues until M9 closes.

## 7. Release ladder and internal adoption

| Release                         | Steps | Status                               | What it unlocks                                                                        |
| ------------------------------- | ----- | ------------------------------------ | -------------------------------------------------------------------------------------- |
| **v0.2 — CI-gateable**          | 1–5   | 5/5 done                             | Runs in `iris-core` CI **advisory / non-blocking**. Correct plumbing, weak assertions. |
| **v0.3 — Agent-aware**          | 6–7   | step 6 partial, step 7 todo          | **Internal adoption point.** Blocking gate on trajectory regressions.                  |
| **v0.4 — Continuous**           | 8–9   | not started                          | Invariants shared across stages; production drift watch. The claim becomes true.       |
| **v0.5 — Cheap and repeatable** | 10–11 | step 10 done, step 11 in review      | Seeded state and stubbed tools make the PR tier fast and free.                         |
| **v0.6 — Broad**                | 12–14 | not started (one Linear placeholder) | Second trace source, judge, second driver. Open-source launch case.                    |

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
  depends on it. **It is green as of `d9265c6`** (IRIS-152) — typecheck, build, 288/288 tests,
  prettier clean.
- **Baseline hygiene.** Committed (`.pupil/baseline` in git, reviewable, PR-scoped) versus
  CI-cached. Committed fits the git-diffable, no-backend story and should be the documented
  default.

## 8. Worked example: irisworks/iris-core

**Verified directly against `irisworks/iris-core`'s server code**
(`iris-runtime/src/engine/api.ts`) as of this revision, superseding the `phase-plan.md`-derived
shape in the prior draft:

- Plain Node HTTP on `127.0.0.1:3000` (`IRIS_API_PORT`), `GET /health` → `{ok, channels}`.
- `POST /sessions` requires `{originChannel, originThreadTs}`; returns the full session object,
  including `sessionId`.
- `POST /sessions/:id/message` returns **`{text, sessionId}`, not `{text}` alone** (api.ts:678) —
  the `sessionId` echo was added specifically so callers correlating a turn with its Langfuse
  trace (Pupil, IRIS-97) can read it off the turn response. Pupil does not currently use the echo:
  the `iris-http` preset extracts only `reply: "$.text"` from the message response and takes its
  correlation key from `createConversation`'s `conversationId: "$.sessionId"`, which the runner
  then threads through as `conversation.id`. The echo is a redundant second route to the same
  value — useful if a scenario ever drives `message` without creating the session itself.
- `POST /sessions/:id/reset` exists as documented.
- Auth: both repos read the same `IRIS_API_TOKEN` env var name (`Authorization: Bearer <token>`)
  — no field-name translation needed between them.
- No `/sessions/:id/fork` or history-injection endpoint exists — session forking and inject-mode
  seeding (section 5.2) are not supported today.
- Session-correlated Langfuse traces **already shipped** in iris-core: PR `iris-core#134` merged
  on 2026-08-03, closing issue `#133`. It explicitly **does not include `traceparent`
  propagation** — so strategy 1 in section 5.1 still needs a separate ask to that team, and must
  not be filed as a follow-up to #134, which is closed.

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

`POST /sessions/:id/message` echoes `sessionId` but no tool-call data, so **tool calls are still
invisible black-box** even though correlation is easy. Every trajectory assertion depends on
trace evidence. Correlation route today is strategy 2 from section 5.1 — the `sessionId` Pupil already holds from
session creation, matched against Langfuse's `x-litellm-session-id` tagging. Strategy 1
(`traceparent`) would be better; iris-core's merged `#134` delivered session-correlated traces but
explicitly excludes `traceparent` propagation, so this needs a fresh ask to that team rather than a
follow-up on closed work (IRIS-159).

Because IRIS routes through LiteLLM, the model-layer interception point for the PR tier already
exists (section 5.3, point 2). Tool stubs and session forking do not.

### Candidate assertions

Pending a real look: routing (correct skill selected), tool selection
(`tool_called: calendar.create` once, `tool_not_called: email.send`), clarification behaviour
(did it ask when it already had enough information), `turns <= 2`, `cost_usd <= 0.05`, no-leak
invariants on reply text. Expressible today: the two thresholds, plus a coarse `tool_calls` count
threshold against the enriched metric. Naming a specific tool still needs IRIS-161.

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
