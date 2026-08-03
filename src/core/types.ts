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

/**
 * One observed step in an agent trajectory.
 *
 * This is intentionally shaped near OpenTelemetry GenAI concepts (input,
 * output, timing, usage, and provider-specific raw payloads) without binding
 * Pupil to any experimental semantic-convention field names.
 */
export interface TrajectoryStep {
  index: number;
  input?: {
    role: "user" | "system" | "assistant" | "tool";
    content?: string;
    raw?: unknown;
  };
  output?: {
    role: "assistant" | "tool";
    content?: string;
    raw?: unknown;
  };
  startedAt?: string;
  completedAt?: string;
  latencyMs?: number;
  error?: string;
  /**
   * Producer-specific extras. The driven producer stores the turn's own
   * assertion scores here under `assertions` so `turn.assertions` targets keep
   * resolving; trace producers may store span attributes instead.
   */
  metadata: Record<string, unknown>;
}

/**
 * Evaluator input shared by driven runs and future trace-derived producers.
 *
 * Driven runs build this from TurnRecord data. A trace reader can build the
 * same shape from Langfuse/OTel spans without changing assertion or threshold
 * evaluators. `currentStepIndex` scopes turn-level expectations; scenario-level
 * expectations use the final response by default.
 *
 * When `currentStepIndex` is set, response targets resolve strictly against
 * that step: a step without an output yields no response rather than falling
 * back to another step's answer.
 */
export interface Trajectory {
  source: "driven" | "trace";
  steps: TrajectoryStep[];
  currentStepIndex?: number;
  finalResponse?: {
    text?: string;
    raw?: unknown;
  };
  metrics: Record<string, number>;
  metadata: Record<string, unknown>;
  /**
   * Backward-compatible producer snapshot for existing `result.*` assertions.
   * New evaluators should prefer explicit trajectory fields.
   */
  snapshot?: ScenarioResult;
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
  metadata?: Record<string, unknown>;
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
