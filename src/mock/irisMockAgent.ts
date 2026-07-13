import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

export interface IrisMockRule {
  match: string | RegExp;
  reply: string;
  delayMs?: number;
  status?: number;
}

export interface IrisMockOptions {
  port?: number;
  host?: string;
  defaultDelayMs?: number;
  rules?: IrisMockRule[];
}

export interface RecordedMockRequest {
  method: string;
  path: string;
  body: unknown;
  receivedAt: string;
}

interface MockSession {
  sessionId: string;
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

function messageFromBody(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const record = body as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (typeof record.message === "string") return record.message;
  if (Array.isArray(record.messages)) {
    const last = record.messages
      .slice()
      .reverse()
      .find((message) => {
        return (
          message &&
          typeof message === "object" &&
          "content" in message &&
          typeof (message as { content?: unknown }).content === "string"
        );
      }) as { content?: string } | undefined;
    return last?.content ?? "";
  }
  return "";
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

export function createIrisMockAgent(options: IrisMockOptions = {}): IrisMockAgent {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 5050;
  const defaultDelayMs = options.defaultDelayMs ?? 0;
  const rules = options.rules ?? [];
  const requests: RecordedMockRequest[] = [];
  const sessions = new Map<string, MockSession>();

  const server = createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const path = req.url ?? "/";

    try {
      if (method === "GET" && path === "/health") {
        json(res, 200, { ok: true, service: "iris-mock" });
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

      const body = await readBody(req);
      requests.push({ method, path, body, receivedAt: new Date().toISOString() });

      if (method === "POST" && path === "/sessions") {
        const sessionId = randomUUID();
        const session = { sessionId, createdAt: new Date().toISOString(), history: [] };
        sessions.set(sessionId, session);
        json(res, 201, session);
        return;
      }

      const messageMatch = /^\/sessions\/([^/]+)\/message$/.exec(path);
      if (method === "POST" && messageMatch) {
        const session = sessions.get(decodeURIComponent(messageMatch[1]));
        if (!session) {
          json(res, 404, { error: "session not found" });
          return;
        }

        const text = messageFromBody(body);
        if (text.includes("__hang__")) {
          return;
        }

        const delayMs = getDelayFromText(text, defaultDelayMs);
        const rule = findRule(text, rules);
        const status =
          rule?.status ?? (text.includes("__500__") ? 500 : text.includes("__504__") ? 504 : 200);
        const reply = rule?.reply ?? `Mock Iris received: ${text}`;

        setTimeout(() => {
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
        json(res, 200, { ok: true, sessionId: session.sessionId });
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
      server.closeAllConnections();
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
