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

export interface TargetIdentity {
  system?: string;
  environment?: string;
  version?: string;
  mode: "driven" | "observed";
  fixtureSet?: string;
}

/**
 * One observed tool invocation, in call order.
 *
 * Shaped near OpenTelemetry GenAI concepts (name, input, timing, error) without
 * binding Pupil to experimental semantic-convention field names — the same
 * reasoning applied to TrajectoryStep.
 */
export interface ToolCall {
  /** Tool identifier as reported by the agent, e.g. "calendar.create". */
  name: string;
  /** 0-based position in call order across the whole trajectory. */
  index: number;
  /** Parsed argument payload, when the backend provides one. */
  args?: unknown;
  /** ISO-8601 start time, when the backend provides one. */
  startedAt?: string;
  /** Set when the tool itself reported a failure. */
  error?: string;
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

/** How a tool name in an assertion is compared against an observed call. */
export type ToolNameMatch = "exact" | "glob";

export type SeedStrategy = "replay" | "fork" | "inject";

export interface SeedTurn {
  user: string;
}

export interface ScenarioSeed {
  strategy: SeedStrategy;
  turns: SeedTurn[];
}

export interface ToolCalledAssertionCheck {
  type: "tool_called";
  tool: string;
  match?: ToolNameMatch;
  /** Exact call count. Omitted means "at least once". */
  times?: number;
}

export interface ToolNotCalledAssertionCheck {
  type: "tool_not_called";
  tool: string;
  match?: ToolNameMatch;
}

export interface ToolCallCountAssertionCheck {
  type: "tool_call_count";
  /** Omitted counts every tool call in the trajectory. */
  tool?: string;
  match?: ToolNameMatch;
  min?: number;
  max?: number;
}

export interface ToolOrderAssertionCheck {
  type: "tool_order";
  /** Matched as a subsequence: unrelated calls may appear in between. */
  tools: string[];
  match?: ToolNameMatch;
}

export interface ToolArgsAssertionCheck {
  type: "tool_args";
  tool: string;
  match?: ToolNameMatch;
  /** Subset match: listed keys must match, extra keys are ignored. */
  equals: Record<string, unknown>;
}

export type ToolAssertionCheck =
  | ToolCalledAssertionCheck
  | ToolNotCalledAssertionCheck
  | ToolCallCountAssertionCheck
  | ToolOrderAssertionCheck
  | ToolArgsAssertionCheck;

/** Assertion Pupil can evaluate against an agent response or trajectory. */
export type AssertionCheck = TextAssertionCheck | JsonPathAssertionCheck | ToolAssertionCheck;

export interface ThresholdCheck {
  metric: string;
  max?: number;
  min?: number;
}

/** A reusable assertion or threshold evaluated across one or more trajectories. */
export type InvariantCheck =
  | {
      assertion: AssertionCheck;
      threshold?: never;
      maxViolationRate?: number;
    }
  | {
      assertion?: never;
      threshold: ThresholdCheck;
      maxViolationRate?: number;
    };

export type InvariantSource = "repo" | "scenario";

/** An invariant paired with the policy layer that contributed it. */
export interface LoadedInvariant {
  check: InvariantCheck;
  source: InvariantSource;
}

export interface ManualScoringConfig {
  required: boolean;
  criteria: string[];
  prompt?: string;
  rubric?: string[];
}

/** Forced-tool-call choice set: every entry in `choices` must have a matching `choiceScores` entry. */
export interface JudgeRubric {
  choices: string[];
  choiceScores: Record<string, Verdict>;
}

export interface JudgeConfig {
  enabled: boolean;
  prompt?: string;
  rubric?: JudgeRubric;
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
  seed?: ScenarioSeed;
  turns: ScenarioTurn[];
  expect: ScenarioExpectations;
  invariants: InvariantCheck[];
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
  isSeed?: boolean;
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
   * Observed tool calls in call order, when the producer has evidence.
   *
   * Top-level rather than distributed across `steps` because both producers can
   * populate it: a driven run gets it from trace enrichment, and a trace-derived
   * run (`pupil observe`) may have tool calls but no conversational steps at all.
   * Tool assertions must read this field and never `steps`.
   *
   * `undefined` means no evidence — tool assertions skip. `[]` means the producer
   * had evidence and the agent called no tools — tool assertions score normally.
   */
  toolCalls?: readonly ToolCall[];
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
  target?: TargetIdentity;
}
