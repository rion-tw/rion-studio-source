import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { app, BaseWindow, contentTracing, session, WebContentsView } from "electron";
import { ChromiumExtensionSessions } from "../src/electron/main/chromiumExtensionSessions";
import { DIAGNOSTIC_STAGES, redactDiagnosticText } from "./electronExtensionBootstrapDiagnosticSupport.mjs";

const extensionId = "gighmmpiobklfepjocnamgkkbiglidom";
const scope = `chrome-extension://${extensionId}/`;
const channel = "rion-extension-bootstrap-diagnostic";
const roleId = "diagnostic-strict-compat";
const leaseId = "diagnostic-strict-compat-lease";
const stages = new Set(DIAGNOSTIC_STAGES);
const execute = promisify(execFile);
const started = performance.now();
const mode = process.env.RION_EXTENSION_BOOTSTRAP_DIAGNOSTIC_MODE;
const root = process.env.RION_EXTENSION_BOOTSTRAP_DIAGNOSTIC_ROOT;
const packagePath = process.env.RION_EXTENSION_BOOTSTRAP_DIAGNOSTIC_PACKAGE;
const preloadPath = process.env.RION_EXTENSION_BOOTSTRAP_DIAGNOSTIC_PRELOAD;
const outputPath = process.env.RION_EXTENSION_BOOTSTRAP_DIAGNOSTIC_OUTPUT;
if ((mode !== "native-only" && mode !== "strict-compat") ||
    !root || !packagePath || !outputPath || ![root, packagePath, outputPath].every(isAbsolute) ||
    (mode === "strict-compat" && (!preloadPath || !isAbsolute(preloadPath)))) {
  throw new Error("DIAGNOSTIC_ISOLATED_ABSOLUTE_PATHS_REQUIRED");
}
const outputDirectory = dirname(outputPath);
if (resolve(root) !== join(outputDirectory, "session") ||
    resolve(packagePath) !== join(outputDirectory, "package") ||
    existsSync(join(root, "app")) || existsSync(join(root, "role"))) {
  throw new Error("DIAGNOSTIC_FRESH_CASE_DIRECTORY_REQUIRED");
}
app.setPath("userData", join(root, "app"));
app.on("window-all-closed", () => undefined);

type Observation = { capturedAt: string; elapsedMs: number; event: string; [key: string]: unknown };
const result = {
  probe: "electron-extension-bootstrap-diagnostic", mode, extensionId,
  startedAt: new Date().toISOString(), finishedAt: null as string | null,
  status: "failed" as "passed" | "failed", strictReady: false,
  nativeLoaded: false, nativeLoadedOnce: false, nativeStartupObserved: false,
  nativeStatus: "pending",
  electronVersion: process.versions.electron, chromiumVersion: process.versions.chrome,
  platform: process.platform, arch: process.arch, browserPid: process.pid,
  elapsedMs: 0, initialWorkerVersionId: null as number | null,
  currentWorker: null as unknown, manifestSha256: "",
  observations: [] as Observation[], errors: [] as string[],
  metrics: [] as unknown[], sample: null as unknown,
  trace: { status: "not-started", categories: [] as string[], file: "trace.json" }
};
let nativeSession: Electron.Session | undefined;
let initialWorker: Electron.ServiceWorkerMain | undefined;
let workerVersion: number | undefined;
let sessions: ChromiumExtensionSessions | undefined;
let handle: { roleId: string; session: Electron.Session } | undefined;
let window: BaseWindow | undefined;
let view: WebContentsView | undefined;
let coreCompletedLoaded = false;
let traceStarted = false;
let finishing = false;
let finished = false;
let sampleAttempted = false;
let sampleTask: Promise<void> = Promise.resolve();
let resolveStartup!: () => void;
let rejectStartup!: (error: Error) => void;
const nativeStartup = new Promise<void>((complete, reject) => { resolveStartup = complete; rejectStartup = reject; });

function observe(event: string, details: Record<string, unknown> = {}): void {
  const entry = { capturedAt: new Date().toISOString(),
    elapsedMs: Math.round((performance.now() - started) * 1000) / 1000, event, ...details };
  if (result.observations.length < 1024) result.observations.push(entry);
  console.log(redactDiagnosticText(JSON.stringify({ probe: result.probe, mode, ...entry })));
}

function errorText(error: unknown): string {
  return (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 4096);
}

function save(): void {
  result.finishedAt = new Date().toISOString();
  result.elapsedMs = Math.round(performance.now() - started);
  writeFileSync(outputPath!, `${redactDiagnosticText(JSON.stringify(result, null, 2))}\n`);
}

function metrics(): Electron.ProcessMetric[] {
  return app.getAppMetrics();
}

function redactFile(path: string): void {
  writeFileSync(path, redactDiagnosticText(readFileSync(path, "utf8")));
}

async function sampleWorker(pid: number): Promise<void> {
  const before = metrics().find(metric => metric.pid === pid);
  result.sample = { pid, status: "unvalidated", metric: before ?? null };
  if (!before || pid === process.pid || !Number.isFinite(before.creationTime) || before.creationTime <= 0) {
    observe("sample-rejected", { pid, reason: "OS_PID_NOT_OWNED_BY_APP_METRICS" });
    return;
  }
  if (process.platform !== "darwin") {
    result.sample = { pid, status: "metrics-only", metric: before };
    observe("sample-metrics-only", { pid, platform: process.platform });
    return;
  }
  // One sample of the exact OS process named by the native preload marker.
  // getInfoFromVersionID.renderProcessId is a virtual ID and is never sampled.
  const identity = async (): Promise<string> => {
    const { stdout } = await execute("/bin/ps", ["-p", String(pid), "-o", "ppid=", "-o", "lstart=", "-o", "comm="],
      { timeout: 10_000, maxBuffer: 16_384 });
    return stdout.trim();
  };
  const filename = `worker-${pid}-native.sample.txt`;
  const samplePath = join(outputDirectory, filename);
  try {
    const beforeIdentity = await identity();
    if (Number(beforeIdentity.split(/\s+/u)[0]) !== process.pid) {
      throw new Error("DIAGNOSTIC_WORKER_PARENT_MISMATCH");
    }
    observe("native-sample-before", { pid, creationTime: before.creationTime });
    await execute("/usr/bin/sample", [String(pid), "2", "10", "-file", samplePath],
      { timeout: 10_000, maxBuffer: 16_384 });
    const afterIdentity = await identity();
    const after = metrics().find(metric => metric.pid === pid);
    const valid = beforeIdentity === afterIdentity && after?.creationTime === before.creationTime;
    result.sample = { pid, status: valid ? "captured" : "identity-retired", file: filename,
      beforeIdentity, afterIdentity, before, after: after ?? null };
    observe("native-sample-after", { pid, identityValidated: valid });
  } catch (error) {
    result.sample = { pid, status: "unavailable", metric: before, error: errorText(error) };
    observe("native-sample-unavailable", { pid, error: errorText(error) });
  } finally {
    // A killed sample process may have written a partial artifact as well.
    if (existsSync(samplePath)) redactFile(samplePath);
  }
}

function onMarker(event: Electron.IpcMainServiceWorkerEvent, payload: unknown): void {
  if (finished || event.type !== "service-worker" || event.session !== nativeSession ||
      event.versionId !== workerVersion || event.serviceWorker.versionId !== workerVersion ||
      event.serviceWorker.scope !== scope || !event.serviceWorker.scriptURL.startsWith(scope) ||
      typeof payload !== "object" || payload === null) return;
  const marker = payload as Record<string, unknown>;
  if (typeof marker.stage !== "string" || !stages.has(marker.stage) ||
      !Number.isSafeInteger(marker.pid) || Number(marker.pid) <= 1 ||
      marker.processType !== "service-worker" || typeof marker.contextIsolated !== "boolean" ||
      Object.keys(marker).some(key => !["stage", "pid", "processType", "contextIsolated"].includes(key))) {
    observe("diagnostic-marker-rejected", { versionId: event.versionId });
    return;
  }
  observe("preload-stage", { ...marker, versionId: event.versionId, scope });
  if (marker.stage === "preload-enter" && !sampleAttempted) {
    sampleAttempted = true;
    sampleTask = sampleWorker(Number(marker.pid)).catch(error => {
      observe("native-sample-unavailable", { error: errorText(error) });
    });
  }
}

function onStatus({ versionId, runningStatus }: Electron.ServiceWorkersRunningStatusChangedEventParams): void {
  if (finished || !nativeSession) return;
  const worker = nativeSession.serviceWorkers.getWorkerFromVersionID(versionId);
  if (workerVersion === undefined && runningStatus === "starting" &&
      worker?.scope === scope && worker.scriptURL.startsWith(scope)) {
    workerVersion = versionId;
    initialWorker = worker;
    result.initialWorkerVersionId = versionId;
    worker.ipc.on(channel, onMarker);
  }
  if (versionId !== workerVersion) return;
  observe("native-worker-status", { versionId, runningStatus, scope,
    workerAvailable: !!worker, workerDestroyed: worker?.isDestroyed() ?? null });
  if (runningStatus === "running") {
    result.nativeStartupObserved = true;
    if (result.nativeStatus !== "native-js-error") result.nativeStatus = "running";
    resolveStartup();
  }
}

function onConsole(_event: Electron.Event, details: Electron.MessageDetails): void {
  if (details.versionId !== workerVersion) return;
  observe("native-worker-console", { ...details, message: details.message.slice(0, 4096) });
  if (mode === "native-only" && details.source === "javascript" && details.level === 3) {
    result.nativeStatus = "native-js-error";
    rejectStartup(new Error("DIAGNOSTIC_NATIVE_ONLY_JAVASCRIPT_ERROR"));
  }
}

function onLoaded(_event: Electron.Event, extension: Electron.Extension): void {
  if (extension.id !== extensionId) return;
  result.nativeLoadedOnce = true;
  observe("native-extension-loaded", { extensionId, version: extension.version });
}

function captureTerminal(): void {
  result.nativeLoaded = nativeSession?.extensions.getExtension(extensionId)?.id === extensionId;
  result.metrics = metrics();
  if (workerVersion === undefined || !nativeSession) return;
  const worker = nativeSession.serviceWorkers.getWorkerFromVersionID(workerVersion);
  let info: unknown;
  try { info = nativeSession.serviceWorkers.getInfoFromVersionID(workerVersion); }
  catch (error) { info = { unavailable: errorText(error) }; }
  result.currentWorker = { versionId: workerVersion, scope,
    available: !!worker, destroyed: worker?.isDestroyed() ?? null, info };
  observe("native-terminal-readback", { nativeLoaded: result.nativeLoaded,
    nativeStartupObserved: result.nativeStartupObserved, currentWorker: result.currentWorker });
}

// External diagnostic-process liveness only; expiry is failure, never readiness.
const deadline = setTimeout(() => {
  if (finished) return;
  result.status = "failed";
  result.errors.push("DIAGNOSTIC_HARNESS_180S_EXPIRED");
  observe("diagnostic-harness-expired");
  sessions?.abandonNativeReleases("DIAGNOSTIC_HARNESS_180S_EXPIRED");
  if (traceStarted) result.trace.status = "unfinished-at-harness-expiry";
  try { captureTerminal(); save(); } catch (error) { console.error(errorText(error)); }
  finished = true;
  app.exit(1);
}, 180_000);

async function finish(passed: boolean, error?: unknown): Promise<void> {
  if (finishing || finished) return;
  finishing = true;
  result.status = passed ? "passed" : "failed";
  if (error !== undefined) result.errors.push(errorText(error));
  observe("diagnostic-case-terminal", { status: result.status, strictReady: result.strictReady });
  try { captureTerminal(); } catch (failure) { result.errors.push(errorText(failure)); result.status = "failed"; }
  await sampleTask;
  if (traceStarted) {
    try {
      await contentTracing.stopRecording(join(outputDirectory, result.trace.file));
      redactFile(join(outputDirectory, result.trace.file));
      result.trace.status = "captured";
      observe("native-trace-saved");
    } catch (failure) { result.trace.status = "failed"; result.errors.push(errorText(failure)); result.status = "failed"; }
  }
  nativeSession?.serviceWorkers.removeListener("running-status-changed", onStatus);
  nativeSession?.serviceWorkers.removeListener("console-message", onConsole);
  nativeSession?.extensions.removeListener("extension-loaded", onLoaded);
  initialWorker?.ipc.removeListener(channel, onMarker);
  try {
    if (sessions && handle && view && window) {
      sessions.retireSurface(handle as never, { window, contents: view.webContents }, false);
      await sessions.release(handle as never);
    } else if (nativeSession?.extensions.getExtension(extensionId)) {
      nativeSession.extensions.removeExtension(extensionId);
    }
    view?.webContents.close();
    window?.close();
  } catch (failure) { result.errors.push(errorText(failure)); result.status = "failed"; }
  if (finished) return;
  try { save(); } catch (failure) { console.error(errorText(failure)); result.status = "failed"; }
  finished = true;
  clearTimeout(deadline);
  app.exit(result.status === "passed" ? 0 : 1);
}

async function run(): Promise<void> {
  if (process.versions.electron !== "44.4.3") throw new Error("DIAGNOSTIC_ELECTRON_VERSION_MISMATCH");
  const bytes = readFileSync(join(packagePath!, "manifest.json"));
  const manifest = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  const derivedId = typeof manifest.key === "string"
    ? createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32)
      .replace(/[0-9a-f]/gu, digit => String.fromCharCode(97 + parseInt(digit, 16))) : null;
  if (derivedId !== extensionId || manifest.manifest_version !== 3 || manifest.version !== "6.49.0" ||
      !Array.isArray(manifest.permissions)) throw new Error("DIAGNOSTIC_PACKAGE_IDENTITY_MISMATCH");
  result.manifestSha256 = createHash("sha256").update(bytes).digest("hex");
  observe("diagnostic-start", { electronVersion: process.versions.electron, browserPid: process.pid });
  const sessionPath = join(root!, "role");
  mkdirSync(sessionPath, { recursive: false });
  nativeSession = session.fromPath(sessionPath, { cache: false });
  window = new BaseWindow({ show: false });
  view = new WebContentsView({ webPreferences: {
    session: nativeSession, sandbox: true, contextIsolation: true, nodeIntegration: false
  } });
  window.contentView.addChildView(view);
  nativeSession.serviceWorkers.on("running-status-changed", onStatus);
  nativeSession.serviceWorkers.on("console-message", onConsole);
  nativeSession.extensions.on("extension-loaded", onLoaded);
  const categories = await contentTracing.getCategories();
  result.trace.categories = categories.filter(category => /service[_-]?worker|extension|ipc|mojo|v8|toplevel|loading/iu.test(category));
  await contentTracing.startRecording({ included_categories: result.trace.categories,
    recording_mode: "record-until-full", trace_buffer_size_in_kb: 65_536, enable_argument_filter: true });
  traceStarted = true;
  result.trace.status = "recording";
  observe("native-trace-started", { categories: result.trace.categories });

  if (mode === "native-only") {
    observe("native-load-before");
    const loaded = nativeSession.extensions.loadExtension(packagePath!, { allowFileAccess: false }).then(extension => {
      if (extension.id !== extensionId) throw new Error("DIAGNOSTIC_NATIVE_EXTENSION_ID_MISMATCH");
      observe("native-load-after", { extensionId });
    });
    await Promise.all([loaded, nativeStartup]);
    if (result.nativeStatus === "native-js-error") throw new Error("DIAGNOSTIC_NATIVE_ONLY_JAVASCRIPT_ERROR");
  } else {
    const packageRecord = { id: extensionId, directory: packagePath,
      requiredApiPermissions: manifest.permissions.filter(permission => typeof permission === "string"), removed: false };
    sessions = new ChromiumExtensionSessions({ invoke: async (input: {
      type: string; command: { type: string; roleId: string; leaseId?: string; status?: string }
    }) => {
      const command = input.command;
      if (input.type !== "extensions" || command.roleId !== roleId ||
          !["acquire", "complete", "release"].includes(command.type) ||
          (command.type !== "acquire" && command.leaseId !== leaseId)) {
        throw new Error("DIAGNOSTIC_CORE_LEASE_OWNER_MISMATCH");
      }
      observe("diagnostic-core-lease", { type: command.type, status: command.status ?? null });
      if (command.type === "complete") coreCompletedLoaded = command.status === "loaded";
      return { lease: { roleId, leaseId, extensionIds: [extensionId] }, snapshot: { installed: [packageRecord] } };
    } } as never, {
      compatibilityPreloadPath: preloadPath,
      logger: { extensionDiagnostic: (level, event, message, context) => {
        observe("producer-diagnostic", { level, producerEvent: event, message, context });
        if (event === "extension_runtime_terminal" && context.extensionId === extensionId &&
            context.roleId === roleId && context.stage === "bootstrap" && context.status === "loaded" &&
            context.code === "ELECTRON_EXTENSION_READY") result.strictReady = true;
      } }
    });
    handle = { roleId, session: nativeSession };
    observe("strict-prepare-before");
    await sessions.prepare(handle as never, { window, contents: view.webContents });
    observe("strict-prepare-after", { strictReady: result.strictReady, coreCompletedLoaded });
    if (!result.strictReady || !coreCompletedLoaded || !result.nativeStartupObserved) {
      throw new Error("DIAGNOSTIC_STRICT_PRODUCT_READY_NOT_OBSERVED");
    }
  }
  if (nativeSession.extensions.getExtension(extensionId)?.id !== extensionId) {
    throw new Error("DIAGNOSTIC_NATIVE_EXTENSION_NOT_CURRENT");
  }
  if (createHash("sha256").update(readFileSync(join(packagePath!, "manifest.json"))).digest("hex") !== result.manifestSha256) {
    throw new Error("DIAGNOSTIC_PACKAGE_MANIFEST_CHANGED");
  }
  await finish(true);
}

function unexpectedFailure(error: unknown): void {
  if (finishing && !finished) { result.errors.push(errorText(error)); result.status = "failed"; }
  else void finish(false, error);
}
process.on("uncaughtException", unexpectedFailure);
process.on("unhandledRejection", unexpectedFailure);
void app.whenReady().then(run).catch(error => finish(false, error));
