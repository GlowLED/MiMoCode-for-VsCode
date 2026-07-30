export interface Session {
  id: string;
  title: string;
  parentID?: string;
  time?: { created?: number; updated?: number; completed?: number };
}

export interface Message {
  id: string;
  role: "user" | "assistant" | string;
  agent?: string;
  error?: string;
  text?: string;
  time?: { created?: number; completed?: number };
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
}

export interface SessionActivity {
  kind: "working" | "retrying" | "warning" | "error";
  message: string;
}

export interface TaskActivity {
  id: string;
  summary: string;
  status: string;
  owner?: string;
}

export interface ActorActivity {
  id: string;
  agent: string;
  description: string;
  mode?: string;
  status: "pending" | "running" | "idle" | "warning" | "error";
  error?: string;
}

export interface WorkflowActivity {
  id: string;
  name: string;
  status: "working" | "completed" | "failed" | "cancelled";
  phase?: string;
  error?: string;
}

export interface FileDiff {
  file: string;
  additions?: number;
  deletions?: number;
  status?: string;
}

export interface MessagePart {
  id: string;
  type: string;
  text?: string;
  url?: string;
  filename?: string;
  tool?: string;
  description?: string;
  prompt?: string;
  agent?: string;
  name?: string;
  files?: string[];
  attempt?: number;
  checkpointNumber?: number;
  auto?: boolean;
  error?: string;
  state?: { status?: string; input?: Record<string, unknown>; output?: string; error?: string; title?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface PermissionRequest {
  id: string;
  permission: string;
  sessionID: string;
  patterns?: string[];
  metadata?: Record<string, unknown>;
  always?: string[];
}

export interface FileAttachment {
  filename: string;
  mime: string;
  url: string;
}

export interface Agent {
  name: string;
  description?: string;
  mode?: string;
}

export interface ModelChoice {
  providerID: string;
  providerName: string;
  modelID: string;
  name: string;
  input?: Record<string, boolean>;
  thinkingEfforts: Array<{ variant: string; effort: string }>;
}

export interface ModelGroup {
  providerID: string;
  providerName: string;
  models: ModelChoice[];
}

export interface Command {
  name: string;
  description?: string;
  source?: string;
  agent?: string;
  model?: string;
  subtask?: boolean;
  hints: string[];
}

export interface ParsedCommand {
  name: string;
  arguments: string;
}

export function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function commandFrom(value: unknown): Command | undefined {
  const item = record(value);
  const rawName = typeof item.name === "string" ? item.name.trim().replace(/^\/+/, "") : "";
  if (!rawName || /\s/.test(rawName)) return undefined;
  return {
    name: rawName,
    description: typeof item.description === "string" ? item.description : undefined,
    source: typeof item.source === "string" ? item.source : undefined,
    agent: typeof item.agent === "string" ? item.agent : undefined,
    model: typeof item.model === "string" ? item.model : undefined,
    subtask: typeof item.subtask === "boolean" ? item.subtask : undefined,
    hints: asArray(item.hints).filter((hint): hint is string => typeof hint === "string")
  };
}

export function commandsFrom(value: unknown): Command[] {
  const seen = new Set<string>();
  return asArray(value).map(commandFrom).filter((command): command is Command => {
    if (!command || seen.has(command.name)) return false;
    seen.add(command.name);
    return true;
  });
}

export function parseSlashCommand(value: string): ParsedCommand | undefined {
  const match = value.trim().match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/);
  if (!match) return undefined;
  return { name: match[1]!, arguments: match[2] ?? "" };
}

export function modelsFrom(value: unknown): ModelChoice[] {
  const response = record(value);
  const connected = new Set(asArray(response.connected).filter((providerID): providerID is string => typeof providerID === "string"));
  if (connected.size === 0) return [];

  const providers = asArray(response.all);
  return providers.flatMap((provider) => {
    const item = record(provider);
    const providerID = typeof item.id === "string" ? item.id : "";
    if (!providerID || !connected.has(providerID)) return [];
    const providerName = typeof item.name === "string" ? item.name : providerID;
    return Object.entries(record(item.models)).flatMap(([modelID, model]) => {
      const details = record(model);
      const capabilities = record(details.capabilities);
      const input = booleanRecord(record(capabilities.input));
      const output = booleanRecord(record(capabilities.output));
      const thinkingEfforts = Object.entries(record(details.variants)).flatMap(([variant, value]) => {
        const effort = record(value).reasoningEffort;
        return typeof effort === "string" ? [{ variant, effort }] : [];
      });
      const status = typeof details.status === "string" ? details.status : undefined;
      if (status && status !== "active") return [];
      if (input.text !== true || output.text !== true) return [];
      return [{
        providerID,
        providerName,
        modelID,
        name: typeof details.name === "string" ? details.name : `${providerID}/${modelID}`,
        input,
        thinkingEfforts
      }];
    });
  });
}

export function modelGroupsFrom(models: ModelChoice[]): ModelGroup[] {
  const groups = new Map<string, ModelGroup>();
  for (const model of models) {
    const existing = groups.get(model.providerID);
    if (existing) existing.models.push(model);
    else groups.set(model.providerID, { providerID: model.providerID, providerName: model.providerName, models: [model] });
  }
  return [...groups.values()];
}

function booleanRecord(value: Record<string, unknown>): Record<string, boolean> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === "boolean")) as Record<string, boolean>;
}

export function eventFrom(value: unknown): { type: string; properties: Record<string, unknown> } | undefined {
  const outer = record(value);
  const event = typeof outer.type === "string" ? outer : record(outer.payload);
  if (typeof event.type !== "string") return undefined;
  return { type: event.type, properties: record(event.properties) };
}

export function sessionFrom(value: unknown): Session | undefined {
  const item = record(value);
  if (typeof item.id !== "string") return undefined;
  return {
    id: item.id,
    title: typeof item.title === "string" ? item.title : "Untitled session",
    parentID: typeof item.parentID === "string" ? item.parentID : undefined,
    time: timeFrom(item.time)
  };
}

export function messageFrom(value: unknown): { message?: Message; parts: MessagePart[] } {
  const outer = record(value);
  const info = record(outer.info ?? outer);
  if (typeof info.id !== "string") return { parts: [] };
  const parts = asArray(outer.parts).map(partFrom).filter((part): part is MessagePart => Boolean(part));
  const agent = typeof info.agent === "string" ? info.agent : undefined;
  const error = errorMessageFrom(info.error);
  return {
    message: {
      id: info.id,
      role: typeof info.role === "string" ? info.role : "assistant",
      ...(agent ? { agent } : {}),
      ...(error ? { error } : {}),
      text: typeof info.text === "string" ? info.text : undefined,
      time: timeFrom(info.time),
      tokens: tokensFrom(info.tokens)
    },
    parts
  };
}

export function partFrom(value: unknown): MessagePart | undefined {
  const item = record(value);
  if (typeof item.id !== "string" || typeof item.type !== "string") return undefined;
  if (item.synthetic === true || item.ignored === true) return undefined;
  const files = asArray(item.files).filter((file): file is string => typeof file === "string");
  const attempt = numberOrUndefined(item.attempt);
  const checkpointNumber = numberOrUndefined(item.checkpointNumber);
  const error = errorMessageFrom(item.error);
  return {
    ...item,
    id: item.id,
    type: item.type,
    text: typeof item.text === "string" ? item.text : undefined,
    filename: typeof item.filename === "string" ? item.filename : undefined,
    url: typeof item.url === "string" ? item.url : undefined,
    tool: typeof item.tool === "string" ? item.tool : undefined,
    ...(typeof item.description === "string" ? { description: item.description } : {}),
    ...(typeof item.prompt === "string" ? { prompt: item.prompt } : {}),
    ...(typeof item.agent === "string" ? { agent: item.agent } : {}),
    ...(typeof item.name === "string" ? { name: item.name } : {}),
    ...(files.length > 0 ? { files } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    ...(checkpointNumber !== undefined ? { checkpointNumber } : {}),
    ...(typeof item.auto === "boolean" ? { auto: item.auto } : {}),
    ...(error ? { error } : {}),
    state: partStateFrom(item.state)
  };
}

export function errorMessageFrom(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  const error = record(value);
  const data = record(error.data);
  const message = typeof data.message === "string" ? data.message : typeof error.message === "string" ? error.message : undefined;
  if (!message) return undefined;
  const name = typeof error.name === "string" ? error.name : undefined;
  return name && name !== "UnknownError" ? `${name}: ${message}` : message;
}

export function sessionActivityFromEvent(type: string, properties: unknown, fallbackSessionID?: string): { sessionID: string; activity?: SessionActivity } | undefined {
  const item = record(properties);
  const sessionID = typeof item.sessionID === "string" ? item.sessionID : fallbackSessionID;
  if (!sessionID) return undefined;

  if (type === "session.error") {
    return { sessionID, activity: { kind: "error", message: errorMessageFrom(item.error) ?? "MiMoCode stopped without reporting an error." } };
  }
  if (type === "session.idle") return { sessionID };
  if (type === "session.status") {
    const status = record(item.status);
    const statusType = typeof status.type === "string" ? status.type : undefined;
    if (statusType === "idle" || !statusType) return { sessionID };
    if (statusType === "retry") {
      const attempt = typeof status.attempt === "number" ? ` (attempt ${status.attempt})` : "";
      const message = typeof status.message === "string" ? status.message : "MiMoCode is retrying the request.";
      return { sessionID, activity: { kind: "retrying", message: `Retrying${attempt}: ${message}` } };
    }
    if (statusType === "busy") {
      return { sessionID, activity: { kind: "working", message: typeof status.message === "string" ? status.message : "MiMoCode is working on this request." } };
    }
    return { sessionID };
  }
  if (type === "session.retry.attempt") {
    const attempt = typeof item.attempt === "number" ? item.attempt : undefined;
    const maxAttempts = typeof item.maxAttempts === "number" ? item.maxAttempts : undefined;
    const reason = typeof item.reason === "string" ? item.reason : "MiMoCode is retrying the request.";
    const suffix = attempt && maxAttempts ? ` (${attempt}/${maxAttempts})` : "";
    return { sessionID, activity: { kind: "retrying", message: `Retrying${suffix}: ${reason}` } };
  }
  if (type === "actor.stuck" || type === "actor.stalled") {
    const description = typeof item.description === "string" ? item.description : "MiMoCode needs attention before it can continue.";
    return { sessionID, activity: { kind: "warning", message: description } };
  }
  if (type === "actor.status" && typeof item.error === "string") {
    return { sessionID, activity: { kind: "error", message: item.error } };
  }
  return undefined;
}

export function taskActivityFromEvent(type: string, properties: unknown): { sessionID: string; task: TaskActivity } | undefined {
  if (type !== "task.created" && type !== "task.updated") return undefined;
  const item = record(properties);
  const task = record(item.task);
  const sessionID = typeof item.sessionID === "string" ? item.sessionID : typeof task.session_id === "string" ? task.session_id : undefined;
  if (!sessionID || typeof task.id !== "string" || typeof task.summary !== "string" || typeof task.status !== "string") return undefined;
  return {
    sessionID,
    task: {
      id: task.id,
      summary: task.summary,
      status: task.status,
      owner: typeof task.owner === "string" ? task.owner : undefined
    }
  };
}

export function actorActivityFromEvent(type: string, properties: unknown): { sessionID: string; actor: ActorActivity } | undefined {
  if (type !== "actor.registered" && type !== "actor.status" && type !== "actor.stuck" && type !== "actor.stalled") return undefined;
  const item = record(properties);
  const sessionID = typeof item.sessionID === "string" ? item.sessionID : undefined;
  const id = typeof item.actorID === "string" ? item.actorID : undefined;
  if (!sessionID || !id) return undefined;

  if (type === "actor.registered") {
    return {
      sessionID,
      actor: {
        id,
        agent: typeof item.agent === "string" ? item.agent : "Agent",
        description: typeof item.description === "string" ? item.description : "Working on a task",
        mode: typeof item.mode === "string" ? item.mode : undefined,
        status: "pending"
      }
    };
  }

  if (type === "actor.status") {
    const status = item.status === "pending" || item.status === "running" || item.status === "idle" ? item.status : "pending";
    const error = typeof item.error === "string" ? item.error : undefined;
    return {
      sessionID,
      actor: {
        id,
        agent: "Agent",
        description: error ?? (status === "running" ? "Working" : status === "idle" ? "Waiting" : "Queued"),
        status: error ? "error" : status,
        error
      }
    };
  }

  const description = typeof item.description === "string" ? item.description : "Needs attention";
  return { sessionID, actor: { id, agent: "Agent", description, status: "warning" } };
}

export function workflowActivityFromEvent(type: string, properties: unknown): { sessionID: string; workflow: WorkflowActivity } | undefined {
  if (!type.startsWith("workflow.")) return undefined;
  const item = record(properties);
  const sessionID = typeof item.sessionID === "string" ? item.sessionID : undefined;
  const id = typeof item.runID === "string" ? item.runID : undefined;
  if (!sessionID || !id) return undefined;

  if (type === "workflow.started") {
    return { sessionID, workflow: { id, name: typeof item.name === "string" ? item.name : "Workflow", status: "working" } };
  }
  if (type === "workflow.phase") {
    return { sessionID, workflow: { id, name: "Workflow", status: "working", phase: typeof item.title === "string" ? item.title : undefined } };
  }
  if (type === "workflow.finished") {
    const status = item.status === "completed" || item.status === "failed" || item.status === "cancelled" ? item.status : "failed";
    return { sessionID, workflow: { id, name: "Workflow", status, error: typeof item.error === "string" ? item.error : undefined } };
  }
  if (type === "workflow.agent_failed" || type === "workflow.child_failed") {
    const name = typeof item.label === "string" ? item.label : typeof item.name === "string" ? item.name : "Workflow";
    return { sessionID, workflow: { id, name, status: "failed", phase: typeof item.phase === "string" ? item.phase : undefined, error: typeof item.errorMessage === "string" ? item.errorMessage : typeof item.error === "string" ? item.error : undefined } };
  }
  return undefined;
}

export function fileDiffsFromEvent(type: string, properties: unknown): { sessionID: string; files: FileDiff[] } | undefined {
  if (type !== "session.diff") return undefined;
  const item = record(properties);
  if (typeof item.sessionID !== "string") return undefined;
  const files = asArray(item.diff).flatMap((value) => {
    const file = record(value);
    if (typeof file.file !== "string") return [];
    return [{
      file: file.file,
      additions: numberOrUndefined(file.additions),
      deletions: numberOrUndefined(file.deletions),
      status: typeof file.status === "string" ? file.status : undefined
    }];
  });
  return { sessionID: item.sessionID, files };
}

export function partSummary(part: MessagePart): string | undefined {
  switch (part.type) {
    case "subtask": return part.description || part.prompt || "Started a subtask";
    case "agent": return part.name ? `Delegated to ${part.name}` : "Delegated to an agent";
    case "retry": return `Retrying request${part.attempt ? ` (${part.attempt})` : ""}`;
    case "checkpoint": return `Saved checkpoint${part.checkpointNumber ? ` ${part.checkpointNumber}` : ""}`;
    case "compaction": return part.auto ? "Compacted conversation context automatically" : "Compacted conversation context";
    case "patch": return part.files?.length ? `Changed ${part.files.length} file${part.files.length === 1 ? "" : "s"}` : "Prepared changes";
    default: return undefined;
  }
}

function timeFrom(value: unknown): Session["time"] {
  const item = record(value);
  const time = {
    created: numberOrUndefined(item.created),
    updated: numberOrUndefined(item.updated),
    completed: numberOrUndefined(item.completed)
  };
  return Object.values(time).some((entry) => entry !== undefined) ? time : undefined;
}

function tokensFrom(value: unknown): Message["tokens"] {
  const item = record(value);
  const cache = record(item.cache);
  const hasCache = numberOrUndefined(cache.read) !== undefined || numberOrUndefined(cache.write) !== undefined;
  const tokens: NonNullable<Message["tokens"]> = {
    input: numberOrUndefined(item.input),
    output: numberOrUndefined(item.output),
    reasoning: numberOrUndefined(item.reasoning),
    cache: hasCache ? { read: numberOrUndefined(cache.read), write: numberOrUndefined(cache.write) } : undefined
  };
  return tokens.input !== undefined || tokens.output !== undefined || tokens.reasoning !== undefined || hasCache ? tokens : undefined;
}

function partStateFrom(value: unknown): MessagePart["state"] {
  const item = record(value);
  const input = record(item.input);
  const state = {
    status: typeof item.status === "string" ? item.status : undefined,
    input: Object.keys(input).length > 0 ? input : undefined,
    output: typeof item.output === "string" ? item.output : undefined,
    error: typeof item.error === "string" ? item.error : undefined,
    title: typeof item.title === "string" ? item.title : undefined
  };
  return Object.values(state).some((entry) => entry !== undefined) ? state : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function permissionFrom(value: unknown): PermissionRequest | undefined {
  const item = record(value);
  if (typeof item.id !== "string" || typeof item.permission !== "string" || typeof item.sessionID !== "string") return undefined;
  return {
    id: item.id,
    permission: item.permission,
    sessionID: item.sessionID,
    patterns: asArray(item.patterns).filter((pattern): pattern is string => typeof pattern === "string"),
    metadata: record(item.metadata),
    always: asArray(item.always).filter((pattern): pattern is string => typeof pattern === "string")
  };
}
