import { describe, expect, it } from "vitest";
import { judgeConfigFromEnv, resolveJudgeConfig } from "./config.js";

describe("Judge provider config resolution", () => {
  it("returns undefined when nothing is configured", () => {
    expect(judgeConfigFromEnv({})).toBeUndefined();
  });

  it("accepts JUDGE_BASE_URL and trims a trailing slash", () => {
    expect(judgeConfigFromEnv({ JUDGE_BASE_URL: "http://litellm.local/" })).toEqual({
      baseUrl: "http://litellm.local",
    });
  });

  it("reads apiKey, model, and timeoutMs from the environment", () => {
    expect(
      judgeConfigFromEnv({
        JUDGE_BASE_URL: "http://litellm.local",
        JUDGE_API_KEY: "key-env",
        JUDGE_MODEL: "gpt-4o-mini",
        JUDGE_TIMEOUT_MS: "5000",
      }),
    ).toEqual({
      baseUrl: "http://litellm.local",
      apiKey: "key-env",
      model: "gpt-4o-mini",
      timeoutMs: 5000,
    });
  });

  it("falls back to LITELLM_API_KEY when JUDGE_API_KEY is unset", () => {
    expect(
      judgeConfigFromEnv({
        JUDGE_BASE_URL: "http://litellm.local",
        LITELLM_API_KEY: "key-litellm",
      })?.apiKey,
    ).toBe("key-litellm");
  });

  it("prefers JUDGE_API_KEY over LITELLM_API_KEY when both are set", () => {
    expect(
      judgeConfigFromEnv({
        JUDGE_BASE_URL: "http://litellm.local",
        JUDGE_API_KEY: "key-judge",
        LITELLM_API_KEY: "key-litellm",
      })?.apiKey,
    ).toBe("key-judge");
  });

  it("lets settings override env while env supplies missing fields", () => {
    expect(
      resolveJudgeConfig({
        settings: { baseUrl: "http://configured.local", model: "gpt-4o" },
        env: {
          JUDGE_BASE_URL: "http://env.local",
          JUDGE_API_KEY: "key-env",
          JUDGE_TIMEOUT_MS: "9000",
        },
      }),
    ).toEqual({
      baseUrl: "http://configured.local",
      apiKey: "key-env",
      model: "gpt-4o",
      timeoutMs: 9000,
    });
  });

  it("returns undefined when settings and env both omit baseUrl", () => {
    expect(resolveJudgeConfig({ settings: { apiKey: "key-only" }, env: {} })).toBeUndefined();
  });
});
