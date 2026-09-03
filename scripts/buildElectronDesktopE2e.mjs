import { access } from "node:fs/promises";
import { resolve } from "node:path";

import { spawnPlatformCommand } from "./spawnPlatformCommand.mjs";

if (!new Set(["darwin", "win32"]).has(process.platform)) {
  throw new Error(`Electron desktop E2E does not support ${process.platform}`);
}

const root = resolve(import.meta.dirname, "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const entryPoint = resolve(root, "out/main/index.js");
const nativeAddon = resolve(
  root,
  "build/native",
  `${process.platform}-${process.arch}`,
  "rion-core.node"
);
const child = spawnPlatformCommand(pnpm, ["run", "build:electron"], {
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
    if (signal) reject(new Error(`Electron desktop E2E build ended with signal ${signal}`));
    else resolveExit(code ?? 1);
  });
});
if (exitCode !== 0) process.exit(exitCode);
await access(entryPoint);
await access(nativeAddon);
process.stdout.write(`${entryPoint}\n`);
