import { access, readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const removedPaths = [
  "build/tauri-helper-dev/package.json",
  "crates/rion-core/assets/cdn_compatibility_rules.json",
  "crates/rion-core/src/cdn.rs",
  "crates/rion-core/src/cdn_detection.rs",
  "crates/rion-core/src/chrome_cookies.rs",
  "crates/rion-core/src/chrome_profile_import.rs",
  "crates/rion-core/src/external_automation.rs",
  "crates/rion-core/src/external_chrome.rs",
  "crates/rion-core/src/external_runtime.rs",
  "crates/rion-platform/src/chrome.rs",
  "src-tauri/src/electron_helper.rs",
  "src/main/browser/ChromeProfileImportManager.ts",
  "src/main/browser/ExternalChromeCdpBridge.ts",
  "src/main/game-browser/CdnCompatibilityManager.ts",
  "src/main/helper/ElectronRuntimeHelper.ts",
  "src/renderer/src/features/chrome-profile-import/ChromeProfileImportFlow.tsx",
  "src/shared/runtimeHelperProtocol.ts"
];

const sourceRoots = [
  "crates/rion-core/src",
  "crates/rion-node/src",
  "crates/rion-platform/src",
  "native",
  "scripts",
  "src-tauri/src",
  "src-tauri/native",
  "src/main",
  "src/preload",
  "src/renderer/src",
  "src/shared"
];
const sourceExtensions = new Set([
  ".c", ".cc", ".cpp", ".h", ".m", ".mjs", ".mm", ".rs", ".ts", ".tsx"
]);
const forbiddenTokens = [
  "BrowserCdnCompatibility",
  "CdnCompatibilityManager",
  "CdnResolutionRecord",
  "ChromeProfileImport",
  "configureWebView2RequestRewrites",
  "ExternalChrome",
  "ExternalSessionRecord",
  "RION_STUDIO_CHROME_PATH",
  "remote-debugging-port"
];
const migrationOnlyTokens = new Map([
  ["cdnCompatibility", new Set([
    "crates/rion-core/src/database/state.rs"
  ])],
  ["chrome-profile", new Set([
    "crates/rion-core/src/database/legacy.rs",
    "crates/rion-core/src/database/state.rs"
  ])]
]);

const failures = [];
for (const path of removedPaths) {
  if (await exists(join(repositoryRoot, path))) {
    failures.push(`removed path still exists: ${path}`);
  }
}

for (const root of sourceRoots) {
  for (const path of await sourceFiles(join(repositoryRoot, root))) {
    const repositoryPath = relative(repositoryRoot, path).replaceAll("\\", "/");
    if (repositoryPath === "scripts/verifySystemOnlyProduct.mjs") continue;
    const source = await readFile(path, "utf8");
    for (const token of forbiddenTokens) {
      if (source.includes(token)) failures.push(`${repositoryPath} contains ${token}`);
    }
    for (const [token, allowlist] of migrationOnlyTokens) {
      if (source.includes(token) && !allowlist.has(repositoryPath)) {
        failures.push(`${repositoryPath} contains migration-only token ${token}`);
      }
    }
  }
}

const embeddedEngine = await readFile(
  join(repositoryRoot, "src/shared/generated/EmbeddedBrowserEngine.ts"),
  "utf8"
);
if (!embeddedEngine.includes('export type EmbeddedBrowserEngine = "system";')) {
  failures.push("EmbeddedBrowserEngine is not restricted to the System WebView.");
}
const resolvedEngine = await readFile(
  join(repositoryRoot, "src/shared/generated/ResolvedBrowserEngine.ts"),
  "utf8"
);
if (
  !resolvedEngine.includes('"webview2"') ||
  !resolvedEngine.includes('"wkwebview"') ||
  resolvedEngine.includes('"electron"') ||
  resolvedEngine.includes('"external"')
) {
  failures.push("ResolvedBrowserEngine contains a non-system runtime.");
}
const coreEffects = await readFile(
  join(repositoryRoot, "src/shared/generated/CoreEffectAction.ts"),
  "utf8"
);
for (const removedEffect of [
  "createWindow",
  "createView",
  "attachView",
  "debuggerCommand",
  "sessionClearStorage",
  "cookieSet"
]) {
  if (coreEffects.includes(`"type": "${removedEffect}"`)) {
    failures.push(`CoreEffectAction still exposes ${removedEffect}.`);
  }
}

if (failures.length > 0) {
  throw new Error(`System-only product gate failed:\n- ${failures.join("\n- ")}`);
}
console.log("Verified system-only product boundary: no CDN, External Chrome, or Chrome Profile runtime remains.");

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function sourceFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await sourceFiles(path));
    } else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}
