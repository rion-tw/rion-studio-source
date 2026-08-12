import { access } from "node:fs/promises";
import { resolve } from "node:path";

import { spawnPlatformCommand } from "./spawnPlatformCommand.mjs";

const root = resolve(import.meta.dirname, "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const binary = resolve(root, "target", "debug", process.platform === "win32"
  ? "rion-tauri.exe"
  : "rion-tauri");

const child = spawnPlatformCommand(pnpm, [
  "exec",
  "tauri",
  "build",
  "--debug",
  "--no-bundle",
  "--features=desktop-e2e",
  "--config",
  "src-tauri/tauri.e2e.conf.json",
  "--ci"
], {
  cwd: root,
  env: {
    ...process.env,
    RION_STUDIO_DESKTOP_E2E_BUILD: "1"
  },
  stdio: "inherit"
});

const exitCode = await new Promise((resolveExit, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal) reject(new Error(`Desktop E2E build ended with signal ${signal}`));
    else resolveExit(code ?? 1);
  });
});
if (exitCode !== 0) process.exit(exitCode);
await access(binary);
process.stdout.write(`${binary}\n`);
