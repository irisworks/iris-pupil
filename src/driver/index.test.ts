import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createIrisMockAgent, type IrisMockAgent } from "../mock/irisMockAgent.js";
import { extractJsonPath, renderTemplateValue, RestDriver } from "./index.js";

let mock: IrisMockAgent | undefined;
let server: Server | undefined;

afterEach(async () => {
  if (mock) {
    await mock.close();
    mock = undefined;
  }
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server?.close((error) => (error ? reject(error) : resolve()));
    });
    server = undefined;
  }
});

function irisDriver(
  baseUrl: string,
  options: Partial<ConstructorParameters<typeof RestDriver>[0]> = {},
) {
  return new RestDriver({
    baseUrl,
    timeoutMs: 500,
    retries: 0,
    createConversation: {
      method: "POST",
      path: "/sessions",
      body: {
        originChannel: "pupil",
        originThreadTs: "{{threadTs}}",
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
    ...options,
  });
}

async function listen(serverToStart: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    serverToStart.once("error", reject);
    serverToStart.listen(0, "127.0.0.1", () => {
      serverToStart.off("error", reject);
      const address = serverToStart.address();
      if (!address || typeof address !== "object") {
        reject(new Error("server did not expose a port"));
        return;
      }
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

describe("REST template helpers", () => {
  it("renders nested request templates without stringifying exact placeholders", () => {
    expect(
      renderTemplateValue(
        {
          text: "{{message}}",
          path: "/sessions/{{conversationId}}/message",
          nested: ["hello {{name}}", "{{count}}"],
        },
        { message: "book", conversationId: "s1", name: "Esha", count: 2 },
      ),
    ).toEqual({
      text: "book",
      path: "/sessions/s1/message",
      nested: ["hello Esha", 2],
    });
  });

  it("extracts dot, array, and bracket JSONPath fields", () => {
    const source = { response: { messages: [{ text: "hello" }], "reply-text": "done" } };

    expect(extractJsonPath(source, "$.response.messages[0].text")).toBe("hello");
    expect(extractJsonPath(source, "$.response['reply-text']")).toBe("done");
    expect(extractJsonPath(source, "$.missing.value")).toBeUndefined();
  });

  it("rejects unsupported JSONPath syntax", () => {
    expect(() => extractJsonPath({}, "response.text")).toThrow(/must start with/);
    expect(() => extractJsonPath({}, "$.items[*]")).toThrow(/Unsupported JSONPath syntax/);
  });
});

describe("RestDriver", () => {
  it("runs a full conversation lifecycle against the IRIS mock agent", async () => {
    mock = createIrisMockAgent({
      port: 0,
      rules: [{ match: "book", reply: "Booked." }],
    });
    const address = await mock.listen();
    const driver = irisDriver(`http://${address.host}:${address.port}`);

    const conversation = await driver.createConversation({ threadTs: "thread-1" });
    const response = await driver.send(conversation, "please book");
    await driver.closeConversation(conversation);

    expect(conversation.id).toMatch(/[0-9a-f-]{36}/);
    expect(response.text).toBe("Booked.");
    expect(mock.sessions.get(conversation.id)?.history).toEqual([]);
    expect(mock.requests.map((request) => request.path)).toEqual([
      "/sessions",
      `/sessions/${conversation.id}/message`,
      `/sessions/${conversation.id}/reset`,
    ]);
  });

  it("sends bearer auth headers", async () => {
    mock = createIrisMockAgent({ port: 0, apiToken: "secret" });
    const address = await mock.listen();
    const driver = irisDriver(`http://${address.host}:${address.port}`, { bearerToken: "secret" });

    const conversation = await driver.createConversation({ threadTs: "thread-1" });

    expect(conversation.id).toMatch(/[0-9a-f-]{36}/);
  });

  it("retries configured retryable status codes", async () => {
    let attempts = 0;
    server = createServer((req, res) => {
      attempts += 1;
      if (attempts === 1) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "try again" }));
        return;
      }
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ sessionId: "retry-session" }));
    });
    const baseUrl = await listen(server);
    const driver = irisDriver(baseUrl, { retries: 1 });

    const conversation = await driver.createConversation({ threadTs: "thread-1" });

    expect(conversation.id).toBe("retry-session");
    expect(attempts).toBe(2);
  });

  it("surfaces non-retryable HTTP errors", async () => {
    mock = createIrisMockAgent({ port: 0 });
    const address = await mock.listen();
    const driver = irisDriver(`http://${address.host}:${address.port}`, {
      createConversation: {
        method: "POST",
        path: "/sessions",
        body: {},
        extract: { conversationId: "$.sessionId" },
      },
    });

    await expect(driver.createConversation()).rejects.toMatchObject({ status: 400 });
  });

  it("times out hanging requests", async () => {
    mock = createIrisMockAgent({ port: 0 });
    const address = await mock.listen();
    const driver = irisDriver(`http://${address.host}:${address.port}`, { timeoutMs: 50 });
    const conversation = await driver.createConversation({ threadTs: "thread-1" });

    await expect(driver.send(conversation, "__hang__")).rejects.toThrow(/timed out/);
  });

  it("aborts in-flight requests during disposal", async () => {
    mock = createIrisMockAgent({ port: 0 });
    const address = await mock.listen();
    const driver = irisDriver(`http://${address.host}:${address.port}`, { timeoutMs: 5_000 });
    const conversation = await driver.createConversation({ threadTs: "thread-1" });

    const pending = driver.send(conversation, "__hang__").catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 25));
    driver.dispose();

    const error = await pending;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/timed out/);
  });
});
