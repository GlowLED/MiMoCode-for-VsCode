import { describe, expect, it } from "vitest";
import { createOpencodeClient } from "@mimo-ai/sdk/v2";

describe("MiMo v2 SDK contract", () => {
  it("uses official v2 paths and encodes the directory in a header", async () => {
    const calls: Array<{ url: URL; method: string; headers: Headers; body: string }> = [];
    const client = createOpencodeClient({
      baseUrl: "http://127.0.0.1:4096",
      directory: "/work/with spaces",
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        calls.push({ url: new URL(request.url), method: request.method, headers: request.headers, body: await request.clone().text() });
        return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
      }
    });

    await client.session.messages({ sessionID: "ses/1", limit: 100, agent_id: "*" });
    await client.permission.reply({ requestID: "perm/1", reply: "once" });
    await client.command.list();
    await client.session.command({
      sessionID: "ses/1",
      command: "review",
      arguments: "HEAD~1",
      agent: "build",
      model: "mimo/mimo-auto",
      parts: [{ type: "file", filename: "src/App.tsx", mime: "text/plain", url: "file:///work/with%20spaces/src/App.tsx" }]
    });

    expect(calls[0]?.url.pathname).toBe("/session/ses%2F1/message");
    expect(calls[0]?.url.searchParams.get("limit")).toBe("100");
    expect(calls[0]?.url.searchParams.get("agent_id")).toBe("*");
    expect(calls[0]?.url.searchParams.get("directory")).toBe("/work/with spaces");
    expect(calls[1]?.url.pathname).toBe("/permission/perm%2F1/reply");
    expect(calls[1]?.body).toBe('{"reply":"once"}');
    expect(calls[2]?.url.pathname).toBe("/command");
    expect(calls[2]?.url.searchParams.get("directory")).toBe("/work/with spaces");
    expect(calls[3]?.url.pathname).toBe("/session/ses%2F1/command");
    expect(JSON.parse(calls[3]?.body ?? "{}")).toEqual({
      command: "review",
      arguments: "HEAD~1",
      agent: "build",
      model: "mimo/mimo-auto",
      parts: [{ type: "file", filename: "src/App.tsx", mime: "text/plain", url: "file:///work/with%20spaces/src/App.tsx" }]
    });
  });

  it("returns a useful result instead of exposing raw fetch failures", async () => {
    const client = createOpencodeClient({
      baseUrl: "http://127.0.0.1:4096",
      directory: "/work",
      fetch: async () => new Response(JSON.stringify({ message: "directory rejected" }), { status: 403 })
    });

    await expect(client.config.get()).resolves.toMatchObject({ error: expect.anything() });
  });

  it("submits prompts through the non-blocking endpoint", async () => {
    let request: Request | undefined;
    const client = createOpencodeClient({
      baseUrl: "http://127.0.0.1:4096",
      directory: "/work",
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        request = input instanceof Request ? input : new Request(input, init);
        return new Response(null, { status: 204 });
      }
    });

    await client.session.promptAsync({
      sessionID: "ses/1",
      agent: "build",
      variant: "high",
      parts: [{ type: "text", text: "hello" }]
    });

    expect(request).toBeDefined();
    expect(new URL(request!.url).pathname).toBe("/session/ses%2F1/prompt_async");
    expect(await request!.clone().json()).toEqual({
      agent: "build",
      variant: "high",
      parts: [{ type: "text", text: "hello" }]
    });
  });
});
