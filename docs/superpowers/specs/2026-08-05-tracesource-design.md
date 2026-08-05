# TraceSource Interface Design

**Issue:** IRIS-158  
**Date:** 2026-08-05  
**Status:** Approved  

---

## Problem

`src/runner/index.ts` imports `enrichScenarioWithLangfuse` directly from `src/langfuse/index.ts`. Any caller that wants trace enrichment is implicitly coupled to Langfuse. Adding a second backend (OTel, Honeycomb, etc.) would require changes in core.

The product direction (section 2, OTel constraint) requires reading through a `TraceSource` interface with per-backend implementations so neutrality is Pupil's own property rather than inherited from an unfinished standard.

---

## Decisions

- **Runner API:** inject a `TraceSource` instance (Option A — clean DI, no auto-wiring in runner)
- **Metadata key:** keep `metadata.langfuse` as per IRIS-158 scope; each backend declares its own `metadataKey`
- **Migration shim:** none — Pupil is pre-1.0; users re-baseline after upgrading

---

## Module Structure

```
src/trace/index.ts        NEW   TraceSource interface, TraceRecord, TraceStatus,
                                applyTraceEnrichment, summarizeTraceRun,
                                sessionIdForResult
src/langfuse/index.ts     MOD   LangfuseTraceSource class; all Langfuse-specific
                                types remain here, not re-exported
src/runner/index.ts       MOD   traceSource? replaces langfuse?; imports from
                                src/trace only — zero langfuse imports
src/cli/index.ts          MOD   constructs LangfuseTraceSource.fromSettings()
                                instead of passing raw settings to runner
src/index.ts              MOD   exports TraceSource, TraceRecord, TraceStatus,
                                LangfuseTraceSource — removes LangfuseEnrichment,
                                enrichScenarioWithLangfuse, enrichRunWithLangfuse,
                                summarizeLangfuseRun from public API
```

**Boundary rule:** `src/runner/` and `src/trace/` import nothing from `src/langfuse/`. Only `src/cli/` and `src/index.ts` may reference `LangfuseTraceSource`.

---

## Interface and Types

### `TraceRecord`

Pupil's internal trace model. Shaped after `gen_ai.*` field semantics without binding to OTel attribute names.

```ts
export interface TraceRecord {
  readonly traceId?: string;
  readonly traceUrl?: string;
  readonly traceCount: number;
  readonly costUsd?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly toolCalls: string[];   // deduplicated, sorted
}

export type TraceStatus = "enriched" | "skipped" | "error";
```

### `TraceSource`

```ts
/**
 * Resolves observability evidence for a completed scenario run.
 *
 * Implementations are backend-specific (Langfuse, OTel, etc.) and are
 * injected into the runner — core never depends on a concrete implementation.
 *
 * `metadataKey` is the key written into ScenarioResult.metadata and
 * RunResult.metadata for this backend (e.g. "langfuse", "otel"). Callers
 * reading enrichment results use this key.
 *
 * `resolve` returns undefined when no trace is found for the key.
 * It should throw only on unrecoverable errors; the runner treats all
 * errors as best-effort and records them without changing any verdict.
 *
 * Adding a second backend: implement this interface, set metadataKey,
 * implement resolve(), and pass an instance as traceSource to runScenario.
 * No changes required in core.
 */
export interface TraceSource {
  readonly metadataKey: string;
  resolve(correlationKey: string): Promise<TraceRecord | undefined>;
}
```

### `applyTraceEnrichment`

Pure function. Writes a resolved `TraceRecord` into `result.metrics` and `result.metadata[metadataKey]`. Never touches `result.verdict` or `result.scores`.

```ts
export function applyTraceEnrichment(
  result: ScenarioResult,
  correlationKey: string,
  record: TraceRecord | undefined,
  metadataKey: string,
): TraceStatus
```

`metadata[metadataKey]` shape:

```ts
// success
{ status: "enriched", traceId, traceUrl, toolCalls, traceCount? }
// miss
{ status: "skipped", correlationKey, reason: "No trace found for session" }
// error
{ status: "error", correlationKey, reason: "<message>" }
```

### `summarizeTraceRun`

Rolls per-scenario statuses into `run.metadata[metadataKey]`. Direct replacement for `summarizeLangfuseRun`.

```ts
export function summarizeTraceRun(run: RunResult, metadataKey: string): RunResult
```

### `sessionIdForResult`

Extracted from `src/langfuse/` (previously `sessionIdForScenario`). Reads `metadata.sessionId` or the first `response.raw.{sessionId,session_id,id}` from turns.

---

## `LangfuseTraceSource`

Wraps the existing HTTP/polling logic unchanged. No behavior differences from current `enrichScenarioWithLangfuse`.

```ts
export class LangfuseTraceSource implements TraceSource {
  readonly metadataKey = "langfuse";

  constructor(
    private readonly config: LangfuseConfig,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly options?: { waitMs?: number; pollIntervalMs?: number; timeoutMs?: number },
  ) {}

  static fromSettings(
    settings?: LangfuseSettings,
    env?: NodeJS.ProcessEnv,
  ): LangfuseTraceSource | undefined {
    const config = resolveLangfuseConfig({ settings, env });
    if (!config) return undefined;
    return new LangfuseTraceSource(config, globalThis.fetch, {
      waitMs: config.waitMs,
      timeoutMs: config.timeoutMs,
    });
  }

  async resolve(sessionId: string): Promise<TraceRecord | undefined> {
    // delegates to existing lookupSession → extractLangfuseEnrichment
    // maps LangfuseEnrichment → TraceRecord (field names are already backend-agnostic)
  }
}
```

Types kept internal to `src/langfuse/` (not re-exported): `LangfuseConfig`, `LangfuseSettings`, `LangfuseEnrichmentOptions`, `LangfuseEnrichment`, `enrichScenarioWithLangfuse`, `enrichRunWithLangfuse`, `summarizeLangfuseRun`.

---

## Runner Changes

### `RunScenarioOptions`

```ts
// BEFORE
langfuse?: LangfuseEnrichmentOptions | false;

// AFTER
traceSource?: TraceSource | false;
```

### Enrichment call site (two places — success path and error path)

```ts
if (options.traceSource !== false && options.traceSource) {
  const key = sessionIdForResult(baseResult);
  try {
    const record = key ? await options.traceSource.resolve(key) : undefined;
    applyTraceEnrichment(baseResult, key ?? "", record, options.traceSource.metadataKey);
  } catch (error) {
    applyTraceEnrichment(baseResult, key ?? "", undefined, options.traceSource.metadataKey);
  }
}
```

Best-effort is enforced here: `resolve()` errors are caught by the runner and passed to `applyTraceEnrichment` as `undefined`, which writes `status: "error"` to metadata. `applyTraceEnrichment` itself is pure and never throws.

### Run summary

```ts
// BEFORE
return summarizeLangfuseRun(run);

// AFTER
return options.traceSource && options.traceSource !== false
  ? summarizeTraceRun(run, options.traceSource.metadataKey)
  : run;
```

### Runner imports

```ts
// BEFORE
import { enrichScenarioWithLangfuse, summarizeLangfuseRun, type LangfuseEnrichmentOptions } from "../langfuse/index.js";

// AFTER
import { applyTraceEnrichment, summarizeTraceRun, sessionIdForResult, type TraceSource } from "../trace/index.js";
```

### CLI change

```ts
// BEFORE
langfuse: options.langfuse === false ? false : { settings: config.langfuse }

// AFTER
traceSource: options.langfuse === false
  ? false
  : LangfuseTraceSource.fromSettings(config.langfuse)
```

---

## Testing

### `src/langfuse/index.test.ts`

`extractLangfuseEnrichment` and `resolveLangfuseConfig` tests unchanged. `enrichScenarioWithLangfuse` tests migrate to test `LangfuseTraceSource.resolve()` + `applyTraceEnrichment()` directly — same coverage, same assertions on `metadata.langfuse`. AC1 satisfied.

### `src/runner/index.test.ts`

`langfuse: { config, fetchImpl }` becomes `traceSource: new LangfuseTraceSource(config, fetchImpl)`. `langfuse: false` becomes `traceSource: false`. Behavior assertions on `metadata.langfuse` and metric values unchanged.

### `src/trace/index.test.ts` (new)

Unit tests for `applyTraceEnrichment` and `summarizeTraceRun` using a stub `TraceSource`:

```ts
const stubSource: TraceSource = {
  metadataKey: "test",
  resolve: async () => ({ traceId: "t1", traceCount: 1, toolCalls: [], costUsd: 0.01 }),
};
```

This stub also demonstrates AC2: a second backend in 4 lines with zero core changes.

---

## Acceptance Criteria Mapping

| Criterion | How satisfied |
|---|---|
| Current enrichment behaviour unchanged, existing Langfuse tests still pass | `LangfuseTraceSource` wraps identical HTTP/polling logic; `metadata.langfuse` key preserved; test coverage migrated not deleted |
| Interface documented well enough that a second backend needs no core changes | `TraceSource` JSDoc + stub in `src/trace/index.test.ts` is the living proof |
| No Langfuse-specific type escapes the `TraceSource` boundary | `src/runner/` and `src/trace/` import nothing from `src/langfuse/`; only `LangfuseTraceSource` (a class name, not a type shape) is re-exported |
