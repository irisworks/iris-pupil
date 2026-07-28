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

## 4. What to build next

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
4. **Trajectory model + Langfuse client.** Extend `TurnRecord` with `toolCalls: [{name, args,
result, latencyMs, error}]`; add `tool_calls`, `cost_usd`, `tokens` to `metrics`. Add the
   read-only Langfuse client (raw fetch, Basic auth, poll for async ingestion) to populate
   them, plus a mock agent that emits tool events so this is testable without live IRIS.
5. **Tool assertions** — `tool_called`, `tool_not_called`, `tool_call_count`,
   `tool_order`, `tool_args` (jsonpath over args). This is the release that makes the
   "tool-calling agent" claim true.
6. **LLM judge** for semantic assertions, opt-in per scenario, with the deterministic
   pass/fail unaffected when the judge is unconfigured.
7. **`pupil observe`** — mode 3. Point at Langfuse, a session/tag filter, and a time window;
   apply metric thresholds to real traffic; write the same `RunResult` shape into the same
   history store so `compare` works unchanged across driven and observed runs.
8. **Driver registry + second driver.** Registry first, then whichever of RPC or
   in-process/subprocess wrapping a real internal target needs.
9. **Manual scoring** (`pupil score`) — completes Phase 1, but nothing else depends on it.

## 5. Release plan and internal adoption point

| Release                     | Contents  | What it unlocks                                                                               |
| --------------------------- | --------- | --------------------------------------------------------------------------------------------- |
| **v0.2 — CI-gateable**      | steps 1–3 | Pupil runs in `iris-runtime` CI **advisory / non-blocking**. Real signal, no merge authority. |
| **v0.3 — Agent-aware**      | steps 4–5 | **Internal adoption point.** Blocking merge gate on the IRIS repo.                            |
| **v0.4 — Semantic + drift** | steps 6–7 | Production drift alerting on live IRIS; judge for free-form replies.                          |
| **v0.5 — Multi-target**     | step 8    | Second internal target beyond IRIS; case for open-source launch.                              |

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
