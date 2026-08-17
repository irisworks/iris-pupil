# Fixture and Stub Conventions

Real tool backends (Slack, Jira, a vector store, an LLM provider) make CI expensive, flaky, and
secret-hungry. This document describes how to point your agent at fakes during PR-time
evaluation, and how Pupil keeps a stubbed run from being silently compared against a live one.

Two rules shape everything below:

1. **Pupil does not build a record/replay proxy.** WireMock, mitmproxy, VCR, Polly, and MSW
   already exist for that. Pupil defines the contract — tool endpoints are configurable, here is
   a compose fragment — and your repo owns its stubs.
2. **Interception belongs to the pre-deploy/preview tier only**, never someone else's staging.
   That's what gives the PR tier teeth: preview env + stubbed tools + cached model + forked state
   → cheap, deterministic, fast. Post-deploy stays real-everything, a small smoke suite,
   read-only traces.

## Interception patterns, best first

### 1. Per-tool base URL override (the default answer)

Most well-built agents already configure their integrations by environment variable —
`SLACK_API_BASE`, `JIRA_URL`, and so on. Point that variable at a stub server instead of the real
API. No TLS interception, no certificates, no proxy semantics — just a different URL.

```yaml
# docker-compose.override.yml
services:
  your-agent:
    environment:
      SLACK_API_BASE: http://slack-stub:9000
      JIRA_URL: http://jira-stub:9001

  slack-stub:
    image: your-org/slack-stub:latest
    ports:
      - "9000:9000"
```

Use this whenever the agent already reads a tool's base URL from config. It's the cheapest
pattern to wire up and the first thing to check before reaching for anything else on this list.

### 2. Gateway-level, for the model layer

If your agent routes model calls through a gateway (IRIS already does, via LiteLLM), the
interception point already exists there — and gateways like LiteLLM cache responses natively.
For the model side of a first-party agent, there may be nothing left to build: point the gateway
at a caching or stub backend the same way you would any other tool.

```yaml
# docker-compose.override.yml
services:
  your-agent:
    environment:
      LITELLM_BASE_URL: http://litellm-cache:4000
```

### 3. MCP substitution

Where a tool is exposed as an MCP server, the boundary between agent and tool is already a
schema'd protocol. Swap in a recording or stub MCP server implementing the same schema — this is
far more tractable than intercepting arbitrary HTTP, because the contract is already explicit.

```yaml
# docker-compose.override.yml
services:
  your-agent:
    environment:
      MCP_SERVER_URL: http://mcp-stub:9002

  mcp-stub:
    image: your-org/mcp-stub:latest
    ports:
      - "9002:9002"
```

### 4. Egress HTTP proxy (last resort)

The general solution: route all outbound traffic through `HTTPS_PROXY`/`HTTP_PROXY` to a
record/replay proxy. This works for any tool regardless of how it's configured, but it needs TLS
MITM with a CA certificate installed in the agent's trust store — real infrastructure to stand up
and maintain. Reach for this only when patterns 1–3 don't apply.

**Node gotcha:** Node's built-in `fetch` does **not** honor `HTTP_PROXY`/`HTTPS_PROXY` —
`undici` (the library behind `fetch`) requires an explicit `ProxyAgent` to be configured in code.
If your agent is a Node service using `fetch` and relies on pattern 4, setting the proxy
environment variables alone does nothing: the proxy is silently bypassed, the agent appears to
work, and every call still hits the live API. Confirm your agent explicitly wires up a
`ProxyAgent` before trusting this pattern.

## Hazard: stubs drift

A stub is a snapshot of an API's behavior at the moment you recorded or wrote it. Real APIs
change. If Slack changes its response shape and your Slack stub doesn't, the PR tier stays green
on every push while production quietly breaks against the real API.

The live post-deploy tier is the backstop for exactly this failure mode — it's why interception
is scoped to the pre-deploy/preview tier only, never staging. Treat stubs like contract tests:
re-record or re-verify them periodically, not just when someone remembers to.

See also: the [Node/undici proxy gotcha](#4-egress-http-proxy-last-resort) — a second, unrelated
way a stub setup can silently stop reflecting reality.

## Recording the fixture set: `--fixture-set`

Once your agent is running against stubs, tell Pupil so it can guard against comparing a stubbed
run against a live one. Pass `--fixture-set <name>` on `pupil run`:

```bash
pupil run ./scenarios --fixture-set stubbed-slack
```

or set it in `pupil.config.yaml`:

```yaml
target:
  fixtureSet: stubbed-slack # live | stubbed-<name>
```

Label your live-backend runs the same way (`fixtureSet: live`).

`pupil compare` treats `fixtureSet` as a **hard** mismatch field, alongside `system` and `mode`:
if the base and current runs carry different fixture sets — or one has a fixture set recorded and
the other doesn't — the comparison is flagged as invalid and `pupil compare` exits with status `2`
rather than reporting a false regression. Because it's a hard field, this catches the asymmetric
case too: a stubbed run labeled `fixtureSet: stubbed-slack` compared against a run whose target
carries no `fixtureSet` at all is still refused, not silently compared. The one case the guard
can't catch is two runs that _neither_ ever recorded a fixture set — there's nothing to compare
against — so the guarantee only holds once every run, stubbed or live, is labelled.

## Worked example: an IRIS-shaped agent

> The specifics below are a shape derived from `phase-plan.md`, not confirmed against a real
> deployed agent. Verify paths and env var names against your actual repo before relying on them.

```
your-agent/
├── evals/
│   ├── pupil.config.yaml       # target.fixtureSet: stubbed-slack for the PR tier
│   ├── docker-compose.override.yml
│   └── flows/*.yaml
└── .github/workflows/
    └── pupil-preview.yml       # brings up the compose override, runs `pupil run --fixture-set stubbed-slack`
```

`docker-compose.override.yml` layers stub services on top of the agent's normal compose file for
the PR-preview job only — the post-deploy and nightly-observe workflows never include it, so
those stages always exercise the real integrations.
