import { access, readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { TAURI_COMPATIBILITY_RENDERER_DOCUMENTS } from "./verifyElectronRendererBundle.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const removedPaths = [
  "electron-builder.config.d.mts",
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
  "crates/rion-core/src/external_automation.rs",
  "crates/rion-core/src/external_chrome.rs",
  "crates/rion-core/src/external_runtime.rs",
  "crates/rion-core/src/graphics_diagnostics.rs",
  "crates/rion-core/src/browser_proxy.rs",
  "crates/rion-core/src/model/section_08_browser_proxy.rs",
  "crates/rion-platform/src/chrome.rs",
  "crates/rion-platform/src/browser_proxy.rs",
  "src-tauri/src/electron_helper.rs",
  "src-tauri/src/system_runtime/browser_proxy.rs",
  "src-tauri/native/macos/RionWKWebViewProxy.m",
  "src/renderer/src/features/chrome-profile-import/ChromeProfileImportFlow.tsx",
  "src/renderer/src/features/settings/NetworkAccelerationSettingsSection.tsx",
  "src/renderer/src/features/settings/useBrowserProxySettings.ts",
  "src/renderer/src/features/settings/graphicsRestart.ts",
  "src/shared/generated/BootstrapPlanRecord.ts",
  "src/shared/generated/BrowserGraphicsBackendSettingsRecord.ts",
  "src/shared/generated/BrowserGraphicsSettingsRecord.ts",
  "src/shared/generated/ChromiumSwitchRecord.ts",
  "src/shared/generated/GraphicsDeviceDiagnosticsRecord.ts",
  "src/shared/generated/GraphicsDiagnosticsRecord.ts",
  "src/shared/generated/BrowserProxyDiagnosticsRecord.ts",
  "src/shared/generated/BrowserProxyEndpointRecord.ts",
  "src/shared/generated/BrowserProxySettingsRecord.ts",
  "src/shared/runtimeHelperProtocol.ts"
];

const sourceRoots = [
  ".github/workflows",
  "crates/rion-node/src",
  "crates/rion-core/src",
  "crates/rion-platform/src",
  "scripts",
  "src/electron",
  "src-tauri",
  "src/renderer/runtime-shell",
  "src/renderer/src",
  "src/shared"
];
const sourceExtensions = new Set([
  ".c", ".cc", ".cjs", ".cpp", ".h", ".json", ".m", ".mjs", ".mm", ".nsh", ".rs", ".toml", ".ts",
  ".tsx", ".yaml", ".yml"
]);
const forbiddenTokens = [
  "BrowserCdnCompatibility",
  "CdnCompatibilityManager",
  "CdnResolutionRecord",
  "configureWebView2RequestRewrites",
  "ExternalChrome",
  "ExternalSessionRecord",
  "RION_STUDIO_CHROME_PATH",
  "BrowserNetworkSettingsRecord",
  "BrowserProxyDiagnosticsRecord",
  "BrowserProxyEndpointRecord",
  "BrowserProxySettingsRecord",
  "--proxy-server",
  "proxyConfigurations",
  "proxy_url",
  "session.setProxy",
  "ignore-certificate-errors",
  "rion-runtime-audio://",
  "build:tauri:renderer",
  "dev:tauri",
  "remote-debugging-port",
  "remote-debugging-pipe",
  "RuntimeTabChromeState",
  "game-tabs-chrome",
  "native-chrome",
  "runtimeTabsChrome"
];
const forbiddenTokenAllowlists = new Map([
  ["remote-debugging-port", new Set([
    "src/electron/main/chromiumCommandLinePolicy.ts"
  ])],
  ["remote-debugging-pipe", new Set([
    "src/electron/main/chromiumCommandLinePolicy.ts"
  ])]
]);
const migrationOnlyTokens = new Map([
  ["cdnCompatibility", new Set([
    "crates/rion-core/src/database/state.rs"
  ])],
  ["electron", new Set([
    "scripts/probeChromiumInput.cjs",
    "scripts/probeChromiumViewport.cjs",
    "scripts/probeChromiumShortcuts.cjs",
    "scripts/probeChromiumLocalFonts.cjs",
    "crates/rion-core/src/app/section_05_delete_workspaces_runtime_aware.rs",
    "crates/rion-core/src/app/tests/behavior_03_role_creation_and_selected_browser_directory_reset.rs",
    "crates/rion-core/src/database/state.rs",
    "crates/rion-core/src/model.rs",
    "crates/rion-core/src/portable.rs",
    "src-tauri/windows/installer-hooks.nsh"
  ])],
  ["custom proxy", new Set([
    "crates/rion-core/src/database/state.rs"
  ])],
  ['"proxy"', new Set([
    "crates/rion-core/src/database/state.rs"
  ])]
]);
const migrationElectronPrefixes = [
  ".github/workflows/",
  "crates/rion-node/",
  "crates/rion-core/src/app/tests/behavior_25_runtime_ui_actions.rs",
  "scripts/checkDesktopE2eCoverage.mjs",
  "scripts/buildElectron",
  "scripts/buildElectronDesktopE2e.mjs",
  "scripts/desktopE2eChromium",
  "scripts/desktopE2eRuntimeTarget",
  "scripts/electron",
  "scripts/eventTopologyPolicy.mjs",
  "scripts/finalizeMacosElectronUpdaterCompatibilityReceipt",
  "scripts/finalizeWindowsElectronUpdaterCompatibilityReceipt",
  "scripts/packagedElectron",
  "scripts/prepareElectron",
  "scripts/publicReleaseRuntimePolicy.mjs",
  "scripts/runElectron",
  "scripts/runDesktopE2e.mjs",
  "scripts/runPackagedElectron",
  "scripts/restoreElectron",
  "scripts/runtimeEnvironmentPolicy.mjs",
  "scripts/tauriV22PublicLineage.mjs",
  "scripts/verifyDesktopE2eIsolation.mjs",
  "scripts/verifyDesktopE2eBuild",
  "scripts/verifyElectron",
  "scripts/verifyTauriV22UpdaterInput.mjs",
  "scripts/windowsElectronInstallerPayloadProof",
  "src/electron/",
  "src/renderer/src/electron.tsx",
  "src/renderer/src/app/windowGestureMode.ts",
  "src/renderer/src/global.d.ts",
  "tests/electron-"
];

const probePath = optionValue("--probe");
if (probePath) {
  const source = await readFile(probePath, "utf8");
  const findings = inspectSource("tests/system-only-negative-fixture.ts", source);
  if (findings.length > 0) {
    throw new Error(`Desktop shell migration gate failed:\n- ${findings.join("\n- ")}`);
  }
  console.log("Desktop shell migration probe contains no retired capability tokens.");
  process.exit(0);
}

const failures = [];
for (const path of removedPaths) {
  if (await exists(join(repositoryRoot, path))) {
    failures.push(`removed path still exists: ${path}`);
  }
}

for (const root of sourceRoots) {
  for (const path of await sourceFiles(join(repositoryRoot, root))) {
    const repositoryPath = relative(repositoryRoot, path).replaceAll("\\", "/");
    const source = await readFile(path, "utf8");
    failures.push(...inspectSource(repositoryPath, source));
  }
}

const packageJson = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
if (packageJson.scripts?.["verify:system-only"] !== "node scripts/verifySystemOnlyProduct.mjs") {
  failures.push("verify:system-only must run the architecture verifier");
}
const directPackages = {
  ...packageJson.dependencies,
  ...packageJson.devDependencies
};
for (const name of [
  "@electron/osx-sign",
  "electron-updater",
  "node-gyp"
]) {
  if (name in directPackages) failures.push(`package.json contains retired dependency ${name}`);
}
for (const name of Object.keys(directPackages)) {
  if ((name.startsWith("@electron/") && !new Set([
    "@electron/asar",
    "@electron/fuses"
  ]).has(name)) ||
      name.toLowerCase().includes("napi")) {
    failures.push(`package.json contains retired native-shell dependency ${name}`);
  }
}
for (const [name, command] of Object.entries(packageJson.scripts ?? {})) {
  if (/^(?:dev|build):tauri(?::|$)/i.test(name)) {
    failures.push(`package.json contains retired transitional script ${name}`);
  }
  if (/node-gyp|buildMacRuntimeTabs|buildWindowsWebView2/i.test(command)) {
    failures.push(`package script ${name} invokes a retired native-shell build path`);
  }
  if (/electron(?:-builder|-vite)?/i.test(command) && !/electron/i.test(name)) {
    failures.push(`package script ${name} hides an Electron migration command behind a non-Electron name`);
  }
}

const [electronViteSource, electronRendererEntry, tauriRendererEntry, rendererDocument] =
  await Promise.all([
    readFile(join(repositoryRoot, "electron.vite.config.ts"), "utf8"),
    readFile(join(repositoryRoot, "src/renderer/src/electron.tsx"), "utf8"),
    readFile(join(repositoryRoot, "src/renderer/src/main.tsx"), "utf8"),
    readFile(join(repositoryRoot, "src/renderer/index.html"), "utf8")
  ]);
for (const token of ["@tauri-apps/api", "__TAURI_INTERNALS__", "installTauriBridgeIfNeeded"]) {
  if (electronRendererEntry.includes(token)) {
    failures.push(`Electron renderer entry contains Tauri compatibility token ${token}`);
  }
}
if (!electronViteSource.includes('src="/src/electron.tsx"')) {
  failures.push("electron.vite.config.ts does not select the pure Electron renderer entry");
}
for (const document of TAURI_COMPATIBILITY_RENDERER_DOCUMENTS) {
  if (electronViteSource.includes(`src/renderer/${document}`)) {
    failures.push(`electron.vite.config.ts includes Tauri compatibility document ${document}`);
  }
}
if (
  !rendererDocument.includes('src="/src/main.tsx"') ||
  !tauriRendererEntry.includes("installTauriBridgeIfNeeded")
) {
  failures.push("The stable Tauri compatibility renderer entry is not preserved");
}

const cargoWorkspace = await readFile(join(repositoryRoot, "Cargo.toml"), "utf8");
for (const token of ["crates/rion-node", "napi =", "napi-build", "napi-derive"]) {
  if (!cargoWorkspace.includes(token)) failures.push(`Cargo workspace is missing migration dependency ${token}`);
}
const pnpmWorkspace = await readFile(join(repositoryRoot, "pnpm-workspace.yaml"), "utf8");
if (!/^\s*electron:\s*true\s*$/mu.test(pnpmWorkspace)) {
  failures.push("pnpm-workspace.yaml must explicitly allow the pinned Electron install script");
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
for (const transferEffect of [
  "ChromeProfileImportSnapshot",
  "ChromeProfileImportApply",
  "ChromeProfileImportVerify",
  "ChromeProfileImportRollback",
  "ChromeProfileImportCommit"
]) {
  if (!coreEffects.includes(`"type": "${transferEffect.charAt(0).toLowerCase()}${transferEffect.slice(1)}"`)) {
    failures.push(`CoreEffectAction is missing bounded one-time transfer effect ${transferEffect}.`);
  }
}
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
for (const forbiddenRuntimeEffect of [
  "chromeProfileLaunch",
  "chromeProfileSessionSource",
  "externalBrowserLaunch",
  "profileAsRuntime"
]) {
  if (coreEffects.includes(`"type": "${forbiddenRuntimeEffect}"`)) {
    failures.push(`CoreEffectAction exposes forbidden browser runtime effect ${forbiddenRuntimeEffect}.`);
  }
}

const transferSource = await readRustSourceTree(
  join(repositoryRoot, "crates/rion-core/src/chrome_profile_import.rs"),
);
if (!transferSource.includes(".session-transfers") || !transferSource.includes("session-transfer.enc")) {
  failures.push("ChromeProfileImport must remain a bounded encrypted one-time transfer.");
}
if (
  transferSource.includes(".chrome-profile-import-work") ||
  transferSource.includes("create_private_snapshot_root")
) {
  failures.push("ChromeProfileImport still exposes raw profile staging.");
}
const sessionImportSource = await readRustSourceTree(
  join(repositoryRoot, "crates/rion-core/src/session_import.rs"),
);
for (const required of ["Connection::open_in_memory", "MemEnv", "read_chrome_session_transfer"]) {
  if (!sessionImportSource.includes(required)) {
    failures.push(`ChromeProfileImport memory snapshot is missing ${required}.`);
  }
}
const browserActions = await readFile(
  join(repositoryRoot, "src/shared/generated/BrowserAction.ts"),
  "utf8"
);
for (const retiredAction of ["evaluate", "cookies", "session", "debugger"]) {
  if (browserActions.includes(`"type": "${retiredAction}"`)) {
    failures.push(`BrowserAction still exposes retired ${retiredAction} automation.`);
  }
}
const effectTargets = await readFile(
  join(repositoryRoot, "src/shared/generated/CoreEffectTargetKind.ts"),
  "utf8"
);
if (!effectTargets.includes('"app" | "webContents"')) {
  failures.push("CoreEffectTargetKind must be restricted to app and webContents.");
}

const bootstrapSettingsSource = await readFile(
  join(repositoryRoot, "crates/rion-core/src/bootstrap_settings.rs"),
  "utf8"
);
const productionBootstrapSettings = bootstrapSettingsSource.split("#[cfg(test)]", 1)[0];
for (const retiredGraphicsArgument of [
  "force-high-performance-gpu",
  "enable-gpu-rasterization",
  "ignore-gpu-blocklist",
  "enable-unsafe-webgpu",
  "disable-frame-rate-limit",
  "disable-gpu-vsync",
  "disable-gpu-driver-bug-workarounds",
  "disable-background-timer-throttling",
  "use-angle",
  "use-vulkan",
  "UseEcoQoSForBackgroundProcess"
]) {
  if (productionBootstrapSettings.includes(retiredGraphicsArgument)) {
    failures.push(`System WebView bootstrap still applies retired graphics argument ${retiredGraphicsArgument}.`);
  }
}
const productionSystemRuntime = await readRustSourceTree(
  join(repositoryRoot, "src-tauri/src/system_runtime.rs"),
).then((source) => source.split("#[cfg(test)]", 1)[0]);
for (const customBackgroundMechanism of [
  "MemoryUsageTargetLevel",
  "PreferredBackgroundTimerWakeInterval",
  "TrySuspend"
]) {
  if (productionSystemRuntime.includes(customBackgroundMechanism)) {
    failures.push(`System WebView runtime uses forbidden custom background mechanism ${customBackgroundMechanism}.`);
  }
}
for (const [path, retiredContract] of [
  ["src/shared/api.ts", "getGraphicsDiagnostics"],
  ["src/shared/api.ts", "restartApplication"],
  ["src/shared/generated/CoreCommand.ts", "graphicsDiagnosticsAssemble"],
  ["src/shared/generated/EngineCapabilitySnapshotRecord.ts", "graphicsTuning"]
]) {
  const source = await readFile(join(repositoryRoot, path), "utf8");
  if (source.includes(retiredContract)) {
    failures.push(`${path} still exposes retired graphics contract ${retiredContract}.`);
  }
}

if (failures.length > 0) {
  throw new Error(`Desktop shell migration gate failed:\n- ${failures.join("\n- ")}`);
}
console.log("Verified stable Tauri boundary plus scoped Electron migration: Rust remains authoritative and no External Chrome, unguarded remote-debugging transport, CDN, proxy, or profile runtime fallback is present.");

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readRustSourceTree(path, visited = new Set()) {
  const absolute = resolve(path);
  if (visited.has(absolute)) return "";
  visited.add(absolute);
  const source = await readFile(absolute, "utf8");
  const references = [...source.matchAll(/include!\(\s*"([^"]+)"\s*\)/g)]
    .map((match) => resolve(dirname(absolute), match[1]));
  const children = [];
  for (const reference of references) {
    if (await exists(reference)) children.push(await readRustSourceTree(reference, visited));
  }
  return [source, ...children].join("\n");
}

async function sourceFiles(root) {
  if (!await exists(root)) return [];
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

function inspectSource(repositoryPath, source) {
  if (repositoryPath === "scripts/verifySystemOnlyProduct.mjs") return [];
  const findings = [];
  for (const token of forbiddenTokens) {
    if (
      source.includes(token) &&
      !forbiddenTokenAllowlists.get(token)?.has(repositoryPath)
    ) {
      findings.push(`${repositoryPath} contains ${token}`);
    }
  }
  for (const [token, allowlist] of migrationOnlyTokens) {
    const migrationElectronSource = token === "electron" &&
      migrationElectronPrefixes.some((prefix) => repositoryPath.startsWith(prefix));
    if (source.toLowerCase().includes(token.toLowerCase()) &&
        !allowlist.has(repositoryPath) && !migrationElectronSource) {
      findings.push(`${repositoryPath} contains migration-only token ${token}`);
    }
  }
  return findings;
}

function optionValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}
