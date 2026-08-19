import { deepMerge } from "../core/json.js";
import { PupilError } from "../core/types.js";
import type { RestDriverConfig, RestRequestTemplate } from "./index.js";

type EnvSource = Record<string, string | undefined>;

type RequestTemplateOverrides = Omit<Partial<RestRequestTemplate>, "body"> & {
  body?: unknown;
};

export type RestDriverConfigOverrides = Omit<
  Partial<RestDriverConfig>,
  "createConversation" | "send" | "close"
> & {
  createConversation?: RequestTemplateOverrides;
  send?: RequestTemplateOverrides;
  close?: RequestTemplateOverrides;
};

export interface IrisHttpPresetOptions {
  baseUrl: string;
  env?: EnvSource;
  bearerToken?: string;
  originChannel?: string;
  originThreadTs?: string;
  overrides?: RestDriverConfigOverrides;
}

export const IRIS_HTTP_PRESET = "iris-http";

function envToken(env: EnvSource): string | undefined {
  const token = env.IRIS_API_TOKEN;
  return token && token.length > 0 ? token : undefined;
}

export function createIrisHttpPreset(options: IrisHttpPresetOptions): RestDriverConfig {
  if (!options.baseUrl) {
    throw new PupilError("iris-http preset requires baseUrl");
  }

  const bearerToken = options.bearerToken ?? envToken(options.env ?? process.env);
  const defaults: RestDriverConfig = {
    baseUrl: options.baseUrl,
    ...(bearerToken ? { bearerToken } : {}),
    timeoutMs: 30_000,
    retries: 1,
    createConversation: {
      method: "POST",
      path: "/sessions",
      body: {
        originChannel: options.originChannel ?? "pupil",
        originThreadTs: options.originThreadTs ?? "{{originThreadTs}}",
      },
      extract: { conversationId: "$.sessionId" },
    },
    send: {
      method: "POST",
      path: "/sessions/{{conversationId}}/message",
      body: { text: "{{message}}" },
      extract: { reply: "$.text" },
    },
    close: {
      method: "POST",
      path: "/sessions/{{conversationId}}/reset",
    },
  };

  return deepMerge(defaults, options.overrides ?? {});
}
