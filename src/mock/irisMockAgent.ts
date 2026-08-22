import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { MockTraceSource } from "./mockTraceSource.js";
import type { ToolCall } from "../core/types.js";
import type { TraceSource } from "../trace/index.js";

export interface IrisMockRule {
  match: string | RegExp;
  reply: string;
  delayMs?: number;
  status?: number;
}

/** A tool call the mock agent should record, beyond just its name. */
export interface ToolCallFixture {
  name: string;
  args?: unknown;
  error?: string;
}

export interface MockTraceRule {
  match: string | RegExp;
  /** Plain strings are shorthand for `{ name }`. */
  toolCalls: Array<string | ToolCallFixture>;
}

export interface IrisMockOptions {
  port?: number;
  host?: string;
  defaultDelayMs?: number;
  rules?: IrisMockRule[];
  apiToken?: string | false;
  traceRules?: MockTraceRule[];
  defaultToolCalls?: Array<string | ToolCallFixture>;
}

export interface RecordedMockRequest {
  method: string;
  path: string;
  body: unknown;
  receivedAt: string;
}

interface MockSession {
  sessionId: string;
  originChannel: string;
  originThreadTs: string;
  createdAt: string;
  history: Array<{ role: "user" | "assistant"; content: string; at: string }>;
}

export interface IrisMockAgent {
  server: Server;
  requests: RecordedMockRequest[];
  sessions: Map<string, MockSession>;
  listen(): Promise<{ port: number; host: string }>;
  close(): Promise<void>;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return;

  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("error", reject);
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
  });
}

function getStringField(body: unknown, field: string): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function extractSeedHistory(
  body: unknown,
): Array<{ role: "user" | "assistant"; content: string; at: string }> {
  if (!body || typeof body !== "object") return [];
  const history = (body as Record<string, unknown>).history;
  if (!Array.isArray(history)) return [];

  return history
    .filter(
      (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object",
    )
    .map((entry) => ({
      role: entry.role === "assistant" ? "assistant" : "user",
      content: typeof entry.content === "string" ? entry.content : "",
      at: new Date().toISOString(),
    }));
}

function getDelayFromText(text: string, fallback: number): number {
  const match = /__delay:(\d+)__/i.exec(text);
  return match ? Number(match[1]) : fallback;
}

function findRule(text: string, rules: IrisMockRule[]): IrisMockRule | undefined {
  return rules.find((rule) => {
    if (typeof rule.match === "string") return text.includes(rule.match);
    return rule.match.test(text);
  });
}

function findTraceRule(text: string, rules: MockTraceRule[]): MockTraceRule | undefined {
  return rules.find((rule) => {
    if (typeof rule.match === "string") return text.includes(rule.match);
    return rule.match.test(text);
  });
}

function toToolCall(fixture: string | ToolCallFixture, index: number): ToolCall {
  if (typeof fixture === "string") return { name: fixture, index };
  return {
    name: fixture.name,
    index,
    ...(fixture.args !== undefined && { args: fixture.args }),
    ...(fixture.error !== undefined && { error: fixture.error }),
  };
}

export function createIrisMockAgent(
  options: IrisMockOptions = {},
  spanStore: Map<string, ToolCall[]> = new Map(),
): IrisMockAgent {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 5050;
  const defaultDelayMs = options.defaultDelayMs ?? 0;
  const rules = options.rules ?? [];
  const traceRules = options.traceRules ?? [];
  const defaultToolCalls = options.defaultToolCalls;
  const apiToken =
    options.apiToken === false ? undefined : (options.apiToken ?? process.env.IRIS_API_TOKEN);
  const requests: RecordedMockRequest[] = [];
  const sessions = new Map<string, MockSession>();
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  function schedule(callback: () => void, delayMs: number): void {
    const timer = setTimeout(() => {
      pendingTimers.delete(timer);
      callback();
    }, delayMs);
    pendingTimers.add(timer);
  }

  function requireAuth(req: IncomingMessage, res: ServerResponse): boolean {
    if (!apiToken) return true;
    if (req.headers.authorization === `Bearer ${apiToken}`) return true;
    json(res, 401, { error: "unauthorized" });
    return false;
  }

  const server = createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const path = req.url ?? "/";

    try {
      if (method === "GET" && path === "/health") {
        json(res, 200, { ok: true, channels: sessions.size });
        return;
      }

      if (method === "GET" && path === "/requests") {
        json(res, 200, { requests });
        return;
      }

      if (method === "DELETE" && path === "/requests") {
        requests.length = 0;
        json(res, 200, { ok: true });
        return;
      }

      const historyMatch = /^\/sessions\/([^/]+)\/history$/.exec(path);
      if (method === "GET" && historyMatch) {
        if (!requireAuth(req, res)) return;
        const session = sessions.get(decodeURIComponent(historyMatch[1]));
        if (!session) {
          json(res, 404, { error: "session not found" });
          return;
        }
        json(res, 200, { sessionId: session.sessionId, history: session.history });
        return;
      }

      if (!requireAuth(req, res)) return;

      const body = await readBody(req);
      requests.push({ method, path, body, receivedAt: new Date().toISOString() });

      if (method === "POST" && path === "/sessions") {
        const originChannel = getStringField(body, "originChannel");
        const originThreadTs = getStringField(body, "originThreadTs");
        if (!originChannel || !originThreadTs) {
          json(res, 400, { error: "originChannel and originThreadTs are required" });
          return;
        }

        const sessionId = randomUUID();
        const seededHistory = extractSeedHistory(body);
        const session = {
          sessionId,
          originChannel,
          originThreadTs,
          createdAt: new Date().toISOString(),
          history: seededHistory,
        };
        sessions.set(sessionId, session);
        spanStore.set(sessionId, []);
        json(res, 201, session);
        return;
      }

      const forkMatch = /^\/sessions\/([^/]+)\/fork$/.exec(path);
      if (method === "POST" && forkMatch) {
        const source = sessions.get(decodeURIComponent(forkMatch[1]));
        if (!source) {
          json(res, 404, { error: "session not found" });
          return;
        }

        const sessionId = randomUUID();
        const forked = {
          sessionId,
          originChannel: source.originChannel,
          originThreadTs: source.originThreadTs,
          createdAt: new Date().toISOString(),
          history: [...source.history],
        };
        sessions.set(sessionId, forked);
        spanStore.set(sessionId, []);
        json(res, 201, forked);
        return;
      }

      const messageMatch = /^\/sessions\/([^/]+)\/message$/.exec(path);
      if (method === "POST" && messageMatch) {
        const session = sessions.get(decodeURIComponent(messageMatch[1]));
        if (!session) {
          json(res, 404, { error: "session not found" });
          return;
        }

        const text = getStringField(body, "text");
        if (!text) {
          json(res, 400, { error: "text is required" });
          return;
        }
        if (text.includes("__hang__")) {
          return;
        }

        // Trace pass — runs unconditionally, independent of HTTP status (500, 504, 200).
        // Uses !== null so an explicit toolCalls: [] trace rule appends nothing — configuring
        // a matched rule with an empty toolCalls signals the agent ran but called no tools.
        const traceRule = findTraceRule(text, traceRules);
        const spansToAppend =
          traceRule !== undefined ? traceRule.toolCalls : (defaultToolCalls ?? null);
        if (spansToAppend !== null) {
          const sessionIdDecoded = decodeURIComponent(messageMatch[1]);
          const existing = spanStore.get(sessionIdDecoded) ?? [];
          spanStore.set(sessionIdDecoded, [
            ...existing,
            ...spansToAppend.map((fixture, offset) =>
              toToolCall(fixture, existing.length + offset),
            ),
          ]);
        }

        const delayMs = getDelayFromText(text, defaultDelayMs);
        const rule = findRule(text, rules);
        const status =
          rule?.status ?? (text.includes("__500__") ? 500 : text.includes("__504__") ? 504 : 200);
        const reply = rule?.reply ?? `Mock Iris received: ${text}`;

        schedule(() => {
          if (res.destroyed || res.writableEnded) return;

          if (status >= 500) {
            json(res, status, { error: `mock ${status}` });
            return;
          }

          session.history.push({ role: "user", content: text, at: new Date().toISOString() });
          session.history.push({ role: "assistant", content: reply, at: new Date().toISOString() });
          json(res, 200, { text: reply, message: reply, sessionId: session.sessionId });
        }, rule?.delayMs ?? delayMs);
        return;
      }

      const resetMatch = /^\/sessions\/([^/]+)\/reset$/.exec(path);
      if (method === "POST" && resetMatch) {
        const session = sessions.get(decodeURIComponent(resetMatch[1]));
        if (!session) {
          json(res, 404, { error: "session not found" });
          return;
        }
        session.history = [];
        json(res, 200, { status: "ok", message: "Context cleared" });
        return;
      }

      json(res, 404, { error: "not found" });
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  return {
    server,
    requests,
    sessions,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          const address = server.address();
          const effectivePort = typeof address === "object" && address ? address.port : port;
          resolve({ host, port: effectivePort });
        });
      });
    },
    close() {
      for (const timer of pendingTimers) {
        clearTimeout(timer);
      }
      pendingTimers.clear();
      server.closeAllConnections();
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

export interface MockAgentBundle {
  agent: IrisMockAgent;
  traceSource: TraceSource;
}

export function createMockAgentBundle(options?: IrisMockOptions): MockAgentBundle {
  const spanStore = new Map<string, ToolCall[]>();
  return {
    agent: createIrisMockAgent(options, spanStore),
    traceSource: new MockTraceSource(spanStore),
  };
}
