import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  EventEmitter: class {
    public readonly event = () => ({ dispose() {} });
    public fire(): void {}
    public dispose(): void {}
  }
}));

import { MimoRuntimeService } from "../../src/runtime/MimoRuntimeService";

describe("MimoRuntimeService", () => {
  it("accepts a prompt asynchronously instead of holding the extension host for the response", async () => {
    const promptAsync = vi.fn().mockResolvedValue({ data: undefined, error: undefined });
    const service = new MimoRuntimeService();
    const root = "/workspace";

    (service as unknown as { runtimes: Map<string, unknown> }).runtimes.set(root, {
      root,
      status: "connected",
      url: "http://127.0.0.1:4096",
      client: { session: { promptAsync } }
    });

    await service.sendPrompt({
      root,
      sessionID: "ses_1",
      text: "hello",
      agent: "build",
      variant: "high",
      attachments: []
    });

    expect(promptAsync).toHaveBeenCalledWith({
      sessionID: "ses_1",
      agent: "build",
      variant: "high",
      model: undefined,
      parts: [{ type: "text", text: "hello" }]
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("includes the live session status when refreshing a session", async () => {
    const service = new MimoRuntimeService();
    const root = "/workspace";
    const status = { ses_1: { type: "idle" } };
    (service as unknown as { runtimes: Map<string, unknown> }).runtimes.set(root, {
      root,
      status: "connected",
      url: "http://127.0.0.1:4096",
      client: {
        session: {
          get: vi.fn().mockResolvedValue({ data: { id: "ses_1" } }),
          messages: vi.fn().mockResolvedValue({ data: [] }),
          todo: vi.fn().mockResolvedValue({ data: [] }),
          children: vi.fn().mockResolvedValue({ data: [] }),
          actors: vi.fn().mockResolvedValue({ data: {} }),
          status: vi.fn().mockResolvedValue({ data: status })
        }
      }
    });

    await expect(service.loadSession(root, "ses_1")).resolves.toMatchObject({
      session: { id: "ses_1" },
      messages: [],
      status
    });
  });
});
