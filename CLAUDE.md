# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Status

This repository now has the initial TypeScript/Node ESM scaffold for the Phase 1 Pupil MVP. The package exposes a `pupil` CLI, scenario schema/loader modules, and an IRIS-compatible mock HTTP agent for local tests.

## Commands

```bash
npm install
npm run build
npm run check
npm test
node dist/cli/index.js --help
node dist/cli/index.js validate examples/scenarios/iris-basic.yaml
node dist/cli/index.js discover examples/scenarios
node dist/cli/index.js mock-agent --port 5050
```

During local development, run the CLI through `node dist/cli/index.js` after `npm run build`. Default project settings live in `pupil.config.yaml`; `src/core/config.ts` resolves `${ENV_VAR}` and `${ENV_VAR:-default}` references before validation, matching bash semantics: plain `${ENV_VAR}` substitutes a set-but-empty value as an empty string and only errors if the variable is genuinely unset, while `${ENV_VAR:-default}` falls back to `default` whenever the variable is unset _or_ empty.

Every command that touches the config accepts `--config <path>` and `--profile <name>`. A profile is deep-merged over the top-level blocks, and only the selected profile is env-resolved, so an unset `${VAR}` in a profile you are not running is not an error. Because profiles are validated before that resolution, their numeric fields also accept `${VAR}` templates - the real numeric check happens after the merge.

Driver precedence for `pupil run` is `config.driver.config` < the scenario's own `driver.config` < CLI flags, so a project default never silently overrides a value a scenario set deliberately. The config's `driver.preset` fills in only for scenarios that name no preset. If no scenario path is given, `run` uses the config's `scenarios` field. Relative `scenarios` and `history.dir` values resolve against the process working directory, not the config file's directory.

The read-only commands (`list`, `report`, `baseline`, `score`) need nothing from the config but `history.dir`, so an unreadable ambient `pupil.config.yaml` degrades to `.pupil` with a warning instead of failing; naming `--config` or `--profile` explicitly still fails loudly.

## Langfuse Enrichment

`pupil run` enriches each scenario result with Langfuse trace evidence (trace id/url, cost, tokens, tool calls) as soon as the scenario finishes, so cost and token thresholds are scored against the enriched metrics. It is best-effort: lookup failures are recorded in `metadata.langfuse` and never change a run's verdict.

That still holds: a failed lookup produces `Verdict.Skip`, which has the same severity as `Pass`.
But tool assertions now _depend_ on this evidence and skip without it, so a green run with skipped
tool assertions means "not checked", not "verified" - see Tool Assertions below and
`--require-trace`.

Enrichment is pluggable: the runner accepts any `TraceSource` implementation via `traceSource` in `RunScenarioOptions`. Pass `LangfuseTraceSource.fromSettings(config.langfuse)` to use Langfuse, or implement `TraceSource` for another backend. Omitting `traceSource` falls back to Langfuse configured from the environment; `false` disables enrichment entirely.

Configuration comes from `pupil.config.yaml`'s `langfuse` block first, then the environment (`LANGFUSE_HOST` - `LANGFUSE_BASE_URL` is also accepted - plus `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY`). Config values win over env values when both are present. `enabled: false` or `pupil run --no-langfuse` disables it. Because Langfuse ingestion is asynchronous, lookups poll for up to `langfuse.waitMs` (default 25s) before recording a skip. Pupil performs one immediate lookup, then uses `langfuse.initialDelayMs` (default 8s, discounted by scenario runtime) before the second lookup and exponential backoff after that. Each individual HTTP lookup is bounded by `langfuse.timeoutMs` (or `LANGFUSE_TIMEOUT_MS`, default 3s), which slower Langfuse Cloud responses may need raised.

## CI Gating

`pupil run` can gate a pipeline on its own: `--baseline` compares against the run id in
`.pupil/baseline` and exits 1 on regression, `--strict` also fails on `needs_review`, `--json`
emits a machine-readable payload on stdout while progress moves to stderr, and `--junit <path>`
writes a JUnit report. A markdown summary is appended to `$GITHUB_STEP_SUMMARY` whenever that
variable is set.

Two deliberate asymmetries: `--junit` fails the run if the file cannot be written, because the user
asked for it, while a failed `$GITHUB_STEP_SUMMARY` append only warns, matching the best-effort
rule used for Langfuse. And a missing baseline warns on stderr but does not fail, so a first CI run
can establish one.

Regression thresholds live in the `compare` block of `pupil.config.yaml`
(`latencyThresholdPct` as a percent, `latencyThresholdMs`, and per-metric `metricThresholds`).
`src/history/compareOptions.ts` resolves them for both `pupil run --baseline` and `pupil compare`
so the two commands cannot disagree; `--latency-threshold-ms` and `--latency-threshold-pct`
override the config per invocation.

## Target Identity

`pupil run` stamps each `RunResult` with a `target` identity so `pupil compare` can tell whether two runs were actually exercising the same agent. Configure defaults in `pupil.config.yaml`'s `target:` block (`system`, `environment`, `version`, `fixtureSet`), and override any of them per-run with `--system`, `--environment`, `--target-version`, `--fixture-set`. `mode` is not configurable — `pupil run` always stamps `mode: "driven"`; there is no CLI flag for it.

`pupil compare <baseRunId> <currentRunId>` exits with one of three codes:

- `0` - no regressions found.
- `1` - regressions found.
- `2` - a hard target-identity mismatch (`system`, `mode`, or `fixtureSet` differ, including one side missing the field) was detected between the two runs. The comparison is refused as invalid rather than scored, since diffing a stubbed run against a live one (or vice versa) isn't meaningful. `environment`/`version` mismatches are "soft" and only produce a warning, not exit 2.

Any run recorded before this feature shipped has no `target` at all, which counts as a hard mismatch on `mode`. This means existing users will hit exit code 2 the first time they run `pupil compare` against an old baseline after upgrading. The fix is `pupil baseline <newRunId>` to establish a fresh, tagged baseline going forward.

## Tool Assertions

Scenarios can assert on the agent's trajectory, not just its reply text. Five assertion types
read `trajectory.toolCalls`, which `pupil run` populates from trace evidence:

- `tool_called` - the tool ran; optional `times` is an exact count.
- `tool_not_called` - the tool never ran.
- `tool_call_count` - `min`/`max` bounds; omit `tool` to count every call.
- `tool_order` - the listed tools appear in that relative order.
- `tool_args` - some call to the tool had matching arguments.

Matching is deliberately lenient so an assertion goes red only when the thing it names changed:
tool names match exactly unless `match: glob` is set, `tool_order` matches a **subsequence** (other
tools may appear in between), and `tool_args` is a **subset** match (extra keys in the actual
payload are ignored). Arrays inside `tool_args` compare by exact position and length.

Because IRIS returns `{text}` only, tool calls are invisible through the agent's public interface
and every tool assertion depends on a `TraceSource`. When no evidence is available the assertion
**skips** rather than failing: `Verdict.Skip` has the same severity as `Pass`, so a tracing outage
cannot turn a pipeline red. The distinction that matters is `undefined` versus `[]` -
`undefined` means the backend does not report tool calls at all (skip), while `[]` means a trace
was found showing zero calls, which is real evidence and scores normally. An agent that silently
stops calling a tool therefore fails, which is the regression these assertions exist to catch.

Skips are reported loudly - the plain terminal summary (a `WARNING:` line when any tool assertions
skipped), `--json` (`toolEvidenceSkips`), and the `$GITHUB_STEP_SUMMARY` markdown all say how many
assertions went unverified. For gates where "we could not check" must fail, set `requireTrace: true`
in `pupil.config.yaml` (including per-profile, so a `staging` promotion gate can require trace
evidence while per-PR runs don't) or pass `pupil run --require-trace`; it escalates only those
skips, leaving unrelated ones untouched. The recommended split is default (skip) on per-PR runs and
`--require-trace` on a staging-to-production promotion gate.

One honest limit: tool ordering comes from the trace backend's `startTime`, so `tool_order` is
reliable for sequential tool use and best-effort for parallel or concurrent calls that share a
millisecond.

### Tool metrics

Trace enrichment records two tool metrics, which catch different regressions:

- `tool_calls` — unique tool names used. Rising means the agent's scope
  changed: it reached for a tool it never used at baseline.
- `tool_invocations` — total number of tool calls. Rising means the agent got
  less efficient: retry loops, redundant lookups. `tool_calls` structurally
  cannot detect this, since one call each to N different tools and N calls to
  one tool are identical under it.

Gate them per scenario under `expect.thresholds`, or across runs via
`compare.metricThresholds` in `pupil.config.yaml` — `pupil compare` diffs every
recorded metric, so both are regression-tracked with no extra wiring. Both come
only from trace evidence: without it the threshold **skips** rather than fails,
matching the tool-assertion rule above. `--require-trace` escalates those skips
too. `examples/scenarios/iris-tool-efficiency.yaml` shows both in use.

`tool_calls` keeps the meaning it has always had — unique tool count. An
earlier draft of this feature considered changing it to total invocations;
`tool_invocations` is that total-count metric under its own name instead, so
no existing `tool_calls` threshold or baseline can silently start scoring
something different.

## Seeded Conversation State

Scenarios can start mid-conversation without paying for every turn that got them there. An
optional `seed:` block runs before the scenario's own asserted `turns:`:

```yaml
seed:
  strategy: replay # replay | fork | inject
  turns:
    - user: "..." # scaffolding - never asserted, optimized aggressively
turns:
  - user: "..." # the asserted turns
```

`seed.turns` entries have no `expect` field - the schema itself makes "seed turns are never
asserted against" true, not just documented. Three strategies, in the order they were built:

- `replay` - actually sends each seed turn through the driver first. Costs real requests, but
  works against any agent; no capability check.
- `fork` - replays the seed turns to build real state, then asks the driver to fork that session
  via a `fork` request template on `RestDriverConfig`, and runs the asserted turns against the
  fork.
- `inject` - skips replay entirely and asks the driver to create a session directly from a
  history payload, via an `inject` request template.

`fork` and `inject` mirror the existing optional `close` request template: a scenario requesting
one of them is checked against the driver's configured templates before any request is made, and
an unsupported combination fails immediately with a clear error - never an ambiguous timeout or a
guessed endpoint.

`ScenarioResult.turns` and `Trajectory.steps` include the seed turns (flagged `isSeed: true`), so
a broken seed turn is debuggable rather than invisible - but `ScenarioResult.metrics.turns` counts
only the asserted turns, and seed turns are never passed to assertion evaluation.

One honest limit: `replay` and `fork` make real driver calls during the seed phase, so a tool
triggered while seeding is indistinguishable - in Langfuse's session-level trace - from one
triggered during the asserted turns. Pupil filters `trajectory.toolCalls` (and the derived
`tool_calls`/`tool_invocations` metrics) to drop anything timestamped before the seed phase
finished, but a tool call with no timestamp is kept rather than guessed away - so a backend that
doesn't report `startedAt` can still leak seed-phase tool activity into tool assertions. `inject`
has no seed-phase traffic, so this limitation does not apply to it.

## What Pupil Is

Pupil is an open source framework for **continuous quality engineering for AI agents**: testing, evaluating, and preventing regressions as prompts, tools, models, and workflows evolve. It originated in the IRIS ecosystem but is designed to be framework agnostic.

## Design Principles (from README)

Any code written here should honor these:

- **Framework agnostic** - test any AI agent regardless of its underlying framework.
- **Black-box by default** - evaluate agents through their public interface, like a real user would.
- **Regression first** - the core job is detecting when previously working scenarios start failing.
- **Observability friendly** - integrate with existing tracing platforms such as Langfuse rather than replacing them.
- **Open and extensible** - connectors, evaluators, and scoring plugins should be easy to add.

## Intended Architecture

A central **Evaluation Engine** orchestrates scenarios against a target agent through pluggable **drivers**. Phase 1 starts with a generic REST driver and an `iris-http` preset; Slack, MCP, OpenTelemetry, hosted UI, and advanced benchmark workflows are out of scope for Phase 1.

The evaluation workflow: load a scenario -> execute it against the agent -> capture conversation and trace evidence -> score the outcome -> store results -> compare against previous runs to surface regressions.

Scenarios are YAML definitions with inputs, expected outcomes, thresholds, optional manual scoring, and optional judge blocks.

## Development Workflow

1. Keep scenario files readable and versionable YAML.
2. Keep core types/config in `src/core` and scenario-specific schema/loading in `src/scenario`.
3. Add drivers behind `src/driver` without coupling them to CLI command parsing.
4. Store run history as JSON or JSONL so regression output remains git-diffable.
5. Keep Langfuse as enrichment evidence, not the source of truth for Pupil results.

## Roadmap Priorities

Phase 1 is a thin REST-first MVP: scenario runner, REST driver, Langfuse enrichment, manual scoring, and JSON regression history.

Week 1: package/CLI scaffold, scenario schema, scenario loader, IRIS-compatible mock agent.
Week 2: generic REST driver, template engine, iris-http preset.
Week 3: runner, assertion/threshold evaluators, JSON history store.
Week 4: regression comparison, report/list/baseline commands, manual scoring.
Week 5: Langfuse enrichment, live IRIS examples, documentation polish.
