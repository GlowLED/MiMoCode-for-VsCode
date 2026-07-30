import { createOpencodeClient, type OpencodeClient } from "@mimo-ai/sdk/v2";
import { spawn, type ChildProcess } from "node:child_process";
import * as vscode from "vscode";
import { resolveMimoCli } from "./cli";
import { encodedDirectoryHeader, isLoopbackServiceUrl, SseFrameDecoder } from "./network";
import type { BootstrapData, RuntimeEntry, RuntimeState, SessionData } from "./types";

type ManagedRuntime = RuntimeEntry & {
  process?: ChildProcess;
  ready?: Promise<ManagedRuntime>;
  sseAbort?: AbortController;
};

const PROMPT_ACCEPTANCE_TIMEOUT_MS = 15_000;

export interface RuntimeEvent {
  root: string;
  event: unknown;
}

export class MimoRuntimeService implements vscode.Disposable {
  private readonly runtimes = new Map<string, ManagedRuntime>();
  private readonly statusEmitter = new vscode.EventEmitter<RuntimeState>();
  private readonly eventEmitter = new vscode.EventEmitter<RuntimeEvent>();

  public readonly onDidChangeStatus = this.statusEmitter.event;
  public readonly onDidEvent = this.eventEmitter.event;

  public async ensure(root: string): Promise<RuntimeEntry> {
    const existing = this.runtimes.get(root);
    if (existing?.status === "connected") return existing;
    if (existing?.ready) return existing.ready;

    const runtime: ManagedRuntime = existing ?? { root, status: "idle" };
    runtime.status = "starting";
    runtime.error = undefined;
    this.runtimes.set(root, runtime);
    this.emitStatus(runtime);

    runtime.ready = this.start(runtime).finally(() => {
      runtime.ready = undefined;
    });
    return runtime.ready;
  }

  public getState(root: string): RuntimeEntry | undefined {
    return this.runtimes.get(root);
  }

  public async retry(root: string): Promise<RuntimeEntry> {
    this.stop(root);
    return this.ensure(root);
  }

  public async bootstrap(root: string): Promise<BootstrapData> {
    const runtime = await this.readyRuntime(root);
    const start = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const [sessions, providers, commands, agents, permissions, config, sessionStatus] = await Promise.all([
      runtime.client.session.list({ start, roots: true }),
      runtime.client.provider.list(),
      runtime.client.command.list(),
      runtime.client.app.agents(),
      runtime.client.permission.list(),
      runtime.client.config.get(),
      runtime.client.session.status()
    ]);

    return {
      sessions: dataOr(sessions, []),
      providers: dataOr(providers, { all: [], default: {}, connected: [] }),
      commands: dataOr(commands, []),
      agents: dataOr(agents, []),
      permissions: dataOr(permissions, []),
      config: dataOr(config, {}),
      sessionStatus: dataOr(sessionStatus, {})
    };
  }

  public async createSession(root: string): Promise<unknown> {
    const runtime = await this.readyRuntime(root);
    const result = await runtime.client.session.create();
    return requiredData(result, "MiMoCode could not create a session.");
  }

  public async loadSession(root: string, sessionID: string): Promise<SessionData> {
    const runtime = await this.readyRuntime(root);
    const [session, messages, todos, children, actors, status] = await Promise.all([
      runtime.client.session.get({ sessionID }),
      runtime.client.session.messages({ sessionID, limit: 100, agent_id: "*" }),
      runtime.client.session.todo({ sessionID }),
      runtime.client.session.children({ sessionID, visible: true }),
      runtime.client.session.actors({ sessionID }),
      runtime.client.session.status()
    ]);

    return {
      session: requiredData(session, "MiMoCode session no longer exists."),
      messages: dataOr(messages, []),
      todos: dataOr(todos, []),
      children: dataOr(children, []),
      actors: dataOr(actors, {}),
      status: dataOr(status, {})
    };
  }

  public async sendPrompt(input: {
    root: string;
    sessionID: string;
    text: string;
    agent?: string;
    variant?: string;
    model?: { providerID: string; modelID: string };
    attachments: Array<{ filename: string; mime: string; url: string }>;
  }): Promise<void> {
    const runtime = await this.readyRuntime(input.root);
    const parts = [
      ...(input.text.trim() ? [{ type: "text" as const, text: input.text }] : []),
      ...input.attachments.map((attachment) => ({ type: "file" as const, ...attachment }))
    ];

    if (parts.length === 0) return;

    const result = await runtime.client.session.promptAsync({
      sessionID: input.sessionID,
      agent: input.agent,
      variant: input.variant,
      model: input.model,
      parts
    }, { signal: AbortSignal.timeout(PROMPT_ACCEPTANCE_TIMEOUT_MS) });
    if (result.error) throw new Error(errorMessage(result.error));
  }

  public async executeCommand(input: {
    root: string;
    sessionID: string;
    command: string;
    arguments: string;
    agent?: string;
    variant?: string;
    model?: { providerID: string; modelID: string };
    attachments: Array<{ filename: string; mime: string; url: string }>;
  }): Promise<void> {
    const command = input.command.trim().replace(/^\/+/, "");
    if (!command) return;

    const runtime = await this.readyRuntime(input.root);
    const result = await runtime.client.session.command({
      sessionID: input.sessionID,
      command,
      arguments: input.arguments,
      agent: input.agent,
      variant: input.variant,
      model: input.model ? `${input.model.providerID}/${input.model.modelID}` : undefined,
      parts: input.attachments.map((attachment) => ({ type: "file" as const, ...attachment }))
    });
    if (result.error) throw new Error(errorMessage(result.error));
  }

  public async replyToPermission(input: {
    root: string;
    requestID: string;
    reply: "once" | "always" | "reject";
  }): Promise<void> {
    const runtime = await this.readyRuntime(input.root);
    const result = await runtime.client.permission.reply({
      requestID: input.requestID,
      reply: input.reply
    });
    if (result.error) throw new Error(errorMessage(result.error));
  }

  public async subscribe(root: string): Promise<void> {
    const runtime = await this.readyRuntime(root);
    if (runtime.sseAbort) return;
    runtime.sseAbort = new AbortController();
    void this.consumeEvents(runtime, runtime.sseAbort.signal);
  }

  public stop(root: string): void {
    const runtime = this.runtimes.get(root);
    if (!runtime) return;
    runtime.sseAbort?.abort();
    runtime.sseAbort = undefined;
    runtime.process?.kill();
    runtime.process = undefined;
    runtime.client = undefined;
    runtime.url = undefined;
    runtime.status = "idle";
    this.emitStatus(runtime);
  }

  public dispose(): void {
    for (const root of this.runtimes.keys()) this.stop(root);
    this.statusEmitter.dispose();
    this.eventEmitter.dispose();
  }

  private async start(runtime: ManagedRuntime): Promise<ManagedRuntime> {
    const resource = vscode.Uri.file(runtime.root);
    const configuration = vscode.workspace.getConfiguration("mimocode", resource);
    const cliPath = configuration.get<string>("cliPath", "mimo");
    const timeout = configuration.get<number>("serverStartupTimeout", 15_000);

    const resolvedCli = await resolveMimoCli(cliPath, runtime.root);
    const executable = resolvedCli.executable;
    if (!executable) {
      const inspected = resolvedCli.searched.length ? ` Checked ${resolvedCli.searched.slice(0, 5).join(", ")}.` : "";
      const message = `Unable to find MiMoCode CLI '${cliPath}'. Install it with 'curl -fsSL https://mimo.xiaomi.com/install | bash' or 'npm install -g @mimo-ai/cli', then retry; alternatively select the executable with MiMoCode: Select MiMoCode CLI Executable.${inspected}`;
      runtime.status = "error";
      runtime.error = message;
      this.emitStatus(runtime);
      throw new Error(message);
    }

    return new Promise<ManagedRuntime>((resolve, reject) => {
      const child = spawn(executable, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
        cwd: runtime.root,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"]
      });
      runtime.process = child;

      let settled = false;
      const complete = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const fail = (message: string) => {
        complete(() => {
          runtime.status = "error";
          runtime.error = message;
          runtime.process?.kill();
          runtime.process = undefined;
          this.emitStatus(runtime);
          reject(new Error(message));
        });
      };
      const consumeOutput = (value: Buffer) => {
        const text = value.toString();
        const match = /mimocode server listening on (http:\/\/[^\s]+)/i.exec(text);
        if (!match?.[1]) return;
        const url = match[1];
        if (!isLoopbackServiceUrl(url)) {
          fail("MiMoCode service did not bind to a safe loopback address.");
          return;
        }
        complete(() => {
          runtime.url = url;
          runtime.client = createOpencodeClient({ baseUrl: url, directory: runtime.root });
          runtime.status = "connected";
          this.emitStatus(runtime);
          resolve(runtime);
        });
      };
      const timer = setTimeout(() => fail(`MiMoCode did not start within ${timeout}ms.`), timeout);

      child.stdout?.on("data", consumeOutput);
      child.stderr?.on("data", consumeOutput);
      child.once("error", (error) => fail(`Unable to start '${executable}': ${error.message}`));
      child.once("exit", (code, signal) => {
        if (!settled) {
          fail(`MiMoCode service exited before startup (${signal ?? code ?? "unknown"}).`);
          return;
        }
        if (runtime.process === child) {
          runtime.process = undefined;
          runtime.client = undefined;
          runtime.url = undefined;
          runtime.sseAbort?.abort();
          runtime.sseAbort = undefined;
          runtime.status = "error";
          runtime.error = `MiMoCode service stopped (${signal ?? code ?? "unknown"}).`;
          this.emitStatus(runtime);
        }
      });
    });
  }

  private async readyRuntime(root: string): Promise<ManagedRuntime & { client: OpencodeClient; url: string }> {
    const runtime = (await this.ensure(root)) as ManagedRuntime;
    if (!runtime.client || !runtime.url) throw new Error("MiMoCode service is not connected.");
    return runtime as ManagedRuntime & { client: OpencodeClient; url: string };
  }

  private async consumeEvents(runtime: ManagedRuntime & { url: string }, signal: AbortSignal): Promise<void> {
    let delay = 500;
    while (!signal.aborted) {
      try {
        runtime.status = "reconnecting";
        this.emitStatus(runtime);
        const url = new URL("/event", runtime.url);
        url.searchParams.set("directory", runtime.root);
        const response = await fetch(url, {
          headers: {
            Accept: "text/event-stream",
            "x-mimocode-directory": encodedDirectoryHeader(runtime.root)
          },
          signal
        });
        if (!response.ok || !response.body) throw new Error(`Event stream failed (${response.status}).`);

        runtime.status = "connected";
        this.emitStatus(runtime);
        delay = 500;
        await readSse(response.body, (data) => {
          try {
            this.eventEmitter.fire({ root: runtime.root, event: JSON.parse(data) });
          } catch {
            // Ignore non-JSON heartbeats or malformed third-party plugin output.
          }
        }, signal);
      } catch (error) {
        if (signal.aborted) break;
        runtime.status = "reconnecting";
        runtime.error = error instanceof Error ? error.message : String(error);
        this.emitStatus(runtime);
        await sleep(delay, signal);
        delay = Math.min(delay * 2, 8_000);
      }
    }
  }

  private emitStatus(runtime: RuntimeState): void {
    this.statusEmitter.fire({ ...runtime });
  }
}

function dataOr<T>(result: { data?: T; error?: unknown }, fallback: T): T {
  if (result.error) throw new Error(errorMessage(result.error));
  return result.data ?? fallback;
}

function requiredData<T>(result: { data?: T; error?: unknown }, message: string): T {
  if (result.error) throw new Error(errorMessage(result.error));
  if (result.data === undefined) throw new Error(message);
  return result.data;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
}

async function readSse(stream: ReadableStream<Uint8Array>, onData: (data: string) => void, signal: AbortSignal): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const frames = new SseFrameDecoder();

  try {
    while (!signal.aborted) {
      const next = await reader.read();
      if (next.done) {
        for (const data of frames.push(decoder.decode())) onData(data);
        for (const data of frames.finish()) onData(data);
        return;
      }
      for (const data of frames.push(decoder.decode(next.value, { stream: true }))) onData(data);
    }
  } finally {
    reader.releaseLock();
  }
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
