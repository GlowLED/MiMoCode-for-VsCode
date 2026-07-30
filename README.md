# MiMoCode for VS Code

MiMoCode is a native Visual Studio Code sidebar for the local [MiMo Code](https://github.com/XiaomiMiMo/MiMo-Code) CLI. It keeps the MiMo service, authentication, permissions, and workspace context under VS Code's extension host while providing a compact SolidJS chat workspace in the Secondary Side Bar.

## What it includes

- A MiMoCode Secondary Side Bar container with sessions, Build/Plan/Compose agent modes, models, context usage, streaming messages, tool calls, reasoning blocks, todos, child sessions, and pending permission cards.
- Local `mimo serve` lifecycle management: one lazy loopback service per workspace root, automatic stop on extension disposal or workspace removal, and SSE reconnect plus snapshot resync.
- Workspace-only input: current editor selections and `@`-style workspace file search. Image, audio, video, and PDF attachments are enabled only when the chosen model reports that capability.
- Explicit permission answers only: allow once, always allow, or reject. It never enables “skip all permissions”.
- MiMo Auto status, while leaving login, Token Plan, Token Efficient, Max Mode, and orchestrator behavior to the CLI and service.

## Prerequisites

1. VS Code 1.104 or newer (required for extension-contributed Secondary Side Bar containers).
2. MiMoCode CLI installed and authenticated. Run `mimo auth login` in a terminal before using the extension.
3. A folder opened in VS Code. Remote MiMo services are deliberately unsupported in this release.

Install the CLI through either official method:

```bash
# macOS/Linux official installer
curl -fsSL https://mimo.xiaomi.com/install | bash

# npm global install (all platforms)
npm install -g @mimo-ai/cli
```

The resolver first uses `mimocode.cliPath` and the VS Code `PATH`, then checks the official installer path plus common npm, pnpm, Yarn, Bun, Volta, nvm, fnm, asdf, mise, Homebrew, and Windows global-bin locations. Use **MiMoCode: Select MiMoCode CLI Executable** when the CLI is custom-installed or exposed only through a shell alias/function. The selected path is saved at workspace scope when a folder is open. The extension does not store API keys, OAuth tokens, or remote service URLs.

## Install

Build a VSIX from this repository:

```bash
pnpm install
pnpm package
code --install-extension mimocode-vscode-0.1.6.vsix
```

Then select the MiMoCode icon in the editor title bar to open the Secondary Side Bar and create a session. Use the command palette for **Open MiMoCode**, **New MiMoCode Session**, **Add Selection to MiMoCode Prompt**, or **Open MiMoCode Terminal**.

## Development and verification

```bash
pnpm watch
pnpm check
pnpm test
pnpm build
pnpm package
```

The extension is intentionally pinned to `@mimo-ai/sdk@0.1.8`. The newer 0.1.9 npm archive omits generated v2 runtime files, while 0.1.8 ships the complete v2 client required for a packaged extension. Upgrade only after verifying the published SDK archive and its API contract.

## Security model

- The Webview never talks to MiMo directly. All SDK, REST, and SSE calls are made by the extension host.
- Services are started only with `mimo serve --hostname 127.0.0.1 --port 0`; non-loopback addresses, credentials in URLs, and arbitrary Webview URLs are rejected.
- Every SDK request carries the URL-encoded `x-mimocode-directory` context. Webview messages may target only an open VS Code workspace root and `file:` attachments inside that root.
- Permission requests remain server-authoritative. The sidebar exposes only the service's current pending requests and cannot create unattended background tasks.

## Troubleshooting

- **CLI not found / service did not start:** check `mimo --version`, set `mimocode.cliPath`, then choose **Retry MiMoCode Connection**.
- **Directory rejected:** open the intended project folder directly in VS Code and start a new session in that folder. Attachments outside the selected workspace are rejected intentionally.
- **Not authenticated or MiMo Auto is busy:** choose **Open MiMoCode Terminal** and run `mimo auth login`; rate-limit messages are shown exactly as returned by the service.
- **Events stopped updating:** the extension reconnects and reloads the session snapshot automatically. You can also run **Retry MiMoCode Connection**.

## License and trademarks

This extension is MIT-licensed. MiMoCode and Xiaomi MiMo marks belong to their respective owners; confirm the current upstream trademark policy before publishing to a marketplace.
