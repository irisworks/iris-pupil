import { describe, expect, it, vi } from "vitest";
import { Verdict } from "../core/types.js";
import { JudgeInvocationError, LlmJudge } from "./llmJudge.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function toolCallResponse(args: Record<string, unknown>, name = "select_choice") {
  return jsonResponse({
    choices: [
      {
        message: {
          tool_calls: [
            {
              function: {
                name,
                arguments: JSON.stringify(args),
              },
            },
          ],
        },
      },
    ],
  });
}

const RUBRIC = {
  choices: ["PASS", "FAIL"],
  choiceScores: { PASS: Verdict.Pass, FAIL: Verdict.Fail },
};

describe("LlmJudge", () => {
  it("forces a select_choice tool call with reasoning ordered before choice", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(toolCallResponse({ reasoning: "Looks correct.", choice: "PASS" }));
    const judge = new LlmJudge({ baseUrl: "https://judge.example.com/v1" }, fetchImpl);

    await judge.judge({
      prompt: "Grade this.",
      rubric: RUBRIC,
      output: "def factorial...",
      model: "gpt-4o-mini",
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://judge.example.com/v1/chat/completions");
    const body = JSON.parse(init.body as string);
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "select_choice" } });
    expect(body.tools).toHaveLength(1);
    const properties = body.tools[0].function.parameters.properties;
    expect(Object.keys(properties)).toEqual(["reasoning", "choice"]);
    expect(properties.choice.enum).toEqual(["PASS", "FAIL"]);
  });

  it("maps the returned choice to a Verdict via choiceScores and carries the reasoning through", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(toolCallResponse({ reasoning: "Fails the base case.", choice: "FAIL" }));
    const judge = new LlmJudge({ baseUrl: "https://judge.example.com/v1" }, fetchImpl);

    const result = await judge.judge({
      prompt: "Grade this.",
      rubric: RUBRIC,
      output: "bad code",
      model: "gpt-4o-mini",
    });

    expect(result.verdict).toBe(Verdict.Fail);
    expect(result.reason).toBe("Fails the base case.");
    expect(result.raw).toBeDefined();
  });

  it("throws JudgeInvocationError when the response has no tool call", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: {} }] }));
    const judge = new LlmJudge({ baseUrl: "https://judge.example.com/v1" }, fetchImpl);

    await expect(
      judge.judge({ prompt: "Grade this.", rubric: RUBRIC, output: "code", model: "gpt-4o-mini" }),
    ).rejects.toThrow(JudgeInvocationError);
  });

  it("throws JudgeInvocationError when the tool call is for the wrong tool name", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        toolCallResponse({ reasoning: "Looks correct.", choice: "PASS" }, "pick_one"),
      );
    const judge = new LlmJudge({ baseUrl: "https://judge.example.com/v1" }, fetchImpl);

    await expect(
      judge.judge({ prompt: "Grade this.", rubric: RUBRIC, output: "code", model: "gpt-4o-mini" }),
    ).rejects.toThrow(JudgeInvocationError);
  });

  it("throws JudgeInvocationError when a tool_calls array element is null", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ choices: [{ message: { tool_calls: [null] } }] }));
    const judge = new LlmJudge({ baseUrl: "https://judge.example.com/v1" }, fetchImpl);

    await expect(
      judge.judge({ prompt: "Grade this.", rubric: RUBRIC, output: "code", model: "gpt-4o-mini" }),
    ).rejects.toThrow(JudgeInvocationError);
  });

  it("throws JudgeInvocationError when the model selects a choice absent from choiceScores", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(toolCallResponse({ reasoning: "Uncertain.", choice: "MAYBE" }));
    const judge = new LlmJudge({ baseUrl: "https://judge.example.com/v1" }, fetchImpl);

    await expect(
      judge.judge({ prompt: "Grade this.", rubric: RUBRIC, output: "code", model: "gpt-4o-mini" }),
    ).rejects.toThrow(JudgeInvocationError);
  });

  it("throws JudgeInvocationError when the judge endpoint returns a non-2xx status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: "boom" }, 500));
    const judge = new LlmJudge({ baseUrl: "https://judge.example.com/v1" }, fetchImpl);

    await expect(
      judge.judge({ prompt: "Grade this.", rubric: RUBRIC, output: "code", model: "gpt-4o-mini" }),
    ).rejects.toThrow(JudgeInvocationError);
  });

  it("throws JudgeInvocationError when the underlying fetch call rejects", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    const judge = new LlmJudge({ baseUrl: "https://judge.example.com/v1" }, fetchImpl);

    await expect(
      judge.judge({ prompt: "Grade this.", rubric: RUBRIC, output: "code", model: "gpt-4o-mini" }),
    ).rejects.toThrow(JudgeInvocationError);
  });

  it("throws JudgeInvocationError when the judge endpoint returns a 200 with a non-JSON body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("<html>gateway</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    const judge = new LlmJudge({ baseUrl: "https://judge.example.com/v1" }, fetchImpl);

    await expect(
      judge.judge({ prompt: "Grade this.", rubric: RUBRIC, output: "code", model: "gpt-4o-mini" }),
    ).rejects.toThrow(JudgeInvocationError);
  });

  it("throws JudgeInvocationError when the tool call's arguments parse to null", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [
          {
            message: {
              tool_calls: [{ function: { name: "select_choice", arguments: "null" } }],
            },
          },
        ],
      }),
    );
    const judge = new LlmJudge({ baseUrl: "https://judge.example.com/v1" }, fetchImpl);

    await expect(
      judge.judge({ prompt: "Grade this.", rubric: RUBRIC, output: "code", model: "gpt-4o-mini" }),
    ).rejects.toThrow(JudgeInvocationError);
  });

  it("throws JudgeInvocationError when the tool call's choice is not a string", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(toolCallResponse({ reasoning: "Uncertain.", choice: 1 }));
    const judge = new LlmJudge({ baseUrl: "https://judge.example.com/v1" }, fetchImpl);

    await expect(
      judge.judge({ prompt: "Grade this.", rubric: RUBRIC, output: "code", model: "gpt-4o-mini" }),
    ).rejects.toThrow(JudgeInvocationError);
  });

  it("throws JudgeInvocationError rather than resolving a prototype-chain value for an unowned choice key", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(toolCallResponse({ reasoning: "Uncertain.", choice: "constructor" }));
    const judge = new LlmJudge({ baseUrl: "https://judge.example.com/v1" }, fetchImpl);
    const rubric = { choices: ["PASS"], choiceScores: { PASS: Verdict.Pass } };

    await expect(
      judge.judge({ prompt: "Grade this.", rubric, output: "code", model: "gpt-4o-mini" }),
    ).rejects.toThrow(JudgeInvocationError);
  });

  it("falls back to the choice string when reasoning is not a string", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(toolCallResponse({ reasoning: 123, choice: "PASS" }));
    const judge = new LlmJudge({ baseUrl: "https://judge.example.com/v1" }, fetchImpl);

    const result = await judge.judge({
      prompt: "Grade this.",
      rubric: RUBRIC,
      output: "code",
      model: "gpt-4o-mini",
    });

    expect(result.reason).toBe("PASS");
  });

  it("prefers the request's model over the configured default", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(toolCallResponse({ reasoning: "ok", choice: "PASS" }));
    const judge = new LlmJudge(
      { baseUrl: "https://judge.example.com/v1", model: "config-default" },
      fetchImpl,
    );

    await judge.judge({
      prompt: "Grade this.",
      rubric: RUBRIC,
      output: "code",
      model: "scenario-model",
    });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body as string);
    expect(body.model).toBe("scenario-model");
  });

  it("falls back to the configured default model when the request has none", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(toolCallResponse({ reasoning: "ok", choice: "PASS" }));
    const judge = new LlmJudge(
      { baseUrl: "https://judge.example.com/v1", model: "config-default" },
      fetchImpl,
    );

    await judge.judge({ prompt: "Grade this.", rubric: RUBRIC, output: "code" });

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body as string);
    expect(body.model).toBe("config-default");
  });

  it("sends an Authorization header when apiKey is configured", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(toolCallResponse({ reasoning: "ok", choice: "PASS" }));
    const judge = new LlmJudge(
      { baseUrl: "https://judge.example.com/v1", apiKey: "secret-key" },
      fetchImpl,
    );

    await judge.judge({ prompt: "Grade this.", rubric: RUBRIC, output: "code", model: "m" });

    const headers = fetchImpl.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer secret-key");
  });

  it("omits the Authorization header when no apiKey is configured", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(toolCallResponse({ reasoning: "ok", choice: "PASS" }));
    const judge = new LlmJudge({ baseUrl: "https://judge.example.com/v1" }, fetchImpl);

    await judge.judge({ prompt: "Grade this.", rubric: RUBRIC, output: "code", model: "m" });

    const headers = fetchImpl.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  it("aborts the request once timeoutMs elapses", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn((_url: string, init: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      });
      const judge = new LlmJudge(
        { baseUrl: "https://judge.example.com/v1", timeoutMs: 50 },
        fetchImpl,
      );

      const pending = judge.judge({
        prompt: "Grade this.",
        rubric: RUBRIC,
        output: "code",
        model: "m",
      });
      const assertion = expect(pending).rejects.toThrow(JudgeInvocationError);
      await vi.advanceTimersByTimeAsync(50);
      await assertion;

      const init = fetchImpl.mock.calls[0][1];
      expect(init.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies a default timeout when timeoutMs is not configured", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn((_url: string, init: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      });
      const judge = new LlmJudge({ baseUrl: "https://judge.example.com/v1" }, fetchImpl);

      const pending = judge.judge({
        prompt: "Grade this.",
        rubric: RUBRIC,
        output: "code",
        model: "m",
      });
      const assertion = expect(pending).rejects.toThrow(JudgeInvocationError);

      const initBeforeAbort = fetchImpl.mock.calls[0][1];
      expect(initBeforeAbort.signal).toBeDefined();
      expect(initBeforeAbort.signal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(3000);
      await assertion;

      expect(initBeforeAbort.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
