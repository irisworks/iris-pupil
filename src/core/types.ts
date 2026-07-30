/** Final outcome for an assertion, scenario, or full run. */
export enum Verdict {
  Pass = "pass",
  Skip = "skip",
  NeedsReview = "needs_review",
  Fail = "fail",
  Error = "error",
}

const VERDICT_SEVERITY: Record<Verdict, number> = {
  [Verdict.Pass]: 0,
  [Verdict.Skip]: 0,
  [Verdict.NeedsReview]: 1,
  [Verdict.Fail]: 2,
  [Verdict.Error]: 3,
};

export function verdictSeverity(verdict: Verdict): number {
  return VERDICT_SEVERITY[verdict];
}

/** Aggregate child verdicts conservatively: error > fail > needs_review > pass. */
export function aggregateVerdicts(verdicts: readonly Verdict[]): Verdict {
  return verdicts.reduce((current, next) => {
    return verdictSeverity(next) > verdictSeverity(current) ? next : current;
  }, Verdict.Pass);
}

export interface PupilErrorContext {
  file?: string;
  path?: string;
}

export class PupilError extends Error {
  readonly context: PupilErrorContext;

  constructor(message: string, context: PupilErrorContext = {}) {
    super(message);
    this.name = "PupilError";
    this.context = context;
  }
}

export interface ScenarioDriverRef {
  type: string;
  preset?: string;
  config: Record<string, unknown>;
}

export interface TextAssertionCheck {
  type: "contains" | "not_contains" | "equals" | "regex";
  target: string;
  value: string;
  caseSensitive: boolean;
}

export interface JsonPathAssertionCheck {
  type: "jsonpath";
  target: string;
  path: string;
  equals?: unknown;
  exists?: boolean;
}

/** Assertion Pupil can evaluate against an agent response. */
export type AssertionCheck = TextAssertionCheck | JsonPathAssertionCheck;

export interface ThresholdCheck {
  metric: string;
  max?: number;
  min?: number;
}

export interface ManualScoringConfig {
  required: boolean;
  criteria: string[];
  prompt?: string;
  rubric?: string[];
}

export interface JudgeConfig {
  enabled: boolean;
  prompt?: string;
  rubric?: string[];
  model?: string;
}

export interface ScenarioExpectations {
  assertions: AssertionCheck[];
  thresholds: ThresholdCheck[];
  manual?: ManualScoringConfig;
  judge?: JudgeConfig;
}

export interface ScenarioTurn {
  user: string;
  expect: AssertionCheck[];
}

export interface Scenario {
  id: string;
  name: string;
  description?: string;
  tags: string[];
  metadata: Record<string, unknown>;
  driver: ScenarioDriverRef;
  turns: ScenarioTurn[];
  expect: ScenarioExpectations;
  sourceFile?: string;
}

export interface TurnRecord {
  index: number;
  user: string;
  response?: {
    text?: string;
    raw?: unknown;
  };
  startedAt: string;
  completedAt?: string;
  latencyMs?: number;
  assertions: Score[];
  error?: string;
}

export interface Score {
  name: string;
  verdict: Verdict;
  reason?: string;
  value?: unknown;
  metadata: Record<string, unknown>;
}

export interface ScenarioResult {
  scenarioId: string;
  scenarioName: string;
  verdict: Verdict;
  scores: Score[];
  turns: TurnRecord[];
  startedAt: string;
  completedAt: string;
  metrics: Record<string, number>;
  sourceFile?: string;
}

export interface RunResult {
  runId: string;
  verdict: Verdict;
  results: ScenarioResult[];
  startedAt: string;
  completedAt: string;
  summary: {
    total: number;
    passed: number;
    failed: number;
    needsReview: number;
    errors: number;
  };
  metadata: Record<string, unknown>;
}
