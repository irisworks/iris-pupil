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

During local development, run the CLI through `node dist/cli/index.js` after `npm run build`. Default project settings live in `pupil.config.yaml`; `src/core/config.ts` resolves `${ENV_VAR}` and `${ENV_VAR:-default}` references before validation.

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
