import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

export interface CliResolution {
  executable?: string;
  searched: string[];
}

type ExecutableCheck = (candidate: string) => Promise<boolean>;
type PathApi = typeof path.posix;

/**
 * Finder-launched VS Code does not inherit a user's interactive shell PATH.
 * Look only in the user's known tool locations and never run a shell command
 * while resolving an executable. A custom install remains explicit through
 * mimocode.cliPath or the extension's Select CLI command.
 */
export async function resolveMimoCli(
  configured: string,
  workingDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
  platform = process.platform,
  check: ExecutableCheck = isExecutable
): Promise<CliResolution> {
  const requested = configured.trim();
  if (!requested) return { searched: [] };
  const pathApi = pathFor(platform);

  const names = executableNames(requested, platform);
  if (pathApi.isAbsolute(requested) || requested.includes("/") || requested.includes("\\")) {
    const base = pathApi.resolve(workingDirectory, requested);
    const searched = executableVariants(base, pathApi, platform);
    return firstExecutable(searched, check);
  }

  const directories = await cliDirectories(environment, homeDirectory, platform);
  const environmentCandidates = [environment.MIMOCODE_CLI_PATH, environment.MIMO_CLI_PATH]
    .flatMap((candidate) => candidate ? executableVariants(pathApi.resolve(workingDirectory, candidate), pathApi, platform) : []);
  const searched = [...environmentCandidates, ...directories.flatMap((directory) => names.map((name) => pathApi.join(directory, name)))];
  return firstExecutable(searched, check);
}

/** Exported for deterministic tests and to keep supported install layouts visible. */
export async function cliDirectories(
  environment: NodeJS.ProcessEnv,
  homeDirectory: string,
  platform: string
): Promise<string[]> {
  const pathApi = pathFor(platform);
  const delimiter = platform === "win32" ? ";" : ":";
  const pathDirectories = (environment.PATH ?? environment.Path ?? "").split(delimiter).filter(Boolean);
  const configuredDirectories = [
    environment.PNPM_HOME,
    environment.npm_config_prefix,
    environment.NPM_CONFIG_PREFIX,
    environment.YARN_GLOBAL_FOLDER,
    environment.BUN_INSTALL,
    environment.VOLTA_HOME,
    environment.NVM_BIN,
    environment.FNM_MULTISHELL_PATH,
    environment.ASDF_DATA_DIR ? pathApi.join(environment.ASDF_DATA_DIR, "shims") : undefined,
    environment.MISE_DATA_DIR ? pathApi.join(environment.MISE_DATA_DIR, "shims") : undefined
  ].flatMap((value) => value ? prefixDirectories(value, platform, pathApi) : []);

  const commonDirectories = platform === "win32"
    ? windowsDirectories(environment, homeDirectory, pathApi)
    : unixDirectories(homeDirectory, platform, pathApi);
  const versionManagerDirectories = platform === "win32" ? [] : await discoverVersionManagerDirectories(homeDirectory, pathApi);
  return unique([...pathDirectories, ...configuredDirectories, ...commonDirectories, ...versionManagerDirectories]);
}

function unixDirectories(home: string, platform: string, pathApi: PathApi): string[] {
  const directories = [
    pathApi.join(home, ".mimocode", "bin"), // Official https://mimo.xiaomi.com/install script
    pathApi.join(home, ".local", "bin"),
    pathApi.join(home, ".local", "share", "pnpm"),
    pathApi.join(home, ".pnpm"),
    pathApi.join(home, ".npm-global", "bin"),
    pathApi.join(home, ".yarn", "bin"),
    pathApi.join(home, ".config", "yarn", "global", "node_modules", ".bin"),
    pathApi.join(home, ".bun", "bin"),
    pathApi.join(home, ".cargo", "bin"),
    pathApi.join(home, ".volta", "bin"),
    pathApi.join(home, ".asdf", "shims"),
    pathApi.join(home, ".mise", "shims"),
    pathApi.join(home, ".local", "share", "mise", "shims"),
    pathApi.join(home, ".nodenv", "shims"),
    "/usr/local/bin"
  ];
  if (platform === "darwin") directories.push("/opt/homebrew/bin", pathApi.join(home, "Library", "pnpm"));
  return directories;
}

function windowsDirectories(environment: NodeJS.ProcessEnv, home: string, pathApi: PathApi): string[] {
  const appData = environment.APPDATA ?? pathApi.join(home, "AppData", "Roaming");
  const localAppData = environment.LOCALAPPDATA ?? pathApi.join(home, "AppData", "Local");
  return [
    pathApi.join(home, ".mimocode", "bin"),
    pathApi.join(appData, "npm"),
    pathApi.join(localAppData, "pnpm"),
    pathApi.join(home, ".volta", "bin"),
    pathApi.join(home, ".bun", "bin"),
    pathApi.join(home, ".yarn", "bin"),
    pathApi.join(home, ".local", "bin")
  ];
}

async function discoverVersionManagerDirectories(home: string, pathApi: PathApi): Promise<string[]> {
  const layouts = [
    { base: pathApi.join(home, ".nvm", "versions", "node"), suffix: ["bin"] },
    { base: pathApi.join(home, ".local", "share", "fnm", "node-versions"), suffix: ["installation", "bin"] },
    { base: pathApi.join(home, ".local", "share", "mise", "installs", "node"), suffix: ["bin"] },
    { base: pathApi.join(home, ".mise", "installs", "node"), suffix: ["bin"] },
    { base: pathApi.join(home, ".asdf", "installs", "nodejs"), suffix: ["bin"] }
  ];
  const found = await Promise.all(layouts.map(async ({ base, suffix }) => {
    try {
      const entries = await readdir(base, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => pathApi.join(base, entry.name, ...suffix));
    } catch {
      return [];
    }
  }));
  return found.flat();
}

function prefixDirectories(prefix: string, platform: string, pathApi: PathApi): string[] {
  return platform === "win32" ? [prefix] : [pathApi.join(prefix, "bin"), prefix];
}

function executableNames(requested: string, platform: string): string[] {
  if (platform !== "win32" || path.win32.extname(requested)) return [requested];
  return [requested, `${requested}.exe`, `${requested}.cmd`, `${requested}.bat`];
}

function executableVariants(candidate: string, pathApi: PathApi, platform: string): string[] {
  if (platform !== "win32" || pathApi.extname(candidate)) return [candidate];
  return [candidate, `${candidate}.exe`, `${candidate}.cmd`, `${candidate}.bat`];
}

function pathFor(platform: string): PathApi {
  return platform === "win32" ? path.win32 : path.posix;
}

async function firstExecutable(searched: string[], check: ExecutableCheck): Promise<CliResolution> {
  const uniquePaths = unique(searched);
  for (const candidate of uniquePaths) {
    if (await check(candidate)) return { executable: candidate, searched: uniquePaths };
  }
  return { searched: uniquePaths };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
