import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const addonPath = join(
  repositoryRoot,
  "build",
  "native",
  `win32-${process.arch}`,
  "rion-webview2.node"
);

async function main() {
  if (process.platform !== "win32") {
    console.log("Skipping Windows WebView2 verification on this platform.");
    return;
  }
  await access(addonPath, constants.F_OK);
  const addon = require(addonPath);
  if (addon.protocolVersion !== 1) {
    throw new Error(`Unexpected Windows WebView2 protocol: ${String(addon.protocolVersion)}.`);
  }
  for (const method of [
    "callWebView2DevToolsMethod",
    "clearWebView2Data",
    "createWebView2Surface",
    "destroyWebView2Surface",
    "evaluateWebView2",
    "focusWebView2",
    "getWebView2Cookies",
    "loadWebView2URL",
    "setWebView2AudioMuted",
    "setWebView2Bounds",
    "setWebView2Cookies",
    "setWebView2Visible",
    "setWebView2Zoom"
  ]) {
    if (typeof addon[method] !== "function") {
      throw new Error(`Windows WebView2 addon is missing ${method}().`);
    }
  }
  console.log(`Verified Windows WebView2 protocol 1: ${addonPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
