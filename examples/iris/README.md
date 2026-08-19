# Live IRIS Examples

This directory contains live examples for running Pupil against a local IRIS runtime through the `iris-http` REST preset.

## Local Setup

Start IRIS locally so the runtime exposes the REST API on localhost. These scenarios set no `baseUrl` of their own: it comes from `driver.config.baseUrl` in `pupil.config.yaml`, which defaults to

```bash
http://127.0.0.1:3000
```

If your local IRIS uses a different URL, set `IRIS_BASE_URL`, run with `--profile staging`, or override it per run with `--base-url`. If IRIS requires auth, set `IRIS_API_TOKEN` or pass `--bearer-token`.

```bash
export IRIS_API_TOKEN=...
npm run build
```

On Windows PowerShell:

```powershell
$env:IRIS_API_TOKEN = "..."
npm run build
```

## Passing Smoke Run

Use the successful flow first. It should pass when IRIS is reachable and returns the standard `{ text: string }` message response.

```bash
node dist/cli/index.js run examples/iris/successful-flow.yaml \
  --base-url http://127.0.0.1:3000 \
  --origin-thread-ts pupil-live-success
```

## Diagnostic Runs

These examples intentionally demonstrate failure modes. They are expected to exit nonzero and should leave clear run history in `.pupil/runs`.

Timeout flow:

```bash
node dist/cli/index.js run examples/iris/timeout-flow.yaml \
  --base-url http://127.0.0.1:3000 \
  --origin-thread-ts pupil-live-timeout
```

Retry flow:

```bash
node dist/cli/index.js run examples/iris/retry-flow.yaml \
  --base-url http://127.0.0.1:3000 \
  --origin-thread-ts pupil-live-retry \
  --retries 2
```

Failure flow:

```bash
node dist/cli/index.js run examples/iris/failure-flow.yaml \
  --base-url http://127.0.0.1:3000 \
  --origin-thread-ts pupil-live-failure
```

## Full Suite

The full directory includes both passing and intentionally failing diagnostic scenarios, so it should run but exit nonzero:

```bash
node dist/cli/index.js run examples/iris \
  --base-url http://127.0.0.1:3000 \
  --origin-thread-ts pupil-live-suite \
  --retries 2
```

Review the saved run JSON under `.pupil/runs/<runId>.json` for per-scenario verdicts, assertion details, timeout errors, retries, latency, and turn records.
