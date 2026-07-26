import { access, readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const removedPaths = [
  "crates/rion-node",
  "electron-builder.config.d.mts",
  "electron-builder.config.mjs",
  "electron.vite.config.ts",
  "native/macos/runtime-tabs",
  "native/windows/webview2",
  "build/Install Help.txt",
  "build/entitlements.mac.inherit.plist",
  "build/entitlements.mac.plist",
  "build/signMacAdHoc.d.mts",
  "build/signMacAdHoc.mjs",
  "scripts/buildMacRuntimeTabs.mjs",
  "scripts/buildRustCore.mjs",
  "scripts/buildWindowsWebView2.mjs",
  "scripts/verifyMacRuntimeTabs.mjs",
  "scripts/verifyPackagedRustCore.mjs",
  "scripts/verifyPackagedUpdateConfig.d.mts",
  "scripts/verifyPackagedUpdateConfig.mjs",
  "scripts/verifyRustCore.mjs",
  "scripts/verifyWindowsWebView2.mjs",
  "src/main",
  "src/preload",
  "src/shared/internalIpc.ts",
  "src/shared/ipc.ts",
  "src/shared/embeddedRuntimeDiagnostics.ts",
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
  "src/renderer/src/features/chrome-profile-import/ChromeProfileImportFlow.tsx",
  "src/shared/runtimeHelperProtocol.ts"
];

const sourceRoots = [
  ".github/workflows",
  "crates/rion-core/src",
  "crates/rion-platform/src",
  "scripts",
  "src-tauri",
  "src/renderer/native-chrome",
  "src/renderer/src",
  "src/shared"
];
const sourceExtensions = new Set([
  ".c", ".cc", ".cpp", ".h", ".json", ".m", ".mjs", ".mm", ".nsh", ".rs", ".toml", ".ts",
  ".tsx", ".yaml", ".yml"
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
  "BrowserNetworkSettingsRecord",
  "BrowserProxySettingsRecord",
  "--proxy-server",
  "proxyConfigurations",
  "proxy_url",
  "rion-runtime-audio://",
  "build:tauri:renderer",
  "dev:tauri",
  "remote-debugging-port"
];
const migrationOnlyTokens = new Map([
  ["cdnCompatibility", new Set([
    "crates/rion-core/src/database/state.rs"
  ])],
  ["chrome-profile", new Set([
    "crates/rion-core/src/database/legacy.rs",
    "crates/rion-core/src/database/state.rs"
  ])],
  ["electron", new Set([
    "crates/rion-core/src/data_root_migration.rs",
    "crates/rion-core/src/database/state.rs",
    "crates/rion-core/src/model.rs",
    "crates/rion-core/src/portable.rs",
    "src-tauri/windows/installer-hooks.nsh"
  ])],
  ["custom proxy", new Set([
    "crates/rion-core/src/database/legacy.rs",
    "crates/rion-core/src/database/state.rs"
  ])],
  ['"proxy"', new Set([
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
      if (source.toLowerCase().includes(token.toLowerCase()) && !allowlist.has(repositoryPath)) {
        failures.push(`${repositoryPath} contains migration-only token ${token}`);
      }
    }
  }
}

const packageJson = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
if (
  packageJson.scripts?.["verify:system-only"] !==
  "node scripts/verifySystemOnlyProduct.mjs && node scripts/verifyTauriParityLedger.mjs"
) {
  failures.push("verify:system-only must include verifyTauriParityLedger.mjs");
}
const directPackages = {
  ...packageJson.dependencies,
  ...packageJson.devDependencies
};
for (const name of [
  "@electron/osx-sign",
  "electron",
  "electron-builder",
  "electron-updater",
  "electron-vite",
  "node-gyp"
]) {
  if (name in directPackages) failures.push(`package.json contains retired dependency ${name}`);
}
for (const name of Object.keys(directPackages)) {
  if (name.startsWith("@electron/") || name.toLowerCase().includes("napi")) {
    failures.push(`package.json contains retired native-shell dependency ${name}`);
  }
}
for (const [name, command] of Object.entries(packageJson.scripts ?? {})) {
  if (/^(?:dev|build):tauri(?::|$)/i.test(name)) {
    failures.push(`package.json contains retired transitional script ${name}`);
  }
  if (/electron(?:-builder|-vite)?|node-gyp|buildRustCore|buildMacRuntimeTabs|buildWindowsWebView2/i.test(command)) {
    failures.push(`package script ${name} invokes a retired Electron build path`);
  }
}

const cargoWorkspace = await readFile(join(repositoryRoot, "Cargo.toml"), "utf8");
for (const token of ["crates/rion-node", "napi =", "napi-build", "napi-derive"]) {
  if (cargoWorkspace.includes(token)) failures.push(`Cargo workspace contains ${token}`);
}
const pnpmWorkspace = await readFile(join(repositoryRoot, "pnpm-workspace.yaml"), "utf8");
if (/^\s*(?:electron|electron-winstaller):|^\s*-\s*electron\s*$/mu.test(pnpmWorkspace)) {
  failures.push("pnpm-workspace.yaml permits a retired Electron install script");
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
console.log("Verified Tauri-only system WebView boundary: no Electron, CDN, External Chrome, or Chrome Profile runtime remains.");

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
