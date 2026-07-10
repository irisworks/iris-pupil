# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Status

This is a greenfield repository. It currently contains only the README and LICENSE — there is no source code, build system, package manifest, or test infrastructure yet. When implementation begins, update this file with the actual build/lint/test commands and language/framework choices.

## What Pupil Is

Pupil is an open source framework for **continuous quality engineering for AI agents**: testing, evaluating, and preventing regressions as prompts, tools, models, and workflows evolve. It originated in the IRIS ecosystem but is designed to be framework agnostic.

## Design Principles (from README)

Any code written here should honor these:

- **Framework agnostic** — test any AI agent regardless of its underlying framework.
- **Black-box by default** — evaluate agents through their public interface, like a real user would.
- **Regression first** — the core job is detecting when previously working scenarios start failing.
- **Observability friendly** — integrate with existing tracing platforms (Langfuse, OpenTelemetry) rather than replacing them.
- **Open and extensible** — connectors, evaluators, and scoring plugins should be easy to add.

## Intended Architecture

A central **Evaluation Engine** orchestrates scenarios against a target agent through pluggable **drivers** (Slack, REST API, MCP — later Teams, Playwright, Copilot Studio). Traces and telemetry come from external observability systems (Langfuse / OTEL), not from Pupil itself.

The evaluation workflow: load a scenario → execute it against the agent → capture conversation and traces → score the outcome (task completion, success rate, turns, tool usage, latency, cost, human intervention, custom KPIs) → store results and compare against previous runs to surface regressions.

Scenarios are planned to be YAML definitions with inputs, expected outcomes, and scores (see the "Example Evaluation" in README.md).

## Roadmap Priorities

Phase 1 (current focus): scenario runner, Slack driver, Langfuse integration, manual scoring, regression history. Phase 2 adds YAML scenario definitions, a plugin architecture, GitHub Actions integration, and dashboards. Phase 3 targets multi-agent evaluation, benchmark suites, and a hosted cloud offering.
