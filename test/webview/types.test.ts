import { describe, expect, it } from "vitest";
import { actorActivityFromEvent, commandFrom, commandsFrom, errorMessageFrom, eventFrom, fileDiffsFromEvent, messageFrom, modelGroupsFrom, modelsFrom, parseSlashCommand, partFrom, partSummary, permissionFrom, sessionActivityFromEvent, sessionFrom, taskActivityFromEvent, workflowActivityFromEvent } from "../../src/webview/types";

describe("webview data normalization", () => {
  it("keeps only typed session and message fields", () => {
    expect(sessionFrom({ id: "ses_1", title: "Plan", time: { created: 10, updated: "never" } })).toEqual({
      id: "ses_1",
      title: "Plan",
      parentID: undefined,
      time: { created: 10, updated: undefined, completed: undefined }
    });

    expect(messageFrom({
      info: { id: "msg_1", role: "assistant", time: { completed: 20 }, tokens: { input: 8, cache: { read: 3 } } },
      parts: [{ id: "part_1", type: "text", text: "hello" }]
    })).toEqual({
      message: {
        id: "msg_1",
        role: "assistant",
        text: undefined,
        time: { created: undefined, updated: undefined, completed: 20 },
        tokens: { input: 8, output: undefined, reasoning: undefined, cache: { read: 3, write: undefined } }
      },
      parts: [{ id: "part_1", type: "text", text: "hello", filename: undefined, url: undefined, tool: undefined, state: undefined }]
    });
  });

  it("normalizes dynamic commands and parses slash-command arguments", () => {
    expect(commandFrom({ name: "/review", description: "Review the current diff", source: "command", hints: ["$ARGUMENTS", 1] })).toEqual({
      name: "review",
      description: "Review the current diff",
      source: "command",
      agent: undefined,
      model: undefined,
      subtask: undefined,
      hints: ["$ARGUMENTS"]
    });
    expect(commandsFrom([{ name: "review", hints: [] }, { name: "review", hints: [] }, { name: "has spaces", hints: [] }])).toEqual([
      expect.objectContaining({ name: "review" })
    ]);
    expect(parseSlashCommand("  /review HEAD~1 ")).toEqual({ name: "review", arguments: "HEAD~1" });
    expect(parseSlashCommand("/review\nHEAD~1")).toEqual({ name: "review", arguments: "HEAD~1" });
    expect(parseSlashCommand("review HEAD~1")).toBeUndefined();
  });

  it("keeps only active text models from connected providers and groups them by provider", () => {
    const models = modelsFrom({
      connected: ["mimo", "xiaomi"],
      all: [
        {
          id: "mimo",
          name: "MiMo Auto (free)",
          models: {
            "mimo-auto": { name: "MiMo Auto", status: "active", variants: { low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" } }, capabilities: { input: { text: true }, output: { text: true } } }
          }
        },
        {
          id: "xiaomi",
          name: "Xiaomi",
          models: {
            "mimo-v2.5": { name: "MiMo V2.5", status: "active", capabilities: { input: { text: true }, output: { text: true } } },
            "mimo-preview": { name: "Preview", status: "beta", capabilities: { input: { text: true }, output: { text: true } } },
            "image-only": { name: "Image only", status: "active", capabilities: { input: { text: false }, output: { text: true } } }
          }
        },
        {
          id: "unconnected",
          name: "Not configured",
          models: {
            hidden: { name: "Hidden", status: "active", capabilities: { input: { text: true }, output: { text: true } } }
          }
        }
      ]
    });

    expect(models.map((model) => `${model.providerID}/${model.modelID}`)).toEqual(["mimo/mimo-auto", "xiaomi/mimo-v2.5"]);
    expect(models[0]?.thinkingEfforts).toEqual([{ variant: "low", effort: "low" }, { variant: "high", effort: "high" }]);
    expect(modelGroupsFrom(models)).toEqual([
      expect.objectContaining({ providerName: "MiMo Auto (free)", models: [expect.objectContaining({ modelID: "mimo-auto" })] }),
      expect.objectContaining({ providerName: "Xiaomi", models: [expect.objectContaining({ modelID: "mimo-v2.5" })] })
    ]);
  });

  it("normalizes tool, permission and invalid payloads defensively", () => {
    expect(partFrom({ id: "tool_1", type: "tool", state: { status: "running", input: { command: "pwd" } } })).toMatchObject({
      id: "tool_1",
      state: { status: "running", input: { command: "pwd" } }
    });
    expect(permissionFrom({ id: "perm_1", permission: "bash", sessionID: "ses_1", patterns: ["git status", 1] })).toEqual({
      id: "perm_1",
      permission: "bash",
      sessionID: "ses_1",
      patterns: ["git status"],
      metadata: {},
      always: []
    });
    expect(sessionFrom({ title: "missing id" })).toBeUndefined();
    expect(partFrom({ id: "part", text: "missing type" })).toBeUndefined();
  });

  it("does not expose synthetic or ignored text parts", () => {
    const normalized = messageFrom({
      info: { id: "msg_internal", role: "user" },
      parts: [
        { id: "part_visible", type: "text", text: "hello" },
        { id: "part_reminder", type: "text", text: "<system-reminder>internal</system-reminder>", synthetic: true },
        { id: "part_ignored", type: "text", text: "internal context", ignored: true }
      ]
    });

    expect(normalized.parts).toEqual([
      expect.objectContaining({ id: "part_visible", text: "hello" })
    ]);
    expect(partFrom({ id: "part_streamed", type: "text", text: "internal", synthetic: true })).toBeUndefined();
  });

  it("keeps the selected agent and exposes provider errors safely", () => {
    expect(messageFrom({
      info: { id: "msg_compose", role: "assistant", agent: "compose", error: { name: "ModelError", data: { message: "Model is unavailable" } } }
    }).message).toMatchObject({ agent: "compose", error: "ModelError: Model is unavailable" });
    expect(errorMessageFrom({ name: "APIError", data: { message: "Rate limit exceeded", responseBody: "private" } })).toBe("APIError: Rate limit exceeded");
  });

  it("maps MiMoCode session lifecycle events to visible activity", () => {
    expect(sessionActivityFromEvent("session.status", { sessionID: "ses_1", status: { type: "busy", message: "Waiting for the model" } })).toEqual({
      sessionID: "ses_1",
      activity: { kind: "working", message: "Waiting for the model" }
    });
    expect(sessionActivityFromEvent("session.status", { sessionID: "ses_1", status: { type: "idle" } })).toEqual({ sessionID: "ses_1" });
    expect(sessionActivityFromEvent("session.status", { sessionID: "ses_1", status: {} })).toEqual({ sessionID: "ses_1" });
    expect(sessionActivityFromEvent("session.status", { sessionID: "ses_1", status: { type: "unknown" } })).toEqual({ sessionID: "ses_1" });
    expect(sessionActivityFromEvent("session.retry.attempt", { sessionID: "ses_1", attempt: 2, maxAttempts: 3, reason: "temporary upstream failure" })).toEqual({
      sessionID: "ses_1",
      activity: { kind: "retrying", message: "Retrying (2/3): temporary upstream failure" }
    });
    expect(sessionActivityFromEvent("session.error", { error: { name: "APIError", data: { message: "Authentication failed" } } }, "ses_1")).toEqual({
      sessionID: "ses_1",
      activity: { kind: "error", message: "APIError: Authentication failed" }
    });
    expect(sessionActivityFromEvent("session.idle", { sessionID: "ses_1" })).toEqual({ sessionID: "ses_1" });
  });

  it("accepts both direct and global event envelopes", () => {
    expect(eventFrom({ type: "todo.updated", properties: { sessionID: "ses_1", todos: [] } })).toEqual({
      type: "todo.updated",
      properties: { sessionID: "ses_1", todos: [] }
    });
    expect(eventFrom({ directory: "/workspace", payload: { type: "session.idle", properties: { sessionID: "ses_1" } } })).toEqual({
      type: "session.idle",
      properties: { sessionID: "ses_1" }
    });
    expect(eventFrom({ payload: { properties: {} } })).toBeUndefined();
  });

  it("normalizes high-value work events for compact UI status", () => {
    expect(taskActivityFromEvent("task.updated", { sessionID: "ses_1", task: { id: "task_1", summary: "Run tests", status: "in_progress", owner: "build" } })).toEqual({
      sessionID: "ses_1",
      task: { id: "task_1", summary: "Run tests", status: "in_progress", owner: "build" }
    });
    expect(actorActivityFromEvent("actor.registered", { sessionID: "ses_1", actorID: "actor_1", agent: "build", description: "Verify the change", mode: "subagent" })).toEqual({
      sessionID: "ses_1",
      actor: { id: "actor_1", agent: "build", description: "Verify the change", mode: "subagent", status: "pending" }
    });
    expect(workflowActivityFromEvent("workflow.phase", { sessionID: "ses_1", runID: "run_1", title: "Implement" })).toEqual({
      sessionID: "ses_1",
      workflow: { id: "run_1", name: "Workflow", status: "working", phase: "Implement" }
    });
    expect(fileDiffsFromEvent("session.diff", { sessionID: "ses_1", diff: [{ file: "src/App.tsx", additions: 12, deletions: 3, status: "modified" }] })).toEqual({
      sessionID: "ses_1",
      files: [{ file: "src/App.tsx", additions: 12, deletions: 3, status: "modified" }]
    });
  });

  it("summarizes non-text message parts without exposing raw event payloads", () => {
    expect(partSummary(partFrom({ id: "patch_1", type: "patch", files: ["src/App.tsx", "src/styles.css"] })!)).toBe("Changed 2 files");
    expect(partSummary(partFrom({ id: "subtask_1", type: "subtask", description: "Inspect the event stream", agent: "plan" })!)).toBe("Inspect the event stream");
    expect(partSummary(partFrom({ id: "checkpoint_1", type: "checkpoint", checkpointNumber: 2 })!)).toBe("Saved checkpoint 2");
    expect(partSummary(partFrom({ id: "compact_1", type: "compaction", auto: true })!)).toBe("Compacted conversation context automatically");
  });
});
