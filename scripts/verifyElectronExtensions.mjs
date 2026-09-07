import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (!["darwin", "win32"].includes(process.platform)) throw new Error("Extensions verification requires macOS or Windows");
const require = createRequire(import.meta.url);
const executable = require("electron");
const root = await mkdtemp(join(tmpdir(), "rion-extensions-native-"));
try {
  for (const phase of ["seed", "restart"]) {
    const child = spawn(executable, [fileURLToPath(new URL("./electronExtensionsProbe.cjs", import.meta.url))], {
      env: { ...process.env, RION_EXTENSIONS_PROBE_DIR: root, RION_EXTENSIONS_PROBE_PHASE: phase }, stdio: "inherit"
    });
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Extension ${phase} probe failed: ${code ?? signal}`)));
    });
  }
} finally { await rm(root, { recursive: true, force: true }); }
