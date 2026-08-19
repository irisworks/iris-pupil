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
# evals/docker-compose.stubs.yml
services:
  your-agent:
    environment:
      SLACK_API_BASE: http://slack-stub:9000
      JIRA_URL: http://jira-stub:9001

  slack-stub:
    image: your-org/slack-stub:latest

  jira-stub:
    image: your-org/jira-stub:latest
```

The stubs deliberately publish no host ports: the agent reaches them by service name over the
compose network, and binding `9000:9000` on the host makes two concurrent CI jobs on one runner
fail compose bring-up with "port is already allocated". Add a `ports:` mapping only when you
personally need to curl a stub from the host while debugging.

Use this whenever the agent already reads a tool's base URL from config. It's the cheapest
pattern to wire up and the first thing to check before reaching for anything else on this list.

### 2. Gateway-level, for the model layer

If your agent routes model calls through a gateway (IRIS already does, via LiteLLM), the
interception point already exists there — and gateways like LiteLLM cache responses natively.
For the model side of a first-party agent, there may be nothing left to build: point the gateway
at a caching or stub backend the same way you would any other tool.

```yaml
# evals/docker-compose.stubs.yml
services:
  your-agent:
    environment:
      LITELLM_BASE_URL: http://litellm-cache:4000

  litellm-cache:
    image: ghcr.io/berriai/litellm:main-latest
    command: ["--config", "/app/config.yaml"]
    volumes:
      - ./litellm-cache.yaml:/app/config.yaml:ro
```

### 3. MCP substitution

Where a tool is exposed as an MCP server, the boundary between agent and tool is already a
schema'd protocol. Swap in a recording or stub MCP server implementing the same schema — this is
far more tractable than intercepting arbitrary HTTP, because the contract is already explicit.

```yaml
# evals/docker-compose.stubs.yml
services:
  your-agent:
    environment:
      MCP_SERVER_URL: http://mcp-stub:9002

  mcp-stub:
    image: your-org/mcp-stub:latest
```

### 4. Egress HTTP proxy (last resort)

The general solution: route all outbound traffic through `HTTPS_PROXY`/`HTTP_PROXY` to a
record/replay proxy. This works for any tool regardless of how it's configured, but it needs TLS
MITM with a CA certificate installed in the agent's trust store — real infrastructure to stand up
and maintain. Reach for this only when patterns 1–3 don't apply.

**Node gotcha:** Node's built-in `fetch` does **not** honor `HTTP_PROXY`/`HTTPS_PROXY` by
default. `undici` (the library behind `fetch`) only routes through a proxy once one is installed
explicitly. If your agent is a Node service using `fetch` and relies on pattern 4, setting the
proxy environment variables alone does nothing on older runtimes: the proxy is silently bypassed,
the agent appears to work, and every call still hits the live API. Three ways out, cheapest first:

- **Node 24+**: run with `NODE_USE_ENV_PROXY=1` (or `--use-env-proxy`), which makes built-in
  `fetch` respect `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` with no source change.
- **Any Node with undici available**: install `new EnvHttpProxyAgent()` as the global dispatcher,
  which reads the same environment variables.
- **Explicit**: wire an `undici` `ProxyAgent` in code, pointed at the proxy URL directly.

Whichever you pick, confirm it is actually in effect — a bypassed proxy fails green, which is the
worst failure mode on this page.

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

**The exit-2 refusal is `pupil compare` only.** `pupil run --baseline` computes the same
comparison and prints the target mismatch in its output, but its exit code is driven by
regressions and verdicts alone — a hard fixture-set mismatch does not turn into exit `2` there. So
a CI job that runs `pupil run --fixture-set stubbed-slack --baseline` against a baseline recorded
as `fixtureSet: live` will report the differing outcomes as exit `1`, i.e. as regressions, which
is exactly the false signal this field exists to prevent. Keep each tier gated against a baseline
recorded with its own fixture set, and use `pupil compare` when you need the cross-tier
comparison to be refused rather than scored.

## Worked example: an IRIS-shaped agent

> The layout below is the shape sketched in [`product-direction.md`](product-direction.md) §8,
> whose agent-side details in turn derive from the IRIS interface in
> [`phase-plan.md`](phase-plan.md). Neither is confirmed against a real deployed agent — verify
> paths and env var names against your actual repo before relying on them.

```
your-agent/
├── evals/
│   ├── pupil.config.yaml       # fixtureSet lives under the preview profile, not top level
│   ├── docker-compose.stubs.yml
│   └── flows/*.yaml
└── .github/workflows/
    ├── pupil-preview.yml       # layers in the stub compose file, runs `pupil run --profile preview`
    └── pupil-postdeploy.yml    # real everything, runs `pupil run --profile prod`
```

`evals/pupil.config.yaml` is one file shared by every tier, so `target.fixtureSet` must **not** be
set at the top level — a live post-deploy run that omits `--fixture-set` would inherit
`stubbed-slack` from config and be stamped as stubbed, and the guard would then find no mismatch
against the stubbed PR run. Put it in the profile instead:

```yaml
target:
  system: your-agent # tier-independent identity only

profiles:
  preview:
    target:
      fixtureSet: stubbed-slack
  prod:
    target:
      fixtureSet: live
```

Every tier now labels itself, including the live ones. If you would rather not use profiles, pass
`--fixture-set` explicitly in **every** workflow — an unlabelled live run is the one case the
guard cannot catch.

The stub compose file layers stub services on top of the agent's normal compose file for the
PR-preview job only. Name it something other than `docker-compose.override.yml`: Compose
auto-merges a file by that name whenever it sits in the resolved project directory, which makes
inclusion opt-out rather than opt-in — a live tier running `docker compose up` from `evals/` would
silently pick up the stubs, and a preview job running it from the repo root would silently miss
them. Be explicit in each workflow instead:

```bash
# preview tier only
docker compose -f docker-compose.yml -f evals/docker-compose.stubs.yml up -d
```

The post-deploy and nightly-observe workflows simply omit the second `-f`, so those stages always
exercise the real integrations.
