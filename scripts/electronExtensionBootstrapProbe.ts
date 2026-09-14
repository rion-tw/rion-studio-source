import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { app, BaseWindow, session, WebContentsView } from "electron";
import { ChromiumExtensionSessions } from "../src/electron/main/chromiumExtensionSessions";
import { clearChromiumExtensionRuntimeDiagnosticsForTests, recentChromiumExtensionRuntimeDiagnostics }
  from "../src/electron/main/chromiumExtensionRuntimeDiagnostics";
import { createHash } from "node:crypto";

const root = process.env.RION_EXTENSION_BOOTSTRAP_PROBE_DIR;
const preloadPath = process.env.RION_EXTENSION_COMPAT_PRELOAD;
const phase = process.env.RION_EXTENSION_BOOTSTRAP_PROBE_PHASE;
if (!root || !preloadPath || !isAbsolute(root) || !isAbsolute(preloadPath)) {
  throw new Error("The bootstrap probe requires isolated absolute paths.");
}
app.setPath("userData", join(root, "bootstrap-app"));
app.on("window-all-closed", () => undefined);

async function runFixture(kind: "failure" | "success"): Promise<void> {
  clearChromiumExtensionRuntimeDiagnosticsForTests();
  const directory = join(root!, `bootstrap-${kind}`);
  mkdirSync(directory, { recursive: true });
  // A stable manifest key preserves identity across the fresh-process restart.
  const key = Buffer.from(`rion-bootstrap-probe-${kind}`).toString("base64");
  const id = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex")
    .slice(0, 32).replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
  if (phase === "seed") {
    writeFileSync(join(directory, "manifest.json"), JSON.stringify({
      manifest_version: 3, name: `Bootstrap ${kind} probe`, version: "1.0.0", key,
      background: { service_worker: "background.js" }, permissions: ["storage", "contextMenus"]
    }));
    writeFileSync(join(directory, "background.js"), kind === "failure"
      ? "chrome.contextMenus.onClicked.addListener(() => {}); throw new TypeError('bootstrap fixture failure');"
      : "console.warn('expected warning'); console.error('handled nonfatal error'); chrome.runtime.onInstalled.addListener(() => {});");
  }
  const nativeSession = session.fromPath(join(root!, `${kind}-role`), { cache: false });
  const events: string[] = [];
  nativeSession.serviceWorkers.on("console-message", (_event, details) => {
    events.push(`console:${details.source}:${details.level}`);
  });
  nativeSession.extensions.on("extension-unloaded", (_event, extension) => {
    if (extension.id === id) events.push("unloaded");
  });
  const window = new BaseWindow({ show: false });
  const view = new WebContentsView({ webPreferences: {
    contextIsolation: true, nodeIntegration: false, sandbox: true, session: nativeSession
  } });
  window.contentView.addChildView(view);
  const core = { invoke: async (input: { command: { type: string; status?: string } }) => {
    events.push(`core:${input.command.type}:${input.command.status ?? ""}`);
    return { lease: { roleId: kind, leaseId: `${phase}-${kind}`, extensionIds: [id] },
      snapshot: { installed: [{ id, directory, requiredApiPermissions: ["storage", "contextMenus"], removed: false }] } };
  } };
  const sessions = new ChromiumExtensionSessions(core as never, { compatibilityPreloadPath: preloadPath });
  const handle = { roleId: kind, session: nativeSession };
  const surface = { contents: view.webContents, window };
  await sessions.prepare(handle as never, surface);
  const diagnostics = recentChromiumExtensionRuntimeDiagnostics();
  if (kind === "failure") {
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].code, "ELECTRON_EXTENSION_SERVICE_WORKER_RUNTIME_ERROR");
    assert.equal(diagnostics[0].relativeFile, "background.js");
    assert.equal(diagnostics[0].line, 1);
    assert.equal(nativeSession.extensions.getAllExtensions().length, 0);
    assert(events.indexOf("console:javascript:3") < events.indexOf("unloaded"));
    assert(events.indexOf("unloaded") < events.indexOf("core:complete:degraded"));
  } else {
    assert.equal(diagnostics[0]?.code, "ELECTRON_EXTENSION_READY");
    assert(events.includes("console:console-api:3"));
    assert(events.includes("core:complete:loaded"));
    assert.equal(nativeSession.extensions.getAllExtensions().length, 1);
  }
  sessions.retireSurface(handle as never, surface, false);
  await sessions.release(handle as never);
  view.webContents.close(); window.close();
  console.log(JSON.stringify({ probe: "extension-bootstrap", phase, kind, events, diagnostics }));
}

// Test harness liveness only; expiration fails the probe, never a product result.
const deadline = setTimeout(() => { console.error("Bootstrap probe did not finish"); app.exit(1); }, 30_000);
void app.whenReady().then(async () => {
  await runFixture("failure");
  await runFixture("success");
  clearTimeout(deadline); app.exit(0);
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
