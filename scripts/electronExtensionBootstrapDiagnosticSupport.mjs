import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const ADMITTED_EXTENSION = Object.freeze({
  id: "gighmmpiobklfepjocnamgkkbiglidom",
  version: "6.49.0",
  sha256: "d39ac37db7a4cc7c5f16a53f45c95317c613c3579d6d17b2301e80f43a628a9c",
  sizeBytes: 342220415
});

export const DIAGNOSTIC_STAGES = Object.freeze([
  "preload-enter", "preload-complete", "main-world-enter", "main-world-installed",
  "first-main-world-microtask", "rulesets-enable-before", "rulesets-enable-completed",
  "rulesets-enable-failed", "compatibility-ready-before", "compatibility-ready-completed"
]);
export const GENERATED_RULESET_CACHE = "_metadata/generated_indexed_rulesets";

function fail(code) { throw new Error(code); }

export function containedDiagnosticPath(root, candidate, allowRoot = false) {
  if (!isAbsolute(root) || !isAbsolute(candidate)) fail("DIAGNOSTIC_PATH_NOT_ABSOLUTE");
  const destination = resolve(candidate);
  const descendant = relative(resolve(root), destination);
  if ((!allowRoot && descendant === "") || descendant === ".." ||
      descendant.startsWith(`..${sep}`) || isAbsolute(descendant)) {
    fail("DIAGNOSTIC_PATH_OUTSIDE_OWNER");
  }
  return destination;
}

export function admittedExtensionMetadata(query) {
  const settings = query?.settings;
  if (!Array.isArray(settings)) fail("DIAGNOSTIC_EXTENSION_SETTINGS_MISSING");
  const rows = settings.filter(row => row?.key === "extensions");
  if (rows.length !== 1 || !Array.isArray(rows[0].payload?.installed)) {
    fail("DIAGNOSTIC_EXTENSION_SETTINGS_INVALID");
  }
  const records = rows[0].payload.installed.filter(record => record?.id === ADMITTED_EXTENSION.id);
  if (records.length !== 1) fail("DIAGNOSTIC_EXTENSION_ID_NOT_ADMITTED");
  const record = records[0];
  if (record.version !== ADMITTED_EXTENSION.version ||
      typeof record.sha256 !== "string" || record.sha256.toLowerCase() !== ADMITTED_EXTENSION.sha256 ||
      record.sizeBytes !== ADMITTED_EXTENSION.sizeBytes || record.removed !== false ||
      typeof record.directory !== "string" || !isAbsolute(record.directory)) {
    fail("DIAGNOSTIC_EXTENSION_METADATA_NOT_ADMITTED");
  }
  // sha256 describes the original CRX; sizeBytes is the recorded logical
  // installed size. Neither is a digest of the present unpacked directory.
  return Object.freeze({ ...ADMITTED_EXTENSION, directory: resolve(record.directory) });
}

export function admittedManifestIdentity(manifest) {
  const key = manifest?.key;
  if (typeof key !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/u.test(key)) {
    fail("DIAGNOSTIC_MANIFEST_KEY_INVALID");
  }
  const bytes = Buffer.from(key, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== key) fail("DIAGNOSTIC_MANIFEST_KEY_INVALID");
  const id = createHash("sha256").update(bytes).digest("hex").slice(0, 32)
    .replace(/[0-9a-f]/gu, digit => String.fromCharCode(97 + Number.parseInt(digit, 16)));
  if (id !== ADMITTED_EXTENSION.id || manifest.version !== ADMITTED_EXTENSION.version ||
      manifest.manifest_version !== 3 || typeof manifest.background?.service_worker !== "string" ||
      manifest.background.service_worker.length === 0) fail("DIAGNOSTIC_MANIFEST_NOT_ADMITTED");
  return Object.freeze({ id, version: manifest.version, worker: manifest.background.service_worker });
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { fail("DIAGNOSTIC_INPUT_JSON_UNREADABLE"); }
}

export function isGeneratedRulesetCachePath(directory, path) {
  const name = relative(resolve(directory), resolve(path));
  const cache = join("_metadata", "generated_indexed_rulesets");
  return name === cache || name.startsWith(`${cache}${sep}`);
}

export async function assertDiagnosticTree(directory, excludeGeneratedRulesets = false) {
  const root = await realpath(directory);
  const pending = [root];
  let files = 0;
  let bytes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = containedDiagnosticPath(root, join(current, entry.name));
      const info = await lstat(path);
      if (info.isSymbolicLink()) fail("DIAGNOSTIC_PACKAGE_SYMLINK_FORBIDDEN");
      if (excludeGeneratedRulesets && isGeneratedRulesetCachePath(root, path)) continue;
      if (info.isDirectory()) pending.push(path);
      else if (info.isFile()) { files += 1; bytes += info.size; }
      else fail("DIAGNOSTIC_PACKAGE_ENTRY_INVALID");
    }
  }
  return Object.freeze({ files, bytes });
}

export async function findAdmittedMacExtensionInput(artifactBase) {
  const base = await realpath(resolve(artifactBase));
  const candidates = [];
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}T[\d-]+Z-darwin$/u.test(entry.name)) continue;
    const directory = containedDiagnosticPath(base, await realpath(join(base, entry.name)));
    const reportPath = containedDiagnosticPath(directory, await realpath(join(directory, "report.json")));
    const report = await readJson(reportPath);
    if (report.runtimeTarget !== "chromium-v23-macos-appkit" || report.driver !== "electron" ||
        !Array.isArray(report.phases) || !report.phases.some(phase => phase?.phase === "chromium-extensions-seed")) continue;
    const startedAt = typeof report.startedAt === "string" ? Date.parse(report.startedAt) : NaN;
    if (!Number.isFinite(startedAt)) fail("DIAGNOSTIC_REPORT_TIME_INVALID");
    candidates.push({ directory, reportPath, report, startedAt });
  }
  candidates.sort((a, b) => b.startedAt - a.startedAt);
  const latest = candidates[0];
  if (!latest || (candidates[1] && candidates[1].startedAt === latest.startedAt)) {
    fail("DIAGNOSTIC_EXACT_MAC_REPORT_MISSING");
  }
  const { directory, reportPath, report } = latest;
  if (typeof report.artifactRoot !== "string" || !isAbsolute(report.artifactRoot) ||
      await realpath(report.artifactRoot) !== directory || typeof report.userDataRoot !== "string" ||
      !isAbsolute(report.userDataRoot)) fail("DIAGNOSTIC_REPORT_OWNER_MISMATCH");
  const userData = containedDiagnosticPath(directory, await realpath(report.userDataRoot));
  const extensionsPath = join(userData, "chromium-extensions", "extensions");
  const extensions = containedDiagnosticPath(extensionsPath, await realpath(extensionsPath), true);
  const queryPath = containedDiagnosticPath(directory,
    await realpath(join(directory, "phases", "chromium-extensions-seed", "sqlite-query.json")));
  const metadata = admittedExtensionMetadata(await readJson(queryPath));
  containedDiagnosticPath(extensions, metadata.directory);
  const sourceDirectory = containedDiagnosticPath(extensions, await realpath(metadata.directory));
  const manifestPath = containedDiagnosticPath(sourceDirectory, await realpath(join(sourceDirectory, "manifest.json")));
  const manifestBytes = await readFile(manifestPath);
  const manifest = admittedManifestIdentity(await readJson(manifestPath));
  containedDiagnosticPath(sourceDirectory, await realpath(resolve(sourceDirectory, manifest.worker)));
  const tree = await assertDiagnosticTree(sourceDirectory);
  const copyTree = await assertDiagnosticTree(sourceDirectory, true);
  let cachePresent = false;
  try { cachePresent = Boolean(await lstat(join(sourceDirectory, "_metadata", "generated_indexed_rulesets"))); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const generatedRulesetCache = Object.freeze({ relativePath: GENERATED_RULESET_CACHE,
    present: cachePresent, excluded: true, files: tree.files - copyTree.files, bytes: tree.bytes - copyTree.bytes });
  return Object.freeze({ sourceDirectory, metadata, manifest, tree, copyTree, generatedRulesetCache,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    reportPath, report: Object.freeze({ commit: report.commit, startedAt: report.startedAt,
      runtimeTarget: report.runtimeTarget }) });
}

export function redactDiagnosticText(text, environment = process.env) {
  let result = String(text).replaceAll("\r\n", "\n");
  for (const [key, value] of Object.entries(environment)) {
    if (!/(?:token|secret|password|credential|private.?key)/iu.test(key) ||
        typeof value !== "string" || value.length < 4) continue;
    for (const representation of new Set([value, JSON.stringify(value).slice(1, -1)])) {
      result = result.split(representation).join("[REDACTED]");
    }
  }
  return result
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/giu, "$1 [REDACTED]")
    .replace(/("[^"\\]*(?:token|secret|password|credential|private.?key)[^"\\]*"\s*:\s*)"(?:\\.|[^"\\])*"/giu,
      "$1\"[REDACTED]\"")
    .replace(/([?&][^?&=\s"]*(?:token|secret|password|credential)[^?&=\s"]*=)[^&#\s"]*/giu,
      "$1[REDACTED]");
}

export function strictDiagnosticResultPassed(exitCode, result) {
  return exitCode === 0 && result?.probe === "electron-extension-bootstrap-diagnostic" &&
    result.mode === "strict-compat" && result.extensionId === ADMITTED_EXTENSION.id &&
    result.electronVersion === "44.4.3" && result.status === "passed" && result.strictReady === true &&
    result.nativeLoaded === true && result.nativeStartupObserved === true;
}

function replaceOnce(source, anchor, replacement) {
  if (source.split(anchor).length !== 2) fail("DIAGNOSTIC_PRELOAD_SOURCE_CHANGED");
  return source.replace(anchor, replacement);
}

export function instrumentDiagnosticPreload(source) {
  let result = replaceOnce(source.replaceAll("\r\n", "\n"),
    "const listeners = new Map<string, Map<string, IpcListener>>()",
    `const diagnosticStage = (stage: string) => {
  if (!${JSON.stringify(DIAGNOSTIC_STAGES)}.includes(stage)) throw new Error('DIAGNOSTIC_STAGE_INVALID')
  ipcRenderer.send('rion-extension-bootstrap-diagnostic', {
    stage, pid: process.pid, processType: process.type, contextIsolated: process.contextIsolated,
  })
}
diagnosticStage('preload-enter')
const listeners = new Map<string, Map<string, IpcListener>>()`);
  result = replaceOnce(result, "  addExtensionListener,\n  hasExtensionListener,",
    "  diagnosticStage,\n  addExtensionListener,\n  hasExtensionListener,");
  result = replaceOnce(result, "  const bridge = (globalThis as any).rionExtensionBridge",
    "  const bridge = (globalThis as any).rionExtensionBridge\n  bridge.diagnosticStage('main-world-enter')");
  result = replaceOnce(result, "  const boot = async () => {",
    "  bridge.diagnosticStage('main-world-installed')\n  queueMicrotask(() => bridge.diagnosticStage('first-main-world-microtask'))\n  const boot = async () => {");
  result = replaceOnce(result, "        await chrome.declarativeNetRequest.updateEnabledRulesets({",
    "        bridge.diagnosticStage('rulesets-enable-before')\n        await chrome.declarativeNetRequest.updateEnabledRulesets({");
  result = replaceOnce(result, "        staticRulesetStatus = 'enabled'",
    "        bridge.diagnosticStage('rulesets-enable-completed')\n        staticRulesetStatus = 'enabled'");
  result = replaceOnce(result, "        staticRulesetStatus = 'failed'",
    "        bridge.diagnosticStage('rulesets-enable-failed')\n        staticRulesetStatus = 'failed'");
  result = replaceOnce(result, "    await bridge.invokeExtension(extensionId, 'compatibility.ready', {",
    "    bridge.diagnosticStage('compatibility-ready-before')\n    await bridge.invokeExtension(extensionId, 'compatibility.ready', {");
  result = replaceOnce(result, "    })\n  }\n  if (typeof document === 'undefined') void boot()",
    "    })\n    bridge.diagnosticStage('compatibility-ready-completed')\n  }\n  if (typeof document === 'undefined') void boot()");
  return `${result}\ndiagnosticStage('preload-complete')\n`;
}
