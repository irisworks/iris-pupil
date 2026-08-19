import { describe, expect, it } from "vitest";
import { compareRuns } from "../history/compare.js";
import { Verdict, type RunResult, type ScenarioResult } from "../core/types.js";
import {
  buildRunJson,
  buildStepSummaryMarkdown,
  countToolEvidenceSkips,
  formatJUnitXml,
  isStrictFailure,
} from "./reporting.js";

function scenarioResult(overrides: Partial<ScenarioResult> = {}): ScenarioResult {
  return {
    scenarioId: "scenario-1",
    scenarioName: "Scenario 1",
    verdict: Verdict.Pass,
    scores: [
      {
        name: "assertion:contains:response.text",
        verdict: Verdict.Pass,
        reason: "Expected response.text to contain ok",
        metadata: {},
      },
    ],
    turns: [],
    startedAt: "2026-08-07T00:00:00.000Z",
    completedAt: "2026-08-07T00:00:01.000Z",
    metrics: { turns: 1, latency_ms: 1000 },
    ...overrides,
  };
}

function runResult(overrides: Partial<RunResult> = {}, results?: ScenarioResult[]): RunResult {
  const scenarioResults = results ?? [scenarioResult()];
  return {
    runId: "run-1",
    verdict: Verdict.Pass,
    results: scenarioResults,
    startedAt: "2026-08-07T00:00:00.000Z",
    completedAt: "2026-08-07T00:00:01.000Z",
    summary: {
      total: scenarioResults.length,
      passed: scenarioResults.filter((r) => r.verdict === Verdict.Pass).length,
      failed: scenarioResults.filter((r) => r.verdict === Verdict.Fail).length,
      needsReview: scenarioResults.filter((r) => r.verdict === Verdict.NeedsReview).length,
      errors: scenarioResults.filter((r) => r.verdict === Verdict.Error).length,
    },
    metadata: {},
    ...overrides,
  };
}

describe("isStrictFailure", () => {
  it("treats fail and error as failures regardless of strict", () => {
    expect(isStrictFailure(Verdict.Fail, false)).toBe(true);
    expect(isStrictFailure(Verdict.Fail, true)).toBe(true);
    expect(isStrictFailure(Verdict.Error, false)).toBe(true);
  });

  it("treats needs_review as a failure only in strict mode", () => {
    expect(isStrictFailure(Verdict.NeedsReview, false)).toBe(false);
    expect(isStrictFailure(Verdict.NeedsReview, true)).toBe(true);
  });

  it("never treats pass or skip as a failure", () => {
    expect(isStrictFailure(Verdict.Pass, true)).toBe(false);
    expect(isStrictFailure(Verdict.Skip, true)).toBe(false);
  });
});

describe("buildRunJson", () => {
  it("produces a stable shape without turn transcripts or raw payloads", () => {
    const run = runResult();
    const json = buildRunJson(run, { strict: false, historyPath: "/tmp/run-1.json" });

    expect(json).toEqual({
      runId: "run-1",
      verdict: Verdict.Pass,
      strict: false,
      summary: run.summary,
      historyPath: "/tmp/run-1.json",
      toolEvidenceSkips: 0,
      scenarios: [
        {
          scenarioId: "scenario-1",
          scenarioName: "Scenario 1",
          verdict: Verdict.Pass,
          metrics: { turns: 1, latency_ms: 1000 },
          scores: [
            {
              name: "assertion:contains:response.text",
              verdict: Verdict.Pass,
              reason: "Expected response.text to contain ok",
            },
          ],
        },
      ],
    });
  });

  it("includes a baseline block when a comparison is supplied", () => {
    const base = runResult({ runId: "base" });
    const current = runResult({ runId: "current", verdict: Verdict.Fail }, [
      scenarioResult({ verdict: Verdict.Fail }),
    ]);
    const comparison = compareRuns(base, current);

    const json = buildRunJson(current, {
      strict: false,
      historyPath: "/tmp/current.json",
      comparison,
      baselineRequested: true,
    });

    expect(json.baseline).toEqual({
      status: "compared",
      baseRunId: "base",
      hasRegressions: true,
      summary: comparison.summary,
      regressions: [
        {
          scenarioId: "scenario-1",
          reasons: comparison.scenarios[0].reasons,
        },
      ],
    });
  });

  it("reports status not_set when a baseline was requested but none exists", () => {
    const json = buildRunJson(runResult(), {
      strict: false,
      historyPath: ".pupil/runs/run-1.json",
      baselineRequested: true,
    });

    expect(json.baseline).toEqual({ status: "not_set" });
  });

  it("omits baseline entirely when none was requested", () => {
    const json = buildRunJson(runResult(), {
      strict: false,
      historyPath: ".pupil/runs/run-1.json",
    });

    expect(json.baseline).toBeUndefined();
  });

  it("tags a completed comparison with status compared", () => {
    const base = runResult({ runId: "base-run" });
    const current = runResult({ runId: "run-1" });
    const json = buildRunJson(current, {
      strict: false,
      historyPath: ".pupil/runs/run-1.json",
      comparison: compareRuns(base, current),
      baselineRequested: true,
    });

    expect(json.baseline).toMatchObject({ status: "compared", baseRunId: "base-run" });
  });
});

describe("formatJUnitXml", () => {
  it("renders a passing testcase with no failure element", () => {
    const xml = formatJUnitXml(runResult(), { strict: false });
    expect(xml).toContain('<testsuite name="pupil" tests="1" failures="0" errors="0"');
    expect(xml).toContain('<testcase name="scenario-1" classname="Scenario 1"');
    expect(xml).not.toContain("<failure");
  });

  it("renders needs_review as passing unless strict is set", () => {
    const run = runResult({ verdict: Verdict.NeedsReview }, [
      scenarioResult({
        verdict: Verdict.NeedsReview,
        scores: [
          { name: "manual:overall", verdict: Verdict.NeedsReview, reason: "pending", metadata: {} },
        ],
      }),
    ]);

    const lenient = formatJUnitXml(run, { strict: false });
    expect(lenient).not.toContain("<failure");

    const strict = formatJUnitXml(run, { strict: true });
    expect(strict).toContain("<failure");
    expect(strict).toContain('failures="1"');
  });

  it("renders error verdicts as <error>, not <failure>", () => {
    const run = runResult({ verdict: Verdict.Error }, [
      scenarioResult({
        verdict: Verdict.Error,
        scores: [{ name: "execution", verdict: Verdict.Error, reason: "boom", metadata: {} }],
      }),
    ]);

    const xml = formatJUnitXml(run, { strict: false });
    expect(xml).toContain('<error message="boom">');
    expect(xml).not.toContain("<failure");
    expect(xml).toContain('errors="1"');
  });

  it("escapes XML-significant characters in names and messages", () => {
    const run = runResult({}, [
      scenarioResult({
        scenarioId: "a & b",
        scenarioName: 'quote "test"',
        verdict: Verdict.Fail,
        scores: [{ name: "s", verdict: Verdict.Fail, reason: "<bad> & ugly", metadata: {} }],
      }),
    ]);

    const xml = formatJUnitXml(run, { strict: false });
    expect(xml).toContain("a &amp; b");
    expect(xml).toContain("&quot;test&quot;");
    expect(xml).toContain("&lt;bad&gt; &amp; ugly");
  });

  it("counts an error verdict as an error only, never also as a failure", () => {
    const run = runResult({ verdict: Verdict.Error }, [
      scenarioResult({
        verdict: Verdict.Error,
        scores: [{ name: "execution", verdict: Verdict.Error, reason: "boom", metadata: {} }],
      }),
    ]);

    const xml = formatJUnitXml(run, { strict: false });

    expect(xml).toContain('failures="0"');
    expect(xml).toContain('errors="1"');
  });

  it("strips XML-illegal control characters but preserves tab, LF, and CR", () => {
    const run = runResult({ verdict: Verdict.Fail }, [
      scenarioResult({
        verdict: Verdict.Fail,
        scores: [
          {
            name: "assertion",
            verdict: Verdict.Fail,
            reason: `bad\u0000output\u001b[31m	kept
kept`,
            metadata: {},
          },
        ],
      }),
    ]);

    const xml = formatJUnitXml(run, { strict: false });

    expect(xml).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
    expect(xml).toContain("\tkept");
  });
});

describe("buildStepSummaryMarkdown", () => {
  it("renders the run summary table", () => {
    const md = buildStepSummaryMarkdown(runResult(), {});
    expect(md).toContain("## Pupil run `run-1`");
    expect(md).toContain("**Verdict:** pass");
    expect(md).toContain("| 1 | 1 | 0 | 0 | 0 |");
  });

  it("renders a regressions table when a comparison has regressions", () => {
    const base = runResult({ runId: "base" });
    const current = runResult({ runId: "current", verdict: Verdict.Fail }, [
      scenarioResult({ verdict: Verdict.Fail }),
    ]);
    const comparison = compareRuns(base, current);

    const md = buildStepSummaryMarkdown(current, { comparison });
    expect(md).toContain("### Comparison vs `base`");
    expect(md).toContain("**Regressions detected.**");
    expect(md).toContain("scenario-1");
  });

  it("reports no regressions when the comparison is clean", () => {
    const base = runResult({ runId: "base" });
    const current = runResult({ runId: "current" });
    const comparison = compareRuns(base, current);

    const md = buildStepSummaryMarkdown(current, { comparison });
    expect(md).toContain("No regressions.");
  });

  const toolSkipScore = {
    name: "assertion:tool_called:calendar.create",
    verdict: Verdict.Skip,
    reason: "No tool call evidence available",
    metadata: { skipped: "no_tool_evidence" },
  };

  it("warns in the step summary when tool assertions were not verified", () => {
    const run = runResult({}, [scenarioResult({ scores: [toolSkipScore] })]);

    expect(buildStepSummaryMarkdown(run, {})).toContain(
      "1 tool assertion skipped — no trace evidence",
    );
  });

  it("omits the warning when every tool assertion was verified", () => {
    const run = runResult({}, [scenarioResult({ scores: [] })]);

    expect(buildStepSummaryMarkdown(run, {})).not.toContain("no trace evidence");
  });
});

describe("countToolEvidenceSkips", () => {
  const toolSkipScore = {
    name: "assertion:tool_called:calendar.create",
    verdict: Verdict.Skip,
    reason: "No tool call evidence available",
    metadata: { skipped: "no_tool_evidence" },
  };

  it("counts tool assertions skipped for missing evidence", () => {
    const run = runResult({}, [
      scenarioResult({
        scores: [
          toolSkipScore,
          {
            name: "threshold:cost_usd",
            verdict: Verdict.Skip,
            reason: "Cost metric is missing; skipping cost threshold",
            metadata: {},
          },
        ],
      }),
    ]);

    expect(countToolEvidenceSkips(run)).toBe(1);
  });
});
