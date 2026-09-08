import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { verifyElectronRendererBundle } from "./verifyElectronRendererBundle.mjs";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const { stdout } = await execute("cargo", [
  "tree",
  "-p",
  "rion-node",
  "--edges",
  "normal",
  "--no-default-features"
], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
for (const forbidden of ["tauri ", "tauri-plugin-wdio ", "tauri-plugin-wdio-webdriver ", "wry ", "webview2-com "]) {
  if (stdout.includes(forbidden)) {
    throw new Error(`Production Cargo graph contains debug-only dependency: ${forbidden.trim()}`);
  }
}

await verifyElectronRendererBundle(resolve(root, "out", "renderer"));
await readFile(resolve(root, "out", "main", "index.js"));
await readFile(resolve(root, "out", "preload", "index.cjs"));

const runtimeRoots = [
  {
    directory: resolve(root, "out", "renderer"),
    label: "renderer",
    markers:
      /wdioTauri|desktop_e2e_|TAURI_WEBDRIVER_PORT|__rionStudioDesktopE2eNavigate|rion:e2e:invoke|rionStudioDesktopE2e|retainedV22Precondition/u
  },
  {
    directory: resolve(root, "out", "main"),
    label: "Electron main",
    markers: /rion:e2e:invoke|rionStudioDesktopE2e|retainedV22Precondition/u
  },
  {
    directory: resolve(root, "out", "preload"),
    label: "Electron preload",
    markers: /rion:e2e:invoke|rionStudioDesktopE2e|retainedV22Precondition/u
  }
];
for (const runtimeRoot of runtimeRoots) {
  const files = await readdir(runtimeRoot.directory, { recursive: true });
  for (const relativePath of files) {
    if (!/\.(?:cjs|html|js|mjs)$/u.test(relativePath)) continue;
    const source = await readFile(resolve(runtimeRoot.directory, relativePath), "utf8");
    if (runtimeRoot.markers.test(source)) {
      throw new Error(
        `Production ${runtimeRoot.label} contains desktop E2E control code: ${relativePath}`
      );
    }
  }
}

process.stdout.write("Desktop E2E production isolation verified.\n");
