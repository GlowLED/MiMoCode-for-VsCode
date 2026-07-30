import { describe, expect, it } from "vitest";
import { parseWebviewMessage } from "../../src/shared/protocol";

describe("webview protocol", () => {
  it("accepts a first prompt when creating a session", () => {
    expect(parseWebviewMessage({
      type: "new-session",
      root: "/workspace",
      prompt: {
        text: "Help me inspect this project",
        agent: "build",
        variant: "high",
        model: { providerID: "mimo", modelID: "mimo-v2" },
        attachments: []
      }
    })).toMatchObject({
      type: "new-session",
      root: "/workspace",
      prompt: { text: "Help me inspect this project", agent: "build", variant: "high", attachments: [] }
    });
  });
});
