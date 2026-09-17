import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

if (!["darwin", "win32"].includes(process.platform)) throw new Error("Filtering verification requires a native desktop host.");
const executable = process.env.RION_EXTENSION_PROBE_EXECUTABLE ?? createRequire(import.meta.url)("electron");
const root = await mkdtemp(join(tmpdir(), "rion-extension-filtering-"));
try {
  const probe = join(root, "probe.cjs");
  const preload = join(root, "preload.cjs");
  for (const [entry, outfile] of [
    ["./electronExtensionFilteringProbe.ts", probe],
    ["../third_party/electron-chrome-extensions/src/rion-preload.ts", preload]
  ]) await build({ bundle: true, entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    external: ["electron"], format: "cjs", outfile, platform: "node", target: "node24" });
  for (const phase of ["seed", "restart"]) {
    const child = spawn(executable, [probe], { env: { ...process.env,
      RION_EXTENSION_FILTERING_ROOT: root, RION_EXTENSION_FILTERING_PHASE: phase,
      RION_EXTENSION_COMPAT_PRELOAD: preload }, stdio: ["ignore", "pipe", "inherit"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => { output += chunk; process.stdout.write(chunk); });
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => code === 0 && output.includes(`"probe":"filtering-terminal","phase":"${phase}"`)
        ? resolve() : reject(new Error(`Filtering ${phase} failed: ${code ?? signal}`)));
    });
  }
} finally { await rm(root, { recursive: true, force: true }); }
