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

## Langfuse Enrichment

`pupil run` enriches each scenario result with Langfuse trace evidence (trace id/url, cost, tokens, tool calls) as soon as the scenario finishes, so cost and token thresholds are scored against the enriched metrics. It is best-effort: lookup failures are recorded in `metadata.langfuse` and never change a run's verdict.

Enrichment is pluggable: the runner accepts any `TraceSource` implementation via `traceSource` in `RunScenarioOptions`. Pass `LangfuseTraceSource.fromSettings(config.langfuse)` to use Langfuse, or implement `TraceSource` for another backend. Omitting `traceSource` falls back to Langfuse configured from the environment; `false` disables enrichment entirely.

Configuration comes from `pupil.config.yaml`'s `langfuse` block first, then the environment (`LANGFUSE_HOST` - `LANGFUSE_BASE_URL` is also accepted - plus `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY`). Config values win over env values when both are present. `enabled: false` or `pupil run --no-langfuse` disables it. Because Langfuse ingestion is asynchronous, lookups poll for up to `langfuse.waitMs` (default 25s) before recording a skip. Pupil performs one immediate lookup, then uses `langfuse.initialDelayMs` (default 8s, discounted by scenario runtime) before the second lookup and exponential backoff after that. Each individual HTTP lookup is bounded by `langfuse.timeoutMs` (or `LANGFUSE_TIMEOUT_MS`, default 3s), which slower Langfuse Cloud responses may need raised.

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
