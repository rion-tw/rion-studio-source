import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const { stdout } = await execute("cargo", [
  "tree",
  "-p",
  "rion-tauri",
  "--edges",
  "normal",
  "--no-default-features",
  "--features",
  "custom-protocol"
], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
for (const forbidden of ["tauri-plugin-wdio ", "tauri-plugin-wdio-webdriver "]) {
  if (stdout.includes(forbidden)) {
    throw new Error(`Production Cargo graph contains debug-only dependency: ${forbidden.trim()}`);
  }
}

const productionConfig = JSON.parse(await readFile(resolve(root, "src-tauri/tauri.conf.json"), "utf8"));
if (productionConfig.app?.withGlobalTauri === true) {
  throw new Error("Production Tauri config must not expose withGlobalTauri");
}
const permissions = JSON.stringify(productionConfig.app?.security?.capabilities ?? []);
if (/wdio|desktop-e2e/iu.test(permissions)) {
  throw new Error("Production Tauri capabilities contain desktop E2E permissions");
}

const rendererDir = resolve(root, "out", "renderer");
const rendererFiles = await readdir(rendererDir, { recursive: true }).catch(() => []);
for (const relativePath of rendererFiles) {
  if (!/\.(?:html|js)$/u.test(relativePath)) continue;
  const source = await readFile(resolve(rendererDir, relativePath), "utf8");
  if (/wdioTauri|desktop_e2e_|TAURI_WEBDRIVER_PORT|__rionStudioDesktopE2eNavigate/u.test(source)) {
    throw new Error(`Production renderer contains desktop E2E control code: ${relativePath}`);
  }
}

process.stdout.write("Desktop E2E production isolation verified.\n");
