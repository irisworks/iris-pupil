import { setTimeout as delay } from "node:timers/promises";
import { PupilError, type SeedStrategy } from "../core/types.js";

export interface Driver {
  readonly type: string;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RestRequestTemplate {
  method?: HttpMethod | string;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
  extract?: Record<string, string>;
}

export interface SeedHistoryEntry {
  role: "user" | "assistant";
  content: string;
}

export interface RestDriverConfig {
  baseUrl: string;
  headers?: Record<string, string>;
  bearerToken?: string;
  timeoutMs?: number;
  retries?: number;
  retryStatusCodes?: number[];
  createConversation: RestRequestTemplate;
  send: RestRequestTemplate;
  close?: RestRequestTemplate;
  fork?: RestRequestTemplate;
  inject?: RestRequestTemplate;
}

export interface RestConversation {
  id: string;
  raw: unknown;
}

export interface RestDriverResponse {
  text: string;
  raw: unknown;
}

type TemplateValue = string | number | boolean | null | undefined | readonly SeedHistoryEntry[];
type TemplateContext = Record<string, TemplateValue>;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

function templateValue(value: TemplateValue): string {
  if (value === undefined || value === null) return "";
  return String(value);
}

export function renderTemplate(input: string, context: TemplateContext): string {
  return input.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_match, key: string) => {
    return templateValue(context[key]);
  });
}

export function renderTemplateValue(value: unknown, context: TemplateContext): unknown {
  if (typeof value === "string") {
    const exactMatch = /^\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}$/.exec(value);
    if (exactMatch) return context[exactMatch[1]] ?? "";
    return renderTemplate(value, context);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => renderTemplateValue(entry, context));
  }

  if (value && typeof value === "object") {
    const rendered: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      rendered[key] = renderTemplateValue(entry, context);
    }
    return rendered;
  }

  return value;
}

function parseJsonPath(path: string): Array<string | number> {
  if (!path.startsWith("$")) {
    throw new PupilError(`JSONPath must start with $: ${path}`);
  }

  const tokens: Array<string | number> = [];
  const pattern = /\.([A-Za-z_$][\w$-]*)|\[(\d+)\]|\[['"]([^'"]+)['"]\]/g;
  let cursor = 1;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(path)) !== null) {
    if (match.index !== cursor) {
      throw new PupilError(`Unsupported JSONPath syntax: ${path}`);
    }
    cursor = pattern.lastIndex;

    if (match[1] !== undefined) tokens.push(match[1]);
    if (match[2] !== undefined) tokens.push(Number(match[2]));
    if (match[3] !== undefined) tokens.push(match[3]);
  }

  if (cursor !== path.length) {
    throw new PupilError(`Unsupported JSONPath syntax: ${path}`);
  }

  return tokens;
}

export function extractJsonPath(source: unknown, path: string): unknown {
  let current = source;
  for (const token of parseJsonPath(path)) {
    if (current === null || current === undefined) return undefined;
    if (typeof token === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[token];
      continue;
    }
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

function joinUrl(baseUrl: string, path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizeBaseUrl(baseUrl)}${normalizedPath}`;
}

function asString(value: unknown, field: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new PupilError(`REST driver could not extract ${field}`);
}

export class RestDriver implements Driver {
  readonly type = "rest";
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryStatusCodes: Set<number>;
  private readonly abortControllers = new Set<AbortController>();

  constructor(private readonly config: RestDriverConfig) {
    if (!config.baseUrl) {
      throw new PupilError("REST driver requires baseUrl");
    }
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = config.retries ?? 0;
    this.retryStatusCodes = new Set(config.retryStatusCodes ?? [...DEFAULT_RETRY_STATUS_CODES]);
  }

  async createConversation(context: TemplateContext = {}): Promise<RestConversation> {
    const raw = await this.executeTemplate(this.config.createConversation, context);
    const idPath = this.config.createConversation.extract?.conversationId ?? "$.sessionId";
    return { id: asString(extractJsonPath(raw, idPath), "conversationId"), raw };
  }

  async send(conversation: RestConversation, message: string): Promise<RestDriverResponse> {
    const raw = await this.executeTemplate(this.config.send, {
      conversationId: conversation.id,
      sessionId: conversation.id,
      message,
      text: message,
    });
    const replyPath = this.config.send.extract?.reply ?? "$.text";
    return { text: asString(extractJsonPath(raw, replyPath), "reply"), raw };
  }

  async closeConversation(conversation: RestConversation): Promise<void> {
    if (!this.config.close) return;
    await this.executeTemplate(this.config.close, {
      conversationId: conversation.id,
      sessionId: conversation.id,
    });
  }

  supportsSeedStrategy(strategy: SeedStrategy): boolean {
    if (strategy === "replay") return true;
    if (strategy === "fork") return this.config.fork !== undefined;
    return this.config.inject !== undefined;
  }

  async fork(conversation: RestConversation): Promise<RestConversation> {
    if (!this.config.fork) {
      throw new PupilError("REST driver has no 'fork' template configured");
    }
    const raw = await this.executeTemplate(this.config.fork, {
      conversationId: conversation.id,
      sessionId: conversation.id,
    });
    const idPath = this.config.fork.extract?.conversationId ?? "$.sessionId";
    return { id: asString(extractJsonPath(raw, idPath), "conversationId"), raw };
  }

  async inject(
    history: readonly SeedHistoryEntry[],
    context: TemplateContext = {},
  ): Promise<RestConversation> {
    if (!this.config.inject) {
      throw new PupilError("REST driver has no 'inject' template configured");
    }
    const raw = await this.executeTemplate(this.config.inject, { ...context, history });
    const idPath = this.config.inject.extract?.conversationId ?? "$.sessionId";
    return { id: asString(extractJsonPath(raw, idPath), "conversationId"), raw };
  }

  dispose(): void {
    for (const controller of this.abortControllers) {
      controller.abort();
    }
    this.abortControllers.clear();
  }

  private async executeTemplate(
    template: RestRequestTemplate,
    context: TemplateContext,
  ): Promise<unknown> {
    const method = renderTemplate(template.method ?? "POST", context).toUpperCase();
    const path = renderTemplate(template.path, context);
    const headers = this.renderHeaders(template.headers, context);
    const body =
      template.body === undefined ? undefined : renderTemplateValue(template.body, context);

    return this.requestWithRetries({ method, path, headers, body });
  }

  private renderHeaders(
    requestHeaders: Record<string, string> | undefined,
    context: TemplateContext,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      ...(this.config.headers ?? {}),
      ...(requestHeaders ?? {}),
    };

    if (this.config.bearerToken !== undefined) {
      headers.authorization = `Bearer ${renderTemplate(this.config.bearerToken, context)}`;
    }

    const rendered: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      rendered[key] = renderTemplate(value, context);
    }
    return rendered;
  }

  private async requestWithRetries(request: {
    method: string;
    path: string;
    headers: Record<string, string>;
    body: unknown;
  }): Promise<unknown> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try {
        return await this.request(request);
      } catch (error) {
        lastError = error;
        if (attempt >= this.retries || !this.isRetryable(error)) break;
        await delay(Math.min(25 * 2 ** attempt, 250));
      }
    }

    throw lastError;
  }

  private isRetryable(error: unknown): boolean {
    return error instanceof RestDriverError && this.retryStatusCodes.has(error.status);
  }

  private async request(request: {
    method: string;
    path: string;
    headers: Record<string, string>;
    body: unknown;
  }): Promise<unknown> {
    const controller = new AbortController();
    this.abortControllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers = new Headers(request.headers);
      const hasBody = request.body !== undefined && request.method !== "GET";
      if (hasBody && !headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }

      const response = await fetch(joinUrl(this.config.baseUrl, request.path), {
        method: request.method,
        headers,
        body: hasBody ? JSON.stringify(request.body) : undefined,
        signal: controller.signal,
      });

      const rawText = await response.text();
      const parsed = rawText ? JSON.parse(rawText) : {};
      if (!response.ok) {
        throw new RestDriverError(response.status, parsed);
      }
      return parsed;
    } catch (error) {
      if (error instanceof RestDriverError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new PupilError(`REST request timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      this.abortControllers.delete(controller);
    }
  }
}

export class RestDriverError extends PupilError {
  constructor(
    readonly status: number,
    readonly response: unknown,
  ) {
    super(`REST request failed with status ${status}`);
  }
}
export * from "./presets.js";
