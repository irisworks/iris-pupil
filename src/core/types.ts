export type Verdict = "pass" | "fail" | "needs_review" | "error";

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

export interface AssertionCheck {
  type: "contains" | "not_contains" | "equals" | "regex";
  target: string;
  value: string;
  caseSensitive: boolean;
}

export interface ThresholdCheck {
  metric: string;
  max?: number;
  min?: number;
}

export interface ManualScoringConfig {
  required: boolean;
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
