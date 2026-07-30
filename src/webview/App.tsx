import { For, Match, Show, Switch, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { createStore } from "solid-js/store";
import { AlertTriangle, ArrowLeft, ArrowUp, Bot, Check, ChevronDown, ChevronRight, FilePlus2, Hammer, ListTodo, Plus, Workflow, X } from "lucide-solid";
import { HostMessageSchema, type WebviewMessage } from "../shared/protocol";
import { actorActivityFromEvent, asArray, commandsFrom, errorMessageFrom, eventFrom, fileDiffsFromEvent, messageFrom, modelGroupsFrom, modelsFrom, parseSlashCommand, partFrom, partSummary, permissionFrom, record, sessionActivityFromEvent, sessionFrom, taskActivityFromEvent, workflowActivityFromEvent, type ActorActivity, type Agent, type Command, type FileAttachment, type FileDiff, type Message, type MessagePart, type ModelChoice, type PermissionRequest, type Session, type SessionActivity, type TaskActivity, type WorkflowActivity } from "./types";

declare function acquireVsCodeApi<T = unknown>(): { postMessage(message: T): void; getState(): unknown; setState(state: unknown): void };

const vscode = acquireVsCodeApi<WebviewMessage>();
const t = {
  newSession: "New session", connect: "Connect MiMoCode", retry: "Retry", configureCli: "Select CLI", noSession: "No session yet", build: "Build", plan: "Plan", compose: "Compose", message: "Message MiMoCode...", send: "Send", attach: "Add workspace file", context: "Context", todo: "Todo", permissions: "Pending approval", allowOnce: "Allow once", alwaysAllow: "Always allow", reject: "Reject", files: "Files", model: "Model", thinking: "Thinking effort", automatic: "Auto", composeLocked: "Compose stays isolated after the first message", connectionFailed: "Couldn't connect to the local service.", working: "MiMoCode is working", retrying: "MiMoCode is retrying", attention: "MiMoCode needs attention", empty: "Create a session to collaborate in this workspace.", noWorkspace: "Open a folder in VS Code first.", createSessionFirst: "Create a session first.", unsupportedInput: "The current model does not support this input type.", skipToConversation: "Skip to conversation", childSessions: "Child sessions", agentMode: "Agent mode", searchFiles: "Search workspace files", searchModels: "Search models", noMatchingModels: "No matching models", unknownCommand: "Unknown MiMoCode command", reasoning: "Reasoning"
} as const;

const localCommands: Command[] = [
  { name: "help", description: "Browse available commands", source: "ui", hints: [] },
  { name: "new", description: "Start a new session", source: "ui", hints: [] },
  { name: "clear", description: "Clear the current message", source: "ui", hints: [] },
  { name: "sessions", description: "Switch between sessions", source: "ui", hints: [] },
  { name: "themes", description: "Choose a VS Code theme", source: "ui", hints: [] },
  { name: "models", description: "Choose a model", source: "ui", hints: [] }
];

interface UiState {
  root?: string;
  status: "idle" | "starting" | "connected" | "reconnecting" | "error";
  statusMessage?: string;
  sessions: Session[];
  messages: Record<string, Message[]>;
  parts: Record<string, MessagePart[]>;
  permissions: PermissionRequest[];
  todos: Record<string, Array<{ content: string; status: string }>>;
  tasks: Record<string, TaskActivity[]>;
  actorActivities: Record<string, ActorActivity[]>;
  workflows: Record<string, WorkflowActivity[]>;
  diffs: Record<string, FileDiff[]>;
  children: Record<string, Session[]>;
  activities: Record<string, SessionActivity>;
  agents: Agent[];
  commands: Command[];
  models: ModelChoice[];
  selectedSessionID?: string;
  selectedModelKey?: string;
  error?: string;
}

const initialState: UiState = {
  status: "idle",
  sessions: [],
  messages: {},
  parts: {},
  permissions: [],
  todos: {},
  tasks: {},
  actorActivities: {},
  workflows: {},
  diffs: {},
  children: {},
  activities: {},
  agents: [],
  commands: [],
  models: []
};

export function App() {
  const [state, setState] = createStore<UiState>(initialState);
  const [draft, setDraft] = createSignal("");
  const [agent, setAgent] = createSignal("build");
  const [attachments, setAttachments] = createSignal<FileAttachment[]>([]);
  const [showFiles, setShowFiles] = createSignal(false);
  const [fileQuery, setFileQuery] = createSignal("");
  const [fileResults, setFileResults] = createSignal<FileAttachment[]>([]);
  const [commandMenuOpen, setCommandMenuOpen] = createSignal(false);
  const [commandIndex, setCommandIndex] = createSignal(0);
  const [showModelPicker, setShowModelPicker] = createSignal(false);
  const [thinkingVariant, setThinkingVariant] = createSignal<string>();
  const [toast, setToast] = createSignal<{ message: string; level: string }>();
  const [page, setPage] = createSignal<"resume" | "session">("resume");
  const [creatingSession, setCreatingSession] = createSignal(false);
  const [loadingSessionID, setLoadingSessionID] = createSignal<string>();
  let attachmentTrigger: HTMLButtonElement | undefined;
  let filePicker: HTMLDivElement | undefined;
  let commandPicker: HTMLDivElement | undefined;
  let messageInput: HTMLTextAreaElement | undefined;
  let modelTrigger: HTMLButtonElement | undefined;
  let modelPicker: HTMLDivElement | undefined;
  let localErrorSequence = 0;

  const selectedSession = createMemo(() => state.sessions.find((session) => session.id === state.selectedSessionID));
  const sessionMessages = createMemo(() => state.selectedSessionID ? state.messages[state.selectedSessionID] ?? [] : []);
  const messages = createMemo(() => sessionMessages().filter((message) => isRenderableMessage(message, state.parts[message.id] ?? [])));
  const selectedModel = createMemo(() => state.models.find((model) => `${model.providerID}/${model.modelID}` === state.selectedModelKey));
  const thinkingEfforts = createMemo(() => {
    const efforts = new Map<string, { variant: string; effort: string }>();
    for (const model of state.models) {
      for (const option of model.thinkingEfforts) {
        if (!efforts.has(option.variant)) efforts.set(option.variant, option);
      }
    }
    return [...efforts.values()];
  });
  const currentPermissions = createMemo(() => state.selectedSessionID ? state.permissions.filter((permission) => permission.sessionID === state.selectedSessionID) : []);
  const currentTodos = createMemo(() => state.selectedSessionID ? state.todos[state.selectedSessionID] ?? [] : []);
  const currentTasks = createMemo(() => state.selectedSessionID ? state.tasks[state.selectedSessionID] ?? [] : []);
  const currentActors = createMemo(() => state.selectedSessionID ? state.actorActivities[state.selectedSessionID] ?? [] : []);
  const currentWorkflows = createMemo(() => state.selectedSessionID ? state.workflows[state.selectedSessionID] ?? [] : []);
  const currentDiffs = createMemo(() => state.selectedSessionID ? state.diffs[state.selectedSessionID] ?? [] : []);
  const currentChildren = createMemo(() => state.selectedSessionID ? state.children[state.selectedSessionID] ?? [] : []);
  const composeLocked = createMemo(() => page() === "session" && agent() === "compose" && messages().some((message) => message.agent === "compose"));
  const currentActivity = createMemo(() => state.selectedSessionID ? state.activities[state.selectedSessionID] : undefined);
  const requestInFlight = createMemo(() => currentActivity()?.kind === "working" || currentActivity()?.kind === "retrying");
  const cliUnavailable = createMemo(() => /unable to find mimocode cli|spawn\s+mimo\s+enoent/i.test(state.error ?? state.statusMessage ?? ""));
  const connectionFailed = createMemo(() => state.status === "error");
  const context = createMemo(() => contextUsage(messages(), selectedModel()));
  const commands = createMemo(() => [...localCommands, ...state.commands.filter((command) => !localCommands.some((local) => local.name === command.name))]);
  const commandQuery = createMemo(() => draft().trimStart().match(/^\/([^\s]*)$/)?.[1]?.toLowerCase());
  const commandSuggestions = createMemo(() => {
    const query = commandQuery();
    if (query === undefined) return [];
    const matches = commands().filter((command) => command.name.toLowerCase().includes(query) || command.description?.toLowerCase().includes(query));
    return query ? matches.slice(0, 12) : matches;
  });
  const modelGroups = createMemo(() => modelGroupsFrom(state.models));

  onMount(() => {
    const messageHandler = (event: MessageEvent<unknown>) => handleHost(event.data);
    const pointerDownHandler = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (showFiles() && !filePicker?.contains(event.target) && !attachmentTrigger?.contains(event.target)) setShowFiles(false);
      if (showModelPicker() && !modelPicker?.contains(event.target) && !modelTrigger?.contains(event.target)) closeModelPicker(false);
      if (commandMenuOpen() && !commandPicker?.contains(event.target) && !messageInput?.contains(event.target)) setCommandMenuOpen(false);
    };
    const keyDownHandler = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (showModelPicker()) {
        event.preventDefault();
        closeModelPicker();
      } else if (showFiles()) {
        event.preventDefault();
        setShowFiles(false);
      } else if (commandMenuOpen()) {
        event.preventDefault();
        setCommandMenuOpen(false);
      }
    };
    window.addEventListener("message", messageHandler);
    window.addEventListener("pointerdown", pointerDownHandler);
    window.addEventListener("keydown", keyDownHandler);
    vscode.postMessage({ type: "ready" });
    onCleanup(() => {
      window.removeEventListener("message", messageHandler);
      window.removeEventListener("pointerdown", pointerDownHandler);
      window.removeEventListener("keydown", keyDownHandler);
    });
  });

  function handleHost(raw: unknown): void {
    const parsed = HostMessageSchema.safeParse(raw);
    if (!parsed.success) return;
    const message = parsed.data;
    switch (message.type) {
      case "runtime-status":
        if (message.root && state.root && message.root !== state.root) return;
        setState({ root: state.root ?? message.root, status: message.status, statusMessage: message.message });
        return;
      case "bootstrap-data":
        hydrateBootstrap(message.root, message.data);
        return;
      case "session-data":
        hydrateSession(message.sessionID, message.data);
        if (loadingSessionID() && loadingSessionID() !== message.sessionID) return;
        setState("selectedSessionID", message.sessionID);
        setLoadingSessionID(undefined);
        setPage("session");
        if (creatingSession()) {
          setCreatingSession(false);
          updateDraft("");
          setAttachments([]);
          setActivity(message.sessionID, { kind: "working", message: "Sending your request to MiMoCode..." });
        }
        return;
      case "mimo-event":
        if (message.root === state.root) applyEvent(message.event);
        return;
      case "editor-selection":
        attach(message.selection);
        return;
      case "file-results":
        if (message.query === fileQuery()) setFileResults(message.files);
        return;
      case "error":
        setState({ error: message.message, statusMessage: message.message });
        if (creatingSession()) setCreatingSession(false);
        if (state.selectedSessionID) setActivity(state.selectedSessionID, { kind: "error", message: message.message });
        setToast({ message: message.message, level: "error" });
        return;
      case "toast":
        setToast(message);
        return;
    }
  }

  function hydrateBootstrap(root: string, value: unknown): void {
    const data = record(value);
    const sessions = asArray(data.sessions).map(sessionFrom).filter((session): session is Session => Boolean(session));
    const agents = asArray(data.agents).map(agentFrom).filter((item): item is Agent => Boolean(item));
    const models = modelsFrom(data.providers);
    const commands = commandsFrom(data.commands);
    const permissions = asArray(data.permissions).map(permissionFrom).filter((item): item is PermissionRequest => Boolean(item));
    setState({
      root,
      status: "connected",
      error: undefined,
      sessions: orderSessions(sessions),
      agents,
      commands,
      models,
      permissions,
      selectedModelKey: state.selectedModelKey && models.some((model) => modelKey(model) === state.selectedModelKey)
        ? state.selectedModelKey
        : models[0] ? modelKey(models[0]) : undefined
    });
    for (const [sessionID, status] of Object.entries(record(data.sessionStatus))) {
      const activity = sessionActivityFromEvent("session.status", { sessionID, status });
      if (activity?.activity) setActivity(sessionID, activity.activity);
      else if (activity) clearActivity(sessionID);
    }

  }

  function hydrateSession(sessionID: string, value: unknown): void {
    const data = record(value);
    const normalized = asArray(data.messages).map(messageFrom).filter((item) => item.message);
    const nextMessages = normalized.map((item) => item.message as Message);
    const parts = normalized.flatMap((item) => item.parts);
    const todos = asArray(data.todos).map(todoFrom).filter((todo): todo is { content: string; status: string } => Boolean(todo));
    const children = asArray(data.children).map(sessionFrom).filter((session): session is Session => Boolean(session));
    setState("messages", sessionID, nextMessages);
    for (const item of normalized) {
      if (item.message) setState("parts", item.message.id, item.parts);
    }
    setState("todos", sessionID, todos);
    setState("children", sessionID, children);
    const latestMessageError = nextMessages.at(-1)?.error;
    const activity = sessionActivityFromEvent("session.status", { sessionID, status: record(data.status)[sessionID] });
    if (latestMessageError) removeActivity(sessionID);
    else if (activity?.activity) setActivity(sessionID, activity.activity);
    else if (activity) clearActivity(sessionID);
  }

  function applyEvent(raw: unknown): void {
    const event = eventFrom(raw);
    if (!event) return;
    const { type, properties } = event;

    const taskEvent = taskActivityFromEvent(type, properties);
    if (taskEvent) {
      upsertTask(taskEvent.sessionID, taskEvent.task);
      return;
    }

    const actorEvent = actorActivityFromEvent(type, properties);
    if (actorEvent) upsertActor(actorEvent.sessionID, actorEvent.actor);

    const workflowEvent = workflowActivityFromEvent(type, properties);
    if (workflowEvent) {
      upsertWorkflow(workflowEvent.sessionID, workflowEvent.workflow);
      if (workflowEvent.workflow.status === "failed") setActivity(workflowEvent.sessionID, { kind: "error", message: workflowEvent.workflow.error ?? `${workflowEvent.workflow.name} failed.` });
      return;
    }

    const diffEvent = fileDiffsFromEvent(type, properties);
    if (diffEvent) {
      setState("diffs", diffEvent.sessionID, diffEvent.files);
      return;
    }

    const activity = sessionActivityFromEvent(type, properties, state.selectedSessionID);
    if (activity) {
      if (activity.activity) setActivity(activity.sessionID, activity.activity);
      else clearActivity(activity.sessionID);
      if (actorEvent) return;
    }
    if (type === "tui.toast.show") {
      const message = typeof properties.message === "string" ? properties.message : undefined;
      const title = typeof properties.title === "string" ? properties.title : undefined;
      const level = properties.variant === "success" || properties.variant === "warning" || properties.variant === "error" ? properties.variant : "info";
      if (message) setToast({ message: title ? `${title}: ${message}` : message, level });
      return;
    }
    if (type === "message.updated") {
      const parsed = messageFrom(properties.info);
      const sessionID = typeof properties.sessionID === "string" ? properties.sessionID : typeof record(properties.info).sessionID === "string" ? String(record(properties.info).sessionID) : state.selectedSessionID;
      if (parsed.message && sessionID) {
        upsertMessage(sessionID, parsed.message);
        if (parsed.message.error) removeActivity(sessionID);
      }
      return;
    }
    if (type === "message.part.updated") {
      const part = partFrom(properties.part);
      if (!part) return;
      const sessionID = typeof properties.sessionID === "string" ? properties.sessionID : typeof record(properties.part).sessionID === "string" ? String(record(properties.part).sessionID) : state.selectedSessionID;
      const messageID = typeof record(properties.part).messageID === "string" ? String(record(properties.part).messageID) : undefined;
      if (sessionID && messageID) {
        upsertPart(messageID, part);
        ensureMessage(sessionID, messageID);
      }
      return;
    }
    if (type === "message.part.delta") {
      const messageID = typeof properties.messageID === "string" ? properties.messageID : undefined;
      const partID = typeof properties.partID === "string" ? properties.partID : undefined;
      const field = typeof properties.field === "string" ? properties.field : undefined;
      const delta = typeof properties.delta === "string" ? properties.delta : undefined;
      const sessionID = typeof properties.sessionID === "string" ? properties.sessionID : state.selectedSessionID;
      if (!messageID || !partID || !field || delta === undefined || !sessionID) return;
      applyPartDelta(sessionID, messageID, partID, field, delta);
      return;
    }
    if (type === "message.part.removed") {
      const messageID = typeof properties.messageID === "string" ? properties.messageID : undefined;
      const partID = typeof properties.partID === "string" ? properties.partID : undefined;
      if (messageID && partID) setState("parts", messageID, (current = []) => current.filter((part) => part.id !== partID));
      return;
    }
    if (type === "message.removed") {
      const sessionID = typeof properties.sessionID === "string" ? properties.sessionID : state.selectedSessionID;
      const messageID = typeof properties.messageID === "string" ? properties.messageID : undefined;
      if (sessionID && messageID) setState("messages", sessionID, (current = []) => current.filter((message) => message.id !== messageID));
      return;
    }
    if (type === "todo.updated") {
      const sessionID = typeof properties.sessionID === "string" ? properties.sessionID : undefined;
      if (sessionID) setState("todos", sessionID, asArray(properties.todos).map(todoFrom).filter((todo): todo is { content: string; status: string } => Boolean(todo)));
      return;
    }
    if (type === "permission.asked") {
      const permission = permissionFrom(properties);
      if (permission) setState("permissions", (current) => [...current.filter((item) => item.id !== permission.id), permission]);
      return;
    }
    if (type === "permission.replied") {
      const requestID = typeof properties.requestID === "string" ? properties.requestID : undefined;
      if (requestID) setState("permissions", (current) => current.filter((permission) => permission.id !== requestID));
      return;
    }
    if (type === "session.updated" || type === "session.created") {
      const session = sessionFrom(properties.info);
      if (session) {
        setState("sessions", (current) => orderSessions([...current.filter((item) => item.id !== session.id), session]));
      }
      return;
    }
    if (type === "session.deleted") {
      const sessionID = typeof properties.sessionID === "string" ? properties.sessionID : typeof record(properties.info).id === "string" ? String(record(properties.info).id) : undefined;
      if (sessionID) setState("sessions", (current) => current.filter((session) => session.id !== sessionID));
    }
  }

  function upsertMessage(sessionID: string, message: Message): void {
    setState("messages", sessionID, (current = []) => {
      const index = current.findIndex((item) => item.id === message.id);
      if (index === -1) return [...current, message];
      return current.map((item, position) => position === index ? { ...item, ...message } : item);
    });
  }

  function setActivity(sessionID: string, activity: SessionActivity): void {
    setState("activities", sessionID, activity);
  }

  function clearActivity(sessionID: string): void {
    if (state.activities[sessionID]?.kind === "error") return;
    removeActivity(sessionID);
  }

  function removeActivity(sessionID: string): void {
    setState("activities", sessionID, undefined!);
  }

  function preserveCurrentError(sessionID: string): void {
    const activity = state.activities[sessionID];
    if (activity?.kind !== "error") return;
    const hasRenderedError = (state.messages[sessionID] ?? []).some((message) => message.error === activity.message);
    if (!hasRenderedError) {
      upsertMessage(sessionID, {
        id: `local-error-${sessionID}-${Date.now()}-${localErrorSequence++}`,
        role: "assistant",
        error: activity.message,
        time: { created: Date.now() }
      });
    }
    removeActivity(sessionID);
  }

  function startActivity(sessionID: string, activity: SessionActivity): void {
    preserveCurrentError(sessionID);
    setActivity(sessionID, activity);
  }

  function upsertTask(sessionID: string, task: TaskActivity): void {
    setState("tasks", sessionID, (current = []) => {
      const index = current.findIndex((item) => item.id === task.id);
      return index === -1 ? [...current, task] : current.map((item, position) => position === index ? { ...item, ...task } : item);
    });
  }

  function upsertActor(sessionID: string, actor: ActorActivity): void {
    setState("actorActivities", sessionID, (current = []) => {
      const index = current.findIndex((item) => item.id === actor.id);
      if (index === -1) return [...current, actor];
      return current.map((item, position) => position === index ? {
        ...item,
        ...actor,
        agent: actor.agent === "Agent" ? item.agent : actor.agent,
        description: actor.description === "Working" || actor.description === "Waiting" || actor.description === "Queued" ? item.description : actor.description
      } : item);
    });
  }

  function upsertWorkflow(sessionID: string, workflow: WorkflowActivity): void {
    setState("workflows", sessionID, (current = []) => {
      const index = current.findIndex((item) => item.id === workflow.id);
      return index === -1 ? [...current, workflow] : current.map((item, position) => position === index ? { ...item, ...workflow, name: workflow.name === "Workflow" ? item.name : workflow.name } : item);
    });
  }

  function ensureMessage(sessionID: string, messageID: string): void {
    if ((state.messages[sessionID] ?? []).some((message) => message.id === messageID)) return;
    upsertMessage(sessionID, { id: messageID, role: "assistant" });
  }

  function upsertPart(messageID: string, part: MessagePart): void {
    setState("parts", messageID, (current = []) => {
      const index = current.findIndex((item) => item.id === part.id);
      if (index === -1) return [...current, part];
      return current.map((item, position) => position === index ? { ...item, ...part, state: { ...item.state, ...part.state } } : item);
    });
  }

  function applyPartDelta(sessionID: string, messageID: string, partID: string, field: string, delta: string): void {
    const current = state.parts[messageID] ?? [];
    const part = current.find((item) => item.id === partID) ?? { id: partID, type: "text" };
    const next = { ...part } as MessagePart;
    if (field === "text") next.text = `${next.text ?? ""}${delta}`;
    else if (field.startsWith("state.")) {
      const key = field.slice("state.".length);
      next.state = { ...next.state, [key]: `${String(next.state?.[key] ?? "")}${delta}` };
    }
    upsertPart(messageID, next);
    ensureMessage(sessionID, messageID);
  }

  function submit(): void {
    if (!state.root || creatingSession() || loadingSessionID()) return;
    const text = draft();
    if (!text.trim() && attachments().length === 0) return;
    const parsedCommand = parseSlashCommand(text);
    if (parsedCommand) {
      const command = commands().find((item) => item.name === parsedCommand.name);
      if (!command) {
        setToast({ message: `${t.unknownCommand}: /${parsedCommand.name}`, level: "warning" });
        return;
      }
      if (localCommands.some((local) => local.name === command.name)) {
        if (command.name === "models") {
          updateDraft("");
          openModelPicker();
        } else if (command.name === "help") {
          updateDraft("/");
          queueMicrotask(() => messageInput?.focus());
        } else if (command.name === "sessions") {
          updateDraft("");
          returnToResume();
        } else if (command.name === "themes") {
          updateDraft("");
          vscode.postMessage({ type: "select-vscode-theme" });
        } else if (command.name === "clear") {
          updateDraft("");
          setAttachments([]);
        } else if (command.name === "new") {
          const hasPrompt = Boolean(parsedCommand.arguments.trim() || attachments().length > 0);
          if (hasPrompt) setCreatingSession(true);
          vscode.postMessage({
            type: "new-session",
            root: state.root,
            prompt: hasPrompt ? {
              text: parsedCommand.arguments,
              agent: agent(),
              variant: thinkingVariant(),
              model: selectedModel() ? { providerID: selectedModel()!.providerID, modelID: selectedModel()!.modelID } : undefined,
              attachments: attachments()
            } : undefined
          });
          if (!hasPrompt) {
            updateDraft("");
            setAttachments([]);
          }
        }
        return;
      }
    }
    if (page() === "resume") {
      if (parsedCommand) {
        setToast({ message: t.createSessionFirst, level: "warning" });
        return;
      }
      setCreatingSession(true);
      vscode.postMessage({
        type: "new-session",
        root: state.root,
        prompt: {
          text,
          agent: agent(),
          variant: thinkingVariant(),
          model: selectedModel() ? { providerID: selectedModel()!.providerID, modelID: selectedModel()!.modelID } : undefined,
          attachments: attachments()
        }
      });
      return;
    }
    if (!state.selectedSessionID) return;
    if (parsedCommand) {
      const command = commands().find((item) => item.name === parsedCommand.name);
      if (!command) return;
      startActivity(state.selectedSessionID, { kind: "working", message: `Running /${command.name}...` });
      vscode.postMessage({
        type: "execute-command",
        root: state.root,
        sessionID: state.selectedSessionID,
        command: command.name,
        arguments: parsedCommand.arguments,
        agent: agent(),
        variant: thinkingVariant(),
        model: selectedModel() ? { providerID: selectedModel()!.providerID, modelID: selectedModel()!.modelID } : undefined,
        attachments: attachments()
      });
      updateDraft("");
      setAttachments([]);
      return;
    }
    startActivity(state.selectedSessionID, { kind: "working", message: "Sending your request to MiMoCode..." });
    vscode.postMessage({
      type: "send-prompt",
      root: state.root,
      sessionID: state.selectedSessionID,
      text,
      agent: agent(),
      variant: thinkingVariant(),
      model: selectedModel() ? { providerID: selectedModel()!.providerID, modelID: selectedModel()!.modelID } : undefined,
      attachments: attachments()
    });
    updateDraft("");
    setAttachments([]);
  }

  function openSession(sessionID: string): void {
    if (!state.root || creatingSession()) return;
    setShowFiles(false);
    setCommandMenuOpen(false);
    closeModelPicker(false);
    setLoadingSessionID(sessionID);
    setState("selectedSessionID", sessionID);
    setPage("session");
    vscode.postMessage({ type: "select-session", root: state.root, sessionID });
  }

  function returnToResume(): void {
    setPage("resume");
    setLoadingSessionID(undefined);
    setShowFiles(false);
    setCommandMenuOpen(false);
    closeModelPicker(false);
  }

  function updateDraft(value: string): void {
    setDraft(value);
    setCommandIndex(0);
    setCommandMenuOpen(/^\s*\/[^\s]*$/.test(value));
  }

  function selectCommand(command: Command): void {
    updateDraft(`/${command.name} `);
    setCommandMenuOpen(false);
    queueMicrotask(() => messageInput?.focus());
  }

  function moveCommandSelection(direction: 1 | -1): void {
    const count = commandSuggestions().length;
    if (count > 0) setCommandIndex((current) => (current + direction + count) % count);
  }

  function openModelPicker(): void {
    setShowFiles(false);
    setCommandMenuOpen(false);
    setShowModelPicker(true);
  }

  function closeModelPicker(restoreFocus = true): void {
    setShowModelPicker(false);
    if (restoreFocus) queueMicrotask(() => modelTrigger?.focus());
  }

  function selectModel(model: ModelChoice): void {
    setState("selectedModelKey", modelKey(model));
  }

  function selectThinkingEffort(variant?: string): void {
    setThinkingVariant(variant);
  }

  function attach(file: FileAttachment): void {
    if (!file.mime.startsWith("text/") && !canAttach(file)) {
      setToast({ message: t.unsupportedInput, level: "warning" });
      return;
    }
    setAttachments((current) => current.some((item) => item.url === file.url) ? current : [...current, file]);
    setShowFiles(false);
  }

  function queryFiles(value: string): void {
    setFileQuery(value);
    if (state.root) vscode.postMessage({ type: "list-files", root: state.root, query: value });
  }

  function toggleFilePicker(): void {
    const next = !showFiles();
    setShowFiles(next);
    if (next) queryFiles("");
  }

  function switchAgent(next: string): void {
    if (composeLocked()) return;
    setAgent(next);
  }

  function cycleAgent(direction: 1 | -1): boolean {
    if (composeLocked()) return false;
    const available = agentNames(state.agents);
    if (available.length < 2) return false;
    const current = available.indexOf(agent());
    const next = (current + direction + available.length) % available.length;
    switchAgent(available[next]!);
    return true;
  }

  return (
    <div class="app-shell">
      <Show when={connectionFailed()} fallback={<>
      <a class="skip-link" href="#main-content">{t.skipToConversation}</a>
      <Show when={state.root} fallback={<section class="empty-state"><Bot size={22} /><p>{t.noWorkspace}</p><button class="primary-button" type="button" onClick={() => vscode.postMessage({ type: "retry" })}>{t.connect}</button></section>}>
        <Show when={page() === "resume"} fallback={<>
          <header class="session-header">
            <button class="icon-button" type="button" aria-label="Back to Resume" title="Back to Resume" onClick={returnToResume}><ArrowLeft size={18} aria-hidden="true" /></button>
            <div><h1>{selectedSession()?.title ?? t.newSession}</h1></div>
          </header>
          <main id="main-content" class="conversation" aria-label="MiMoCode conversation" role="log" aria-live="polite">
            <Show when={loadingSessionID()} fallback={<>
              <Show when={messages().length === 0 && !currentActivity() && state.status === "connected"}><div class="empty-state empty-state--inline"><Bot size={22} /><p>Start a conversation in this session.</p></div></Show>
              <For each={messages()}>{(message) => <MessageCard message={message} parts={state.parts[message.id] ?? []} onOpenFile={(url) => vscode.postMessage({ type: "open-file", url })} />}</For>
              <Show when={currentActivity()}>{(activity) => <AgentStatusMessage activity={activity()} />}</Show>
            </>}><div class="empty-state empty-state--inline"><Bot size={22} /><p>Loading conversation...</p></div></Show>
          </main>

          <Show when={currentTodos().length > 0 || currentTasks().length > 0 || currentActors().length > 0 || currentWorkflows().length > 0 || currentDiffs().length > 0 || currentPermissions().length > 0 || currentChildren().length > 0}>
            <aside class="work-panel" aria-label="MiMoCode work status">
              <Show when={currentTodos().length > 0}><section><h2>{t.todo}</h2><For each={currentTodos()}>{(todo) => <div class={`todo todo--${todo.status}`}><span />{todo.content}</div>}</For></section></Show>
              <Show when={currentTasks().length > 0}><section><h2>Tasks</h2><For each={currentTasks()}>{(task) => <ActivityRow icon="task" title={task.summary} detail={task.owner} status={task.status} />}</For></section></Show>
              <Show when={currentActors().length > 0}><section><h2>Agents</h2><For each={currentActors()}>{(actor) => <ActivityRow icon="agent" title={actor.description} detail={actor.agent} status={actor.status} error={actor.error} />}</For></section></Show>
              <Show when={currentWorkflows().length > 0}><section><h2>Workflow</h2><For each={currentWorkflows()}>{(workflow) => <ActivityRow icon="workflow" title={workflow.name} detail={workflow.error ?? workflow.phase} status={workflow.status} />}</For></section></Show>
              <Show when={currentDiffs().length > 0}><section><h2>Changed files</h2><For each={currentDiffs().slice(0, 4)}>{(file) => <ActivityRow icon="file" title={file.file} detail={file.additions !== undefined || file.deletions !== undefined ? `+${file.additions ?? 0} −${file.deletions ?? 0}` : file.status} status={file.status} />}</For><Show when={currentDiffs().length > 4}><p class="activity-more">+{currentDiffs().length - 4} more files</p></Show></section></Show>
              <Show when={currentChildren().length > 0}><section><h2>{t.childSessions}</h2><For each={currentChildren()}>{(child) => <button class="child-session" type="button" onClick={() => openSession(child.id)}><ChevronRight size={14} />{child.title}</button>}</For></section></Show>
              <Show when={currentPermissions().length > 0}><section><h2>{t.permissions}</h2><For each={currentPermissions()}>{(permission) => <PermissionCard permission={permission} onReply={(reply) => state.root && vscode.postMessage({ type: "permission-reply", root: state.root, requestID: permission.id, reply })} />}</For></section></Show>
            </aside>
          </Show>
        </>}>
          <main id="main-content" class="resume-page" aria-labelledby="resume-heading">
            <header class="resume-header"><h1 id="resume-heading">Chats</h1></header>
            <Show when={state.sessions.length > 0} fallback={<section class="resume-empty"><Bot size={22} /><p>Start a conversation below to create your first session.</p></section>}>
              <section class="resume-list" aria-label="Recent chats">
                <For each={state.sessions}>{(session) => <button class="resume-row" type="button" onClick={() => openSession(session.id)}><strong>{session.title}</strong><small class={`resume-status resume-status--${state.activities[session.id]?.kind ?? "idle"}`}>{sessionMeta(session, state.activities[session.id])}</small></button>}</For>
              </section>
            </Show>
          </main>
        </Show>

        <footer class="composer-area">
          <Show when={attachments().length > 0}><div class="attachment-row"><For each={attachments()}>{(file) => <span class="attachment"><FilePlus2 size={13} />{file.filename}<button type="button" aria-label={`Remove ${file.filename}`} onClick={() => setAttachments((items) => items.filter((item) => item.url !== file.url))}><X size={12} /></button></span>}</For></div></Show>
          <div class={`composer composer--${agent()}`}>
            <textarea ref={(element) => { messageInput = element; }} aria-label={t.message} placeholder={t.message} value={draft()} aria-controls="command-list" aria-expanded={commandMenuOpen()} aria-activedescendant={commandMenuOpen() ? `command-option-${commandIndex()}` : undefined} onInput={(event) => updateDraft(event.currentTarget.value)} onKeyDown={(event) => {
              if (commandMenuOpen() && commandSuggestions().length > 0) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  moveCommandSelection(event.key === "ArrowDown" ? 1 : -1);
                  return;
                }
                if (event.key === "Enter" || event.key === "Tab") {
                  event.preventDefault();
                  const command = commandSuggestions()[commandIndex()];
                  if (command) selectCommand(command);
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setCommandMenuOpen(false);
                  return;
                }
              }
              if (event.key === "Tab" && !event.metaKey && !event.ctrlKey && !event.altKey) {
                if (cycleAgent(event.shiftKey ? -1 : 1)) event.preventDefault();
                return;
              }
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                submit();
              }
            }} />
            <div class="composer-footer">
              <div class="composer-start">
                <button ref={(element) => { attachmentTrigger = element; }} class="icon-button" type="button" aria-label={t.attach} title={t.attach} aria-controls="file-picker" aria-expanded={showFiles()} onClick={toggleFilePicker}><Plus size={18} aria-hidden="true" /></button>
                <div class="composer-settings">
                  <div class={`composer-mode composer-mode--${agent()}`} role="status" aria-label={`${t.agentMode}: ${agentLabel(agent())}`} title={`${t.agentMode}: ${agentLabel(agent())}`}>
                    <AgentModeIcon name={agent()} />
                    <span>{agentLabel(agent())}</span>
                  </div>
                </div>
              </div>
              <div class="composer-actions">
                <div class="composer-model">
                  <button ref={(element) => { modelTrigger = element; }} class="model-trigger" type="button" aria-label={t.model} title={selectedModelLabel()} aria-haspopup="dialog" aria-controls="model-picker" aria-expanded={showModelPicker()} disabled={state.models.length === 0} onClick={() => showModelPicker() ? closeModelPicker(false) : openModelPicker()} onKeyDown={(event) => {
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      openModelPicker();
                    }
                  }}>
                    <span>{selectedModelLabel()}</span><ChevronDown size={14} aria-hidden="true" />
                  </button>
                </div>
                <button class="send-button" type="button" aria-label={t.send} title={creatingSession() ? "Creating session..." : requestInFlight() ? t.working : t.send} disabled={creatingSession() || loadingSessionID() !== undefined || (page() === "session" && requestInFlight()) || (!draft().trim() && attachments().length === 0)} onClick={submit}><ArrowUp size={16} aria-hidden="true" /></button>
              </div>
            </div>
            <Show when={composeLocked()}><p class="mode-note"><AlertTriangle size={13} />{t.composeLocked}</p></Show>
          </div>
          <Show when={commandMenuOpen() && commandSuggestions().length > 0}>
            <div ref={(element) => { commandPicker = element; }} id="command-list" class="command-picker" role="listbox" aria-label="MiMoCode commands">
              <For each={commandSuggestions()}>{(command, index) => <button id={`command-option-${index()}`} classList={{ "command-option": true, "command-option--active": commandIndex() === index() }} type="button" role="option" aria-selected={commandIndex() === index()} onMouseDown={(event) => event.preventDefault()} onClick={() => selectCommand(command)}><code>/{command.name}</code><Show when={command.description}><span>{command.description}</span></Show></button>}</For>
            </div>
          </Show>
          <Show when={showModelPicker()}>
            <div ref={(element) => { modelPicker = element; }} id="model-picker" class="model-picker" role="dialog" aria-label={t.model}>
              <div class="model-options">
                <Show when={modelGroups().length > 0} fallback={<p class="picker-empty">{t.noMatchingModels}</p>}>
                  <div id="model-options" class="model-option-list" role="listbox" aria-label={t.model}><For each={modelGroups()}>{(group) => <section class="model-group"><h2>{group.providerName}</h2><For each={group.models}>{(model) => {
                    const selected = () => state.selectedModelKey === modelKey(model);
                    return <button id={modelOptionID(model)} classList={{ "model-option": true, "model-option--selected": selected() }} type="button" role="option" aria-selected={selected()} onMouseDown={(event) => event.preventDefault()} onClick={() => selectModel(model)}><span>{model.name}</span><small>{model.modelID}</small><Show when={selected()}><Check size={14} aria-label="Selected" /></Show></button>;
                  }}</For></section>}</For></div>
                </Show>
                <Show when={thinkingEfforts().length > 0}><section class="model-effort-picker" role="group" aria-label={t.thinking}><h2>{t.thinking}</h2><div><button classList={{ "model-effort-option": true, "model-effort-option--selected": !thinkingVariant() }} type="button" aria-pressed={!thinkingVariant()} onClick={() => selectThinkingEffort()}>{t.automatic}</button><For each={thinkingEfforts()}>{(option) => <button classList={{ "model-effort-option": true, "model-effort-option--selected": thinkingVariant() === option.variant }} type="button" aria-pressed={thinkingVariant() === option.variant} onClick={() => selectThinkingEffort(option.variant)}>{thinkingEffortLabel(option.effort)}</button>}</For></div></section></Show>
              </div>
            </div>
          </Show>
          <Show when={showFiles()}><div ref={(element) => { filePicker = element; }} id="file-picker" class="file-picker"><label><span>{t.files}</span><input autofocus value={fileQuery()} onInput={(event) => queryFiles(event.currentTarget.value)} placeholder={t.searchFiles} /></label><For each={fileResults()}>{(file) => <button type="button" onClick={() => attach(file)}><FilePlus2 size={14} /><span>{file.filename}</span><small>{file.mime}</small></button>}</For></div></Show>
          <div class="composer-meta"><span>{t.context}: {page() === "session" ? context() : "—"}</span><span>{page() === "session" ? selectedSession()?.title ?? t.noSession : t.newSession}</span></div>
        </footer>
      </Show>
      </>}>
        <section class="connection-error" role="alert" aria-live="assertive">
          <AlertTriangle size={24} aria-hidden="true" />
          <p>{t.connectionFailed}</p>
          <span>{state.statusMessage ?? state.error}</span>
          <div class="connection-error-actions">
            <button class="primary-button" type="button" onClick={() => vscode.postMessage({ type: "retry" })}>{t.retry}</button>
            <Show when={cliUnavailable()}><button class="text-button" type="button" onClick={() => vscode.postMessage({ type: "configure-cli" })}>{t.configureCli}</button></Show>
          </div>
        </section>
      </Show>
      <Show when={!connectionFailed()}><Show when={toast()}>{(notice) => <div class={`toast toast--${notice().level}`} role="status">{notice().message}</div>}</Show></Show>
    </div>
  );

  function canAttach(file: FileAttachment): boolean {
    const capabilities = selectedModel()?.input;
    if (!capabilities) return false;
    if (file.mime.startsWith("image/")) return capabilities.image === true;
    if (file.mime.startsWith("audio/")) return capabilities.audio === true;
    if (file.mime.startsWith("video/")) return capabilities.video === true;
    if (file.mime === "application/pdf") return capabilities.pdf === true;
    return true;
  }

  function selectedModelLabel(): string {
    const model = selectedModel();
    if (!model) return t.model;
    const effort = thinkingEfforts().find((option) => option.variant === thinkingVariant())?.effort;
    return `${model.name} · ${effort ? thinkingEffortLabel(effort) : t.automatic}`;
  }
}

function MessageCard(props: { message: Message; parts: MessagePart[]; onOpenFile: (url: string) => void }) {
  const text = createMemo(() => props.parts.filter((part) => part.type === "text").map((part) => part.text ?? "").join("") || props.message.text || "");
  return <article class={`message message--${props.message.role}`} aria-label={`${props.message.role} message`}>
    <Show when={props.message.error}>{(error) => <AgentStatusMessage activity={{ kind: "error", message: error() }} />}</Show>
    <Show when={text()}><div class="message-text" innerHTML={renderMarkdown(text())} /></Show>
    <For each={props.parts.filter((part) => part.type === "reasoning")}>
      {(part) => <details class="reasoning"><summary>{t.reasoning}</summary><pre>{part.text}</pre></details>}
    </For>
    <For each={props.parts.filter((part) => part.type === "tool")}>
      {(part) => <details class="tool-call"><summary><Bot size={14} />{part.state?.title ?? part.tool ?? "Tool"}<span>{part.state?.status ?? "pending"}</span></summary><Show when={part.state?.input}><pre>{JSON.stringify(part.state?.input, null, 2)}</pre></Show><Show when={part.state?.output}><pre>{part.state?.output}</pre></Show><Show when={part.state?.error}><p class="tool-error">{part.state?.error}</p></Show></details>}
    </For>
    <For each={props.parts.filter((part) => part.type === "file" && part.url)}>
      {(part) => <button type="button" class="file-part" onClick={() => part.url && props.onOpenFile(part.url)}><FilePlus2 size={14} />{part.filename ?? part.url}</button>}
    </For>
    <For each={props.parts.filter((part) => Boolean(partSummary(part)))}>
      {(part) => <MessageActivity part={part} />}
    </For>
  </article>;
}

function MessageActivity(props: { part: MessagePart }) {
  const summary = createMemo(() => partSummary(props.part));
  const isPatch = () => props.part.type === "patch";
  const isError = () => props.part.type === "retry" && Boolean(props.part.error);
  return <Show when={summary()}>{(label) => <div class={`message-activity message-activity--${props.part.type}`} role={isError() ? "alert" : "status"} title={props.part.error}>
    <Show when={isPatch()} fallback={<Bot size={14} aria-hidden="true" />}><FilePlus2 size={14} aria-hidden="true" /></Show>
    <span>{label()}</span>
    <Show when={isPatch() && props.part.files?.length}><small>{props.part.files!.slice(0, 2).join(", ")}{props.part.files!.length > 2 ? ` +${props.part.files!.length - 2}` : ""}</small></Show>
  </div>}</Show>;
}

function ActivityRow(props: { icon: "task" | "agent" | "workflow" | "file"; title: string; detail?: string; status?: string; error?: string }) {
  return <div class={`activity-row activity-row--${props.status ?? "default"}`} title={props.error ?? props.detail}>
    <Show when={props.icon === "task"}><ListTodo size={14} aria-hidden="true" /></Show>
    <Show when={props.icon === "agent"}><Bot size={14} aria-hidden="true" /></Show>
    <Show when={props.icon === "workflow"}><Workflow size={14} aria-hidden="true" /></Show>
    <Show when={props.icon === "file"}><FilePlus2 size={14} aria-hidden="true" /></Show>
    <span><strong>{props.title}</strong><Show when={props.detail}><small>{props.detail}</small></Show></span>
    <Show when={props.status}><em>{props.status}</em></Show>
  </div>;
}

function AgentStatusMessage(props: { activity: SessionActivity }) {
  const isError = () => props.activity.kind === "error";
  const needsAttention = () => isError() || props.activity.kind === "warning";
  const title = () => isError() ? "MiMoCode error" : props.activity.kind === "retrying" ? t.retrying : props.activity.kind === "warning" ? t.attention : t.working;
  const role = () => props.activity.kind === "error" ? "alert" : "status";
  return <div class={`agent-status-message agent-status-message--${props.activity.kind}`} role={role()} aria-live={isError() ? "assertive" : "polite"} aria-label={title()}>
    <div class="agent-status-message__icon" aria-hidden="true">
      <Show when={needsAttention()} fallback={<Bot size={16} />}><AlertTriangle size={16} /></Show>
    </div>
    <div class="agent-status-message__content">
      <strong>{title()}</strong>
      <p>{props.activity.message}</p>
    </div>
  </div>;
}

function AgentModeIcon(props: { name: string }) {
  return <Switch fallback={<Workflow size={14} aria-hidden="true" />}>
    <Match when={props.name === "build"}><Hammer size={14} aria-hidden="true" /></Match>
    <Match when={props.name === "plan"}><ListTodo size={14} aria-hidden="true" /></Match>
  </Switch>;
}

function isRenderableMessage(message: Message, parts: MessagePart[]): boolean {
  if (message.error) return true;
  if (message.text) return true;
  return parts.some((part) => {
    if (part.type === "text" || part.type === "reasoning") return Boolean(part.text);
    if (part.type === "file") return Boolean(part.url);
    return part.type === "tool" || Boolean(partSummary(part));
  });
}

function PermissionCard(props: { permission: PermissionRequest; onReply: (reply: "once" | "always" | "reject") => void }) {
  const description = createMemo(() => permissionDescription(props.permission));
  return <div class="permission-card" role="group" aria-label="Permission request"><div class="permission-title"><AlertTriangle size={15} />{description()}</div><Show when={props.permission.metadata?.diff}><pre class="permission-diff">{String(props.permission.metadata?.diff)}</pre></Show><div class="permission-actions"><button type="button" onClick={() => props.onReply("reject")}>{t.reject}</button><button type="button" onClick={() => props.onReply("always")}>{t.alwaysAllow}</button><button type="button" class="primary-button" onClick={() => props.onReply("once")}>{t.allowOnce}</button></div></div>;
}

function agentFrom(value: unknown): Agent | undefined {
  const item = record(value);
  if (typeof item.name !== "string") return undefined;
  return { name: item.name, description: typeof item.description === "string" ? item.description : undefined, mode: typeof item.mode === "string" ? item.mode : undefined };
}

function modelKey(model: ModelChoice): string {
  return `${model.providerID}/${model.modelID}`;
}

function thinkingEffortLabel(value: string): string {
  return value ? `${value.slice(0, 1).toUpperCase()}${value.slice(1)}` : value;
}

function modelOptionID(model: ModelChoice): string {
  return `model-option-${model.providerID}-${model.modelID}`;
}

function todoFrom(value: unknown): { content: string; status: string } | undefined {
  const item = record(value);
  if (typeof item.content !== "string") return undefined;
  return { content: item.content, status: typeof item.status === "string" ? item.status : "pending" };
}

function orderSessions(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
}

function sessionMeta(session: Session, activity?: SessionActivity): string {
  if (activity?.kind === "working") return "Working";
  if (activity?.kind === "retrying") return "Retrying";
  if (activity?.kind === "warning") return "Needs attention";
  if (activity?.kind === "error") return "Needs attention";
  const timestamp = session.time?.updated ?? session.time?.created ?? session.time?.completed;
  if (!timestamp) return "No activity yet";
  const date = new Date(timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp);
  return Number.isNaN(date.getTime())
    ? "No activity yet"
    : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

function agentNames(agents: Agent[]): string[] {
  const available = agents.map((agent) => agent.name).filter((name) => ["build", "plan", "compose"].includes(name));
  return available.length ? available : ["build", "plan", "compose"];
}

function agentLabel(value: string): string {
  return value === "build" ? t.build : value === "plan" ? t.plan : value === "compose" ? t.compose : value;
}

function contextUsage(messages: Message[], model?: ModelChoice): string {
  const assistant = [...messages].reverse().find((message) => message.role === "assistant" && message.tokens);
  if (!assistant?.tokens) return model?.modelID === "mimo-auto" ? "0 / 1M" : "—";
  const tokens = assistant.tokens;
  const total = (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.reasoning ?? 0) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0);
  return new Intl.NumberFormat().format(total);
}

function permissionDescription(permission: PermissionRequest): string {
  const metadata = permission.metadata ?? {};
  const target = typeof metadata.filepath === "string" ? metadata.filepath : typeof metadata.command === "string" ? metadata.command : permission.patterns?.[0];
  return `${permission.permission}${target ? ` · ${target}` : ""}`;
}

function renderMarkdown(value: string): string {
  const escaped = value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped
    .replace(/```([\s\S]*?)```/g, "<pre><code>$1</code></pre>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br />");
}
