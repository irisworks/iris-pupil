import type { JudgeProviderConfig } from "./config.js";
import type { JudgeProvider, JudgeRequest, JudgeResult } from "./types.js";

const TOOL_NAME = "select_choice";

/** Applied whenever `config.timeoutMs` is unset, matching LangfuseTraceSource's default. */
const DEFAULT_JUDGE_TIMEOUT_MS = 3000;

export class JudgeInvocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JudgeInvocationError";
  }
}

export type LlmJudgeFetch = (input: string, init: RequestInit) => Promise<Response>;

function buildJudgeTool(choices: string[]) {
  return {
    type: "function" as const,
    function: {
      name: TOOL_NAME,
      description: "Call this function to select a choice.",
      parameters: {
        type: "object",
        title: "JudgeChoice",
        properties: {
          reasoning: {
            type: "string",
            title: "Reasoning",
            description:
              "Write out in a step by step manner your reasoning to be sure that your conclusion is correct. Avoid simply stating the correct answer at the outset.",
          },
          choice: {
            type: "string",
            title: "Choice",
            description: "The choice",
            enum: choices,
          },
        },
        required: ["reasoning", "choice"],
      },
    },
  };
}

export class LlmJudge implements JudgeProvider {
  constructor(
    private readonly config: JudgeProviderConfig,
    private readonly fetchImpl: LlmJudgeFetch = fetch,
  ) {}

  async judge(request: JudgeRequest): Promise<JudgeResult> {
    const model = request.model ?? this.config.model;
    const body = {
      model,
      messages: [
        {
          role: "system",
          content:
            "You are grading an AI agent's response against a rubric. Call the select_choice tool with your answer - never respond with plain text.",
        },
        {
          role: "user",
          content: `${request.prompt}\n\n[Agent response]\n${request.output}`,
        },
      ],
      tools: [buildJudgeTool(request.rubric.choices)],
      tool_choice: { type: "function", function: { name: TOOL_NAME } },
    };

    const controller = new AbortController();
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // `fetchImpl` is contractually expected to resolve a real `Response` (or reject); a
    // misbehaving injected implementation that resolves something else is a caller bug,
    // not something this method guards against.
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.config.apiKey !== undefined && {
            authorization: `Bearer ${this.config.apiKey}`,
          }),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      throw new JudgeInvocationError(
        `Judge endpoint request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new JudgeInvocationError(`Judge endpoint returned ${response.status}`);
    }

    let payload: unknown;
    try {
      payload = (await response.json()) as unknown;
    } catch (error) {
      throw new JudgeInvocationError(
        `Judge endpoint response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const toolCall = extractToolCall(payload);
    if (!toolCall) {
      throw new JudgeInvocationError("Judge response contained no select_choice tool call");
    }

    const rawArgs = toolCall.function?.arguments;
    if (typeof rawArgs !== "string") {
      throw new JudgeInvocationError("Judge tool call arguments were not a string");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawArgs) as unknown;
    } catch {
      throw new JudgeInvocationError("Judge tool call arguments were not valid JSON");
    }

    if (!parsed || typeof parsed !== "object") {
      throw new JudgeInvocationError("Judge tool call arguments were not an object");
    }
    const args = parsed as { reasoning?: unknown; choice?: unknown };

    if (typeof args.choice !== "string") {
      throw new JudgeInvocationError("Judge selected a non-string choice");
    }

    const choice = args.choice.trim();
    if (!Object.hasOwn(request.rubric.choiceScores, choice)) {
      throw new JudgeInvocationError(`Judge selected an unrecognized choice: ${choice}`);
    }
    const verdict = request.rubric.choiceScores[choice];

    return {
      verdict,
      reason: typeof args.reasoning === "string" ? args.reasoning : choice,
      raw: payload,
    };
  }
}

interface RawToolCall {
  function?: { name?: string; arguments?: string };
}

function extractToolCall(payload: unknown): RawToolCall | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const message = (choices[0] as { message?: unknown })?.message;
  if (!message || typeof message !== "object") return undefined;
  const toolCalls = (message as { tool_calls?: unknown }).tool_calls;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return undefined;
  const rawToolCall = toolCalls[0];
  if (!rawToolCall || typeof rawToolCall !== "object") return undefined;
  const toolCall = rawToolCall as RawToolCall;
  if (toolCall.function?.name !== TOOL_NAME) return undefined;
  return toolCall;
}
