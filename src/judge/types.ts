import type { JudgeRubric, Verdict } from "../core/types.js";

export type { JudgeRubric };

/** Input to a `JudgeProvider`: the scenario's judge prompt/rubric plus the agent's actual output. */
export interface JudgeRequest {
  prompt: string;
  rubric: JudgeRubric;
  output: string;
  /** Already the CLI/scenario-merged model, if any — a provider falls back to its own config default. */
  model?: string;
}

export interface JudgeResult {
  verdict: Verdict;
  reason: string;
  raw?: unknown;
}

/** A pluggable "ask an LLM (or anything else) whether this output is good" mechanism. */
export interface JudgeProvider {
  judge(request: JudgeRequest): Promise<JudgeResult>;
}
