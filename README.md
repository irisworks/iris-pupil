# Pupil

**Continuous quality engineering for AI agents.**

Pupil is an open source framework for testing, evaluating, and preventing regressions in AI agents.

As software engineering has unit tests, integration tests, and end-to-end tests, AI agents need a repeatable way to verify that they continue to perform correctly as prompts, tools, models, and workflows evolve.

Pupil provides that layer.

---

## Why Pupil?

Building an AI agent is easy.

Knowing that it still works after today's change is hard.

Questions every team eventually asks:

- Did this prompt change break an existing workflow?
- Is the agent taking more turns than before?
- Which tool call failed?
- Did task completion improve or regress?
- How does this version compare to last week's release?
- What changed between two model versions?

Pupil helps answer these questions with repeatable evaluations and measurable quality metrics.

---

## Core Principles

- **Framework agnostic**
  Test any AI agent, regardless of the underlying framework.

- **Black-box by default**
  Evaluate agents through their public interface, just like a real user.

- **Regression first**
  Detect when previously working scenarios begin to fail.

- **Observability friendly**
  Integrates with existing tracing platforms such as Langfuse rather than replacing them.

- **Open and extensible**
  Add new connectors, evaluators, and scoring plugins with minimal effort.

---

## What Pupil Evaluates

Pupil can measure:

- Task completion
- Success rate
- Number of turns
- Tool usage
- Latency
- Cost
- Human intervention
- Failure modes
- Custom business KPIs

---

## Architecture

```text
                  Pupil

            Evaluation Engine
                    │
        ┌───────────┼───────────┐
        │           │           │
   Slack Driver   API Driver   MCP Driver
        │           │           │
        └───────────┼───────────┘
                    │
               AI Agent Runtime
                    │
             Langfuse / OTEL / ...
```

Pupil focuses on orchestrating evaluations and scoring outcomes while leveraging existing observability systems for traces and telemetry.

---

## Example Workflow

1. Load an evaluation scenario.
2. Execute the scenario against the target agent.
3. Capture the conversation and execution traces.
4. Evaluate the outcome using one or more scoring strategies.
5. Store results and compare them against previous runs.
6. Surface regressions before they reach production.

---

## Example Evaluation

```yaml
scenario: Book a meeting

input: Schedule a 30 minute meeting with John tomorrow at 2 PM.

expected:
  - Calendar event created
  - Invite sent
  - No clarification required

scores:
  completion: PASS
  turns: 2
  latency_ms: 4200
  human_intervention: false
```

---

## Integrations

Planned integrations include:

- Iris
- Slack
- Microsoft Teams
- MCP
- REST APIs
- Langfuse
- OpenTelemetry
- GitHub Actions
- Playwright
- Copilot Studio

Testing an agent that calls external backends? See [`docs/fixtures.md`](docs/fixtures.md) for how
to stub them out during PR-time evaluation.

---

## Roadmap

### Phase 1

- Scenario runner
- REST driver
- Langfuse integration
- Manual scoring
- Regression history

### Phase 2

- YAML scenario definitions
- Plugin architecture
- GitHub Actions integration
- Automatic regression reports
- Team dashboards

### Phase 3

- Multi-agent evaluation
- Benchmark suites
- Enterprise connectors
- Hosted Pupil Cloud

---

## Philosophy

AI systems should be tested with the same rigor as traditional software.

Pupil brings continuous quality engineering to AI agents by making evaluations repeatable, measurable, and easy to automate.

---

## Origin

Pupil was originally developed as part of the **IRIS** ecosystem and is designed to work with any AI agent framework.
