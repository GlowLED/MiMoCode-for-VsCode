import * as path from "node:path";
import { realpath } from "node:fs/promises";
import * as vscode from "vscode";
import { resolveMimoCli } from "./runtime/cli";
import { MimoRuntimeService } from "./runtime/MimoRuntimeService";
import { isPathInsideRoot } from "./runtime/network";
import { parseWebviewMessage, type HostMessage, type WebviewMessage } from "./shared/protocol";

const VIEW_TYPE = "mimocode.chat";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = vscode.window.createOutputChannel("MiMoCode", { log: true });
  const runtime = new MimoRuntimeService();
  const provider = new MimoViewProvider(context, runtime, logger);

  context.subscriptions.push(
    logger,
    runtime,
    provider,
    vscode.window.registerWebviewViewProvider(VIEW_TYPE, provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand("mimocode.open", () => vscode.commands.executeCommand("workbench.view.extension.mimocode")),
    vscode.commands.registerCommand("mimocode.newSession", () => provider.newSession()),
    vscode.commands.registerCommand("mimocode.retryConnection", () => provider.bootstrap()),
    vscode.commands.registerCommand("mimocode.openTerminal", () => provider.openTerminal()),
    vscode.commands.registerCommand("mimocode.selectCliPath", () => provider.configureCliPath()),
    vscode.commands.registerCommand("mimocode.addSelectionToPrompt", () => provider.addSelectionToPrompt())
  );

  logger.info("MiMoCode extension activated");
}

export function deactivate(): void {}

class MimoViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view?: vscode.WebviewView;
  private activeRoot?: string;
  private pendingSelection?: Extract<HostMessage, { type: "editor-selection" }>;
  private webviewReady = false;
  private selectedSession?: { root: string; sessionID: string };
  private sessionWatch?: { root: string; sessionID: string; timer: NodeJS.Timeout; startedAt: number };
  private readonly sessionRefreshes = new Map<string, Promise<void>>();

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly runtime: MimoRuntimeService,
    private readonly logger: vscode.LogOutputChannel
  ) {
    const lastStatus = new Map<string, string>();
    this.context.subscriptions.push(
      this.runtime.onDidChangeStatus((state) => {
        const previous = lastStatus.get(state.root);
        lastStatus.set(state.root, state.status);
        this.post({
          type: "runtime-status",
          root: state.root,
          status: state.status,
          message: state.error
        });
        // Event streams do not provide a replay cursor, so resync after a reconnect.
        if (state.status === "connected" && previous === "reconnecting" && this.activeRoot === state.root) {
          void this.bootstrap(state.root);
        }
      }),
      this.runtime.onDidEvent(({ root, event }) => {
        this.post({ type: "mimo-event", root, event });
        const details = sessionEventDetails(event);
        if (!details?.sessionID || !this.isSelectedSession(root, details.sessionID)) return;
        void this.refreshSession(root, details.sessionID);
        if (details.terminal) this.stopSessionWatch(root, details.sessionID);
      }),
      vscode.workspace.onDidChangeWorkspaceFolders((change) => {
        for (const folder of change.removed) this.runtime.stop(folder.uri.fsPath);
        if (this.activeRoot && !vscode.workspace.workspaceFolders?.some((folder) => folder.uri.fsPath === this.activeRoot)) {
          this.activeRoot = undefined;
          void this.bootstrap();
        }
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        const root = editor && vscode.workspace.getWorkspaceFolder(editor.document.uri)?.uri.fsPath;
        if (root && root !== this.activeRoot && this.view) void this.bootstrap(root);
      })
    );
  }

  public dispose(): void {
    this.stopSessionWatch();
    this.sessionRefreshes.clear();
  }

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.webviewReady = false;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "out"),
        vscode.Uri.joinPath(this.context.extensionUri, "assets")
      ]
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message: unknown) => void this.receive(message));
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
        this.webviewReady = false;
        this.stopSessionWatch();
      }
    });
  }

  public async bootstrap(requestedRoot?: string): Promise<void> {
    const root = requestedRoot ?? this.activeRoot ?? this.workspaceRoot();
    if (!root) {
      this.post({ type: "error", message: "Open a folder to start MiMoCode.", recoverable: false });
      return;
    }

    this.activeRoot = root;
    try {
      await this.runtime.ensure(root);
      await this.runtime.subscribe(root);
      const data = await this.runtime.bootstrap(root);
      this.post({ type: "bootstrap-data", root, data });
    } catch (error) {
      this.report(error);
    }
  }

  public async newSession(prompt?: Extract<WebviewMessage, { type: "new-session" }>["prompt"]): Promise<void> {
    const root = this.activeRoot ?? this.workspaceRoot();
    if (!root) return void this.bootstrap();
    try {
      const session = await this.runtime.createSession(root) as { id?: string };
      await this.bootstrap(root);
      if (session.id) {
        await this.selectSession(root, session.id);
        if (prompt) {
          await this.runtime.sendPrompt({ root, sessionID: session.id, ...prompt });
          this.startSessionWatch(root, session.id);
        }
      }
    } catch (error) {
      this.report(error);
    }
  }

  public async addSelectionToPrompt(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage("MiMoCode: No active editor.");
      return;
    }
    const root = vscode.workspace.getWorkspaceFolder(editor.document.uri)?.uri.fsPath;
    if (!root) {
      void vscode.window.showInformationMessage("MiMoCode: The active file is not in this workspace.");
      return;
    }
    this.activeRoot = root;
    await vscode.commands.executeCommand("workbench.view.extension.mimocode");
    const selection = editor.selection;
    const query = selection.isEmpty ? undefined : `start=${selection.start.line + 1}&end=${selection.end.line + 1}`;
    this.pendingSelection = {
      type: "editor-selection",
      selection: {
        filename: vscode.workspace.asRelativePath(editor.document.uri, false),
        mime: "text/plain",
        url: editor.document.uri.with({ query }).toString(),
        selection: selection.isEmpty ? undefined : { startLine: selection.start.line + 1, endLine: selection.end.line + 1 }
      }
    };
    this.flushPendingSelection();
  }

  public async openTerminal(root = this.activeRoot ?? this.workspaceRoot()): Promise<void> {
    if (!root) {
      void vscode.window.showInformationMessage("MiMoCode: Open a folder before starting the terminal.");
      return;
    }
    const cliPath = vscode.workspace.getConfiguration("mimocode", vscode.Uri.file(root)).get<string>("cliPath", "mimo");
    const resolved = await resolveMimoCli(cliPath, root);
    const terminal = vscode.window.createTerminal({ name: "MiMoCode", cwd: root, iconPath: new vscode.ThemeIcon("terminal") });
    terminal.show();
    terminal.sendText(resolved.executable ?? cliPath, true);
  }

  public async configureCliPath(): Promise<void> {
    const root = this.activeRoot ?? this.workspaceRoot();
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: "Use MiMoCode CLI",
      title: "Select MiMoCode CLI executable"
    });
    const executable = picked?.[0];
    if (!executable) return;

    const resource = root ? vscode.Uri.file(root) : undefined;
    const target = root ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Global;
    const validated = await resolveMimoCli(executable.fsPath, root ?? executable.fsPath);
    if (!validated.executable) {
      void vscode.window.showErrorMessage("MiMoCode: The selected file is not an executable CLI.");
      return;
    }
    await vscode.workspace.getConfiguration("mimocode", resource).update("cliPath", validated.executable, target);
    this.post({ type: "toast", message: `MiMoCode CLI set to ${validated.executable}`, level: "success" });
    if (root) {
      await this.runtime.retry(root);
      await this.bootstrap(root);
    }
  }

  private async receive(raw: unknown): Promise<void> {
    const message = parseWebviewMessage(raw);
    if (!message) {
      this.post({ type: "error", message: "MiMoCode received an invalid webview message.", recoverable: true });
      return;
    }

    try {
      switch (message.type) {
        case "ready":
          this.webviewReady = true;
          await this.bootstrap();
          this.flushPendingSelection();
          return;
        case "bootstrap":
          await this.bootstrap(message.root ? this.requireWorkspaceRoot(message.root) : undefined);
          return;
        case "retry":
          if (this.activeRoot) await this.runtime.retry(this.activeRoot);
          await this.bootstrap();
          return;
        case "new-session":
          this.activeRoot = this.requireWorkspaceRoot(message.root);
          for (const attachment of message.prompt?.attachments ?? []) await this.requireWorkspaceFile(attachment.url, this.activeRoot);
          await this.newSession(message.prompt);
          return;
        case "select-session":
          await this.selectSession(this.requireWorkspaceRoot(message.root), message.sessionID);
          return;
        case "send-prompt": {
          const root = this.requireWorkspaceRoot(message.root);
          for (const attachment of message.attachments) await this.requireWorkspaceFile(attachment.url, root);
          this.activeRoot = root;
          await this.runtime.sendPrompt({ ...message, root });
          this.startSessionWatch(root, message.sessionID);
          return;
        }
        case "execute-command": {
          const root = this.requireWorkspaceRoot(message.root);
          for (const attachment of message.attachments) await this.requireWorkspaceFile(attachment.url, root);
          this.activeRoot = root;
          await this.runtime.executeCommand({ ...message, root });
          this.startSessionWatch(root, message.sessionID);
          return;
        }
        case "list-files": {
          const root = this.requireWorkspaceRoot(message.root);
          await this.listFiles(root, message.query);
          return;
        }
        case "permission-reply":
          await this.runtime.replyToPermission({ ...message, root: this.requireWorkspaceRoot(message.root) });
          return;
        case "open-file":
          await this.openFile(message.url);
          return;
        case "open-terminal":
          await this.openTerminal(message.root ? this.requireWorkspaceRoot(message.root) : undefined);
          return;
        case "select-vscode-theme":
          await vscode.commands.executeCommand("workbench.action.selectTheme");
          return;
        case "configure-cli":
          await this.configureCliPath();
          return;
        case "open-token-plan":
          await vscode.env.openExternal(vscode.Uri.parse("https://platform.xiaomimimo.com/token-plan"));
          return;
      }
    } catch (error) {
      this.report(error);
    }
  }

  private async selectSession(root: string, sessionID: string): Promise<void> {
    this.activeRoot = root;
    this.selectedSession = { root, sessionID };
    await this.refreshSession(root, sessionID, true);
  }

  private startSessionWatch(root: string, sessionID: string): void {
    if (!this.isSelectedSession(root, sessionID)) return;
    this.stopSessionWatch();
    const watch = {
      root,
      sessionID,
      startedAt: Date.now(),
      timer: setInterval(() => {
        if (!this.isSelectedSession(root, sessionID) || Date.now() - watch.startedAt > 5 * 60_000) {
          this.stopSessionWatch(root, sessionID);
          return;
        }
        void this.refreshSession(root, sessionID);
      }, 350)
    };
    this.sessionWatch = watch;
    void this.refreshSession(root, sessionID);
  }

  private stopSessionWatch(root?: string, sessionID?: string): void {
    const watch = this.sessionWatch;
    if (!watch) return;
    if (root && sessionID && (watch.root !== root || watch.sessionID !== sessionID)) return;
    clearInterval(watch.timer);
    this.sessionWatch = undefined;
  }

  private isSelectedSession(root: string, sessionID: string): boolean {
    return this.selectedSession?.root === root && this.selectedSession.sessionID === sessionID;
  }

  private async refreshSession(root: string, sessionID: string, reportFailure = false): Promise<void> {
    if (!this.isSelectedSession(root, sessionID)) return;
    const key = `${root}:${sessionID}`;
    const pending = this.sessionRefreshes.get(key);
    if (pending) return pending;

    const refresh = this.runtime.loadSession(root, sessionID)
      .then((data) => {
        if (!this.isSelectedSession(root, sessionID)) return;
        this.post({ type: "session-data", root, sessionID, data });
        const watch = this.sessionWatch;
        const allowIdle = !watch
          || watch.root !== root
          || watch.sessionID !== sessionID
          || Date.now() - watch.startedAt >= 2_000;
        if (isSessionSettled(data.status, data.messages, sessionID, allowIdle)) this.stopSessionWatch(root, sessionID);
      })
      .catch((error) => {
        if (reportFailure) this.report(error);
      })
      .finally(() => this.sessionRefreshes.delete(key));
    this.sessionRefreshes.set(key, refresh);
    return refresh;
  }

  private async listFiles(root: string, query: string): Promise<void> {
    const relative = new vscode.RelativePattern(vscode.Uri.file(root), "**/*");
    const lower = query.toLowerCase();
    const uris = await vscode.workspace.findFiles(relative, "**/{node_modules,.git,dist,out}/**", 2500);
    const files = uris
      .filter((uri) => vscode.workspace.asRelativePath(uri, false).toLowerCase().includes(lower))
      .slice(0, 40)
      .map((uri) => ({
        filename: vscode.workspace.asRelativePath(uri, false),
        mime: mimeForPath(uri.fsPath),
        url: uri.toString()
      }));
    this.post({ type: "file-results", query, files });
  }

  private async openFile(value: string): Promise<void> {
    const uri = vscode.Uri.parse(value);
    await this.requireWorkspaceFile(value, this.activeRoot ?? this.workspaceRoot());
    const document = await vscode.workspace.openTextDocument(uri.with({ query: undefined }));
    const editor = await vscode.window.showTextDocument(document, { preview: true });
    const params = new URLSearchParams(uri.query);
    const start = Number(params.get("start"));
    const end = Number(params.get("end") ?? start);
    if (Number.isInteger(start) && start > 0) {
      const range = new vscode.Range(Math.max(start - 1, 0), 0, Math.max(end - 1, 0), 0);
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    }
  }

  private workspaceRoot(): string | undefined {
    const active = vscode.window.activeTextEditor;
    const activeFolder = active && vscode.workspace.getWorkspaceFolder(active.document.uri);
    return activeFolder?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private requireWorkspaceRoot(root: string): string {
    const requested = path.resolve(root);
    const match = vscode.workspace.workspaceFolders?.find((folder) => path.resolve(folder.uri.fsPath) === requested);
    if (!match) throw new Error("MiMoCode can only access an open workspace folder.");
    return match.uri.fsPath;
  }

  private async requireWorkspaceFile(value: string, root: string | undefined): Promise<void> {
    if (!root) throw new Error("MiMoCode can only open files in the active workspace.");
    const uri = vscode.Uri.parse(value);
    if (uri.scheme !== "file" || uri.authority || !isPathInsideRoot(root, uri.fsPath)) {
      throw new Error("MiMoCode can only access files inside the selected workspace folder.");
    }
    try {
      const [realRoot, realFile] = await Promise.all([realpath(root), realpath(uri.fsPath)]);
      if (!isPathInsideRoot(realRoot, realFile)) throw new Error("outside workspace");
    } catch {
      throw new Error("MiMoCode can only access existing files inside the selected workspace folder.");
    }
  }

  private post(message: HostMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private flushPendingSelection(): void {
    if (!this.pendingSelection || !this.view || !this.webviewReady) return;
    this.post(this.pendingSelection);
    this.pendingSelection = undefined;
  }

  private report(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error(message);
    this.post({ type: "error", message, recoverable: true });
    if (/Unable to find MiMoCode CLI/i.test(message)) {
      void vscode.window.showWarningMessage(
        "MiMoCode CLI was not found.",
        "Select CLI",
        "Open Install Guide"
      ).then(async (choice) => {
        if (choice === "Select CLI") await this.configureCliPath();
        if (choice === "Open Install Guide") await vscode.env.openExternal(vscode.Uri.parse("https://github.com/XiaomiMiMo/MiMo-Code#installation"));
      });
    }
  }

  private html(webview: vscode.Webview): string {
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "out", "main.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "out", "main.css"));
    const nonce = randomNonce();
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <link rel="stylesheet" href="${style}" />
  <title>MiMoCode</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" type="module" src="${script}"></script>
</body>
</html>`;
  }
}

function mimeForPath(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(extension)) return `image/${extension === ".jpg" ? "jpeg" : extension.slice(1)}`;
  if (extension === ".pdf") return "application/pdf";
  if ([".mp3", ".wav", ".m4a", ".ogg"].includes(extension)) return "audio/*";
  if ([".mp4", ".mov", ".webm"].includes(extension)) return "video/*";
  return "text/plain";
}

function sessionEventDetails(value: unknown): { sessionID?: string; terminal: boolean } | undefined {
  const outer = objectRecord(value);
  const event = typeof outer.type === "string" ? outer : objectRecord(outer.payload);
  if (typeof event.type !== "string") return undefined;
  const properties = objectRecord(event.properties);
  const info = objectRecord(properties.info);
  const sessionID = typeof properties.sessionID === "string"
    ? properties.sessionID
    : typeof info.sessionID === "string" ? info.sessionID : undefined;
  const status = objectRecord(properties.status);
  return {
    sessionID,
    terminal: event.type === "session.error"
      || event.type === "session.idle"
      || (event.type === "session.status" && status.type === "idle")
  };
}

function isSessionSettled(statusValue: unknown, messages: unknown[], sessionID: string, allowIdle: boolean): boolean {
  const latest = messages.at(-1);
  const latestInfo = objectRecord(objectRecord(latest).info ?? latest);
  if (latestInfo.error !== undefined && latestInfo.error !== null) return true;
  const status = objectRecord(objectRecord(statusValue)[sessionID]);
  return allowIdle && status.type === "idle";
}

function objectRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function randomNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}
