import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { cliDirectories, resolveMimoCli } from "../../src/runtime/cli";

describe("resolveMimoCli", () => {
  it("finds the official installer directory when VS Code has a limited PATH", async () => {
    const home = "/Users/tester";
    const expected = path.join(home, ".mimocode", "bin", "mimo");
    const result = await resolveMimoCli("mimo", "/workspace", { PATH: "/usr/bin" }, home, "darwin", async (candidate) => candidate === expected);

    expect(result.executable).toBe(expected);
    expect(result.searched).toContain(expected);
  });

  it("honors an explicit configured executable without searching other directories", async () => {
    const result = await resolveMimoCli("tools/mimo", "/workspace", {}, "/Users/tester", "darwin", async () => false);

    expect(result.executable).toBeUndefined();
    expect(result.searched).toEqual([path.resolve("/workspace", "tools/mimo")]);
  });

  it("checks common npm and package-manager global bin locations", async () => {
    const home = "/Users/tester";
    const directories = await cliDirectories({
      PATH: "/usr/bin",
      PNPM_HOME: "/Users/tester/Library/pnpm",
      npm_config_prefix: "/Users/tester/.npm-packages"
    }, home, "darwin");

    expect(directories).toEqual(expect.arrayContaining([
      "/Users/tester/Library/pnpm",
      "/Users/tester/.npm-packages/bin",
      path.join(home, ".yarn", "bin"),
      path.join(home, ".bun", "bin"),
      path.join(home, ".volta", "bin"),
      "/opt/homebrew/bin"
    ]));
  });

  it("probes Windows npm and pnpm executable variants", async () => {
    const appData = "C:\\Users\\tester\\AppData\\Roaming";
    const expected = path.win32.join(appData, "npm", "mimo.cmd");
    const result = await resolveMimoCli(
      "mimo",
      "C:\\workspace",
      { APPDATA: appData, LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
      "C:\\Users\\tester",
      "win32",
      async (candidate) => candidate === expected
    );

    expect(result.executable).toBe(expected);
  });

  it("prioritizes an explicit environment override for managed environments", async () => {
    const expected = "/custom-tools/mimo";
    const result = await resolveMimoCli(
      "mimo",
      "/workspace",
      { MIMOCODE_CLI_PATH: expected, PATH: "/usr/bin" },
      "/Users/tester",
      "darwin",
      async (candidate) => candidate === expected
    );

    expect(result.executable).toBe(expected);
    expect(result.searched[0]).toBe(expected);
  });

  it("resolves a relative environment override from the workspace", async () => {
    const expected = "/workspace/tools/mimo";
    const result = await resolveMimoCli(
      "mimo",
      "/workspace",
      { MIMO_CLI_PATH: "tools/mimo" },
      "/Users/tester",
      "darwin",
      async (candidate) => candidate === expected
    );

    expect(result.executable).toBe(expected);
  });
});
