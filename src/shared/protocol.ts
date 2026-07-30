import { z } from "zod";

export const FileAttachmentSchema = z.object({
  filename: z.string(),
  mime: z.string(),
  url: z.string().url()
});

export const EditorSelectionSchema = z.object({
  filename: z.string(),
  mime: z.literal("text/plain"),
  url: z.string().url(),
  selection: z
    .object({
      startLine: z.number().int().positive(),
      endLine: z.number().int().positive()
    })
    .optional()
});

const PromptPayloadSchema = z.object({
  text: z.string(),
  agent: z.string().optional(),
  variant: z.string().optional(),
  model: z
    .object({ providerID: z.string(), modelID: z.string() })
    .optional(),
  attachments: z.array(FileAttachmentSchema)
});

const CommandPayloadSchema = z.object({
  command: z.string(),
  arguments: z.string(),
  agent: z.string().optional(),
  variant: z.string().optional(),
  model: z
    .object({ providerID: z.string(), modelID: z.string() })
    .optional(),
  attachments: z.array(FileAttachmentSchema)
});

export const WebviewMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("bootstrap"), root: z.string().optional() }),
  z.object({ type: z.literal("retry") }),
  z.object({ type: z.literal("new-session"), root: z.string(), prompt: PromptPayloadSchema.optional() }),
  z.object({ type: z.literal("select-session"), root: z.string(), sessionID: z.string() }),
  PromptPayloadSchema.extend({
    type: z.literal("send-prompt"),
    root: z.string(),
    sessionID: z.string()
  }),
  CommandPayloadSchema.extend({
    type: z.literal("execute-command"),
    root: z.string(),
    sessionID: z.string()
  }),
  z.object({ type: z.literal("list-files"), root: z.string(), query: z.string() }),
  z.object({
    type: z.literal("permission-reply"),
    root: z.string(),
    requestID: z.string(),
    reply: z.enum(["once", "always", "reject"])
  }),
  z.object({ type: z.literal("open-file"), url: z.string().url() }),
  z.object({ type: z.literal("open-terminal"), root: z.string().optional() }),
  z.object({ type: z.literal("select-vscode-theme") }),
  z.object({ type: z.literal("configure-cli") }),
  z.object({ type: z.literal("open-token-plan") })
]);

export type WebviewMessage = z.infer<typeof WebviewMessageSchema>;

export const HostMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("runtime-status"), root: z.string().optional(), status: z.enum(["idle", "starting", "connected", "reconnecting", "error"]), message: z.string().optional() }),
  z.object({ type: z.literal("bootstrap-data"), root: z.string(), data: z.unknown() }),
  z.object({ type: z.literal("session-data"), root: z.string(), sessionID: z.string(), data: z.unknown() }),
  z.object({ type: z.literal("mimo-event"), root: z.string(), event: z.unknown() }),
  z.object({ type: z.literal("editor-selection"), selection: EditorSelectionSchema }),
  z.object({ type: z.literal("file-results"), query: z.string(), files: z.array(FileAttachmentSchema) }),
  z.object({ type: z.literal("error"), message: z.string(), recoverable: z.boolean().default(true) }),
  z.object({ type: z.literal("toast"), message: z.string(), level: z.enum(["info", "success", "warning", "error"]) })
]);

export type HostMessage = z.infer<typeof HostMessageSchema>;

export function parseWebviewMessage(value: unknown): WebviewMessage | undefined {
  const result = WebviewMessageSchema.safeParse(value);
  return result.success ? result.data : undefined;
}
