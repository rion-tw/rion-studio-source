import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { isAbsolute, join } from "node:path";
import { app, BaseWindow, session, WebContentsView } from "electron";
import { ChromiumExtensionSessions } from "../src/electron/main/chromiumExtensionSessions";
import { recentChromiumExtensionRuntimeDiagnostics } from "../src/electron/main/chromiumExtensionRuntimeDiagnostics";

const root = process.env.RION_EXTENSION_FILTERING_ROOT;
const preloadPath = process.env.RION_EXTENSION_COMPAT_PRELOAD;
const packagePath = process.env.RION_EXTENSION_FILTERING_PACKAGE;
const blockedPath = process.env.RION_EXTENSION_FILTERING_BLOCKED_PATH ?? "/blocked.js";
const phase = process.env.RION_EXTENSION_FILTERING_PHASE;
if (!root || !preloadPath || !isAbsolute(root) || !isAbsolute(preloadPath) ||
  !["seed", "restart"].includes(phase ?? "") || (packagePath && !isAbsolute(packagePath))) {
  throw new Error("Filtering probe requires isolated absolute paths and a phase.");
}
app.setPath("userData", join(root, "app"));
app.on("window-all-closed", () => undefined);
// External test-process liveness only. Expiration is failure, never evidence.
const deadline = setTimeout(() => { console.error("Filtering probe deadline exceeded"); app.exit(1); }, 120_000);

void app.whenReady().then(async () => {
  const directory = join(root, "extension");
  if (phase === "seed") {
    if (packagePath) cpSync(packagePath, directory, { recursive: true });
    else {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "manifest.json"), JSON.stringify({
        manifest_version: 3, name: "Generic filtering fixture", version: "1.0",
        key: Buffer.from("rion-filtering-fixture").toString("base64"),
        background: { service_worker: "background.js", type: "module" },
        permissions: ["declarativeNetRequest", "storage", "scripting", "alarms"],
        host_permissions: ["http://127.0.0.1/*"],
        declarative_net_request: { rule_resources: [{ id: "filter", path: "rules.json", enabled: true }] },
        content_scripts: [{ matches: ["http://127.0.0.1/*"], css: ["hide.css"] }]
      }));
      writeFileSync(join(directory, "dependency.js"), `
        export const api = self.browser || self.chrome;
        api.permissions.onRemoved.addListener(() => {});
        api.commands.onCommand.addListener(() => {});
        api.alarms.onAlarm.addListener(() => {});
      `);
      writeFileSync(join(directory, "background.js"), `
        import { api } from './dependency.js';
        api.permissions.onAdded.addListener(() => {});
        api.commands.onCommand.addListener(() => {});
        api.alarms.onAlarm.addListener(() => {});
      `);
      writeFileSync(join(directory, "rules.json"), JSON.stringify([{
        id: 1, action: { type: "block" }, condition: { urlFilter: blockedPath, resourceTypes: ["main_frame", "xmlhttprequest"] }
      }]));
      writeFileSync(join(directory, "hide.css"), "#cosmetic-target { display: none !important; }");
    }
  }
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  const id = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex")
    .slice(0, 32).replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url!);
    response.setHeader("Cache-Control", "no-store");
    if (request.url!.split("?")[0] === "/") {
      response.setHeader("Content-Type", "text/html");
      response.end('<!doctype html><body><div id="cosmetic-target" class="adsbox">advertisement</div><div id="normal">normal content</div></body>');
    } else { response.setHeader("Content-Type", "text/javascript"); response.end("/* fixture */"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const packageRecord = { id, directory, requiredApiPermissions: manifest.permissions ?? [], removed: false };
  const outcomes: unknown[] = [];
  const sessions = new ChromiumExtensionSessions({ invoke: async (input: {
    command: { type: string; roleId: string; status?: string }
  }) => {
    if (input.command.type === "complete") outcomes.push(input.command);
    return { lease: { roleId: input.command.roleId, leaseId: `${phase}-${input.command.roleId}`, extensionIds: [id] },
      snapshot: { installed: [packageRecord] } };
  } } as never, { compatibilityPreloadPath: preloadPath });
  const handles = new Map<string, { roleId: string; session: Electron.Session }>();
  async function observe(roleId: string, loaded: boolean, label: string) {
    const handle = handles.get(roleId) ?? { roleId, session: session.fromPath(join(root!, roleId), { cache: false }) };
    handles.set(roleId, handle);
    const window = new BaseWindow({ show: false });
    const view = new WebContentsView({ webPreferences: {
      session: handle.session, sandbox: true, contextIsolation: true, nodeIntegration: false
    } });
    window.contentView.addChildView(view);
    const surface = { window, contents: view.webContents };
    const workerErrors: string[] = [];
    const onConsole = (_event: Electron.Event, details: Electron.MessageDetails) => {
      if (details.level === 3) workerErrors.push(`${details.source}:${details.message}`);
    };
    handle.session.serviceWorkers.on("console-message", onConsole);
    if (loaded) {
      await sessions.prepare(handle as never, surface);
      assert.equal(handle.session.extensions.getExtension(id)?.id, id, "Extension must remain loaded");
    }
    await view.webContents.loadURL(origin);
    const token = `${phase}-${label}`;
    const before = requests.length;
    const result = await view.webContents.executeJavaScript(`(async () => {
      const check = async path => { try { const r = await fetch(path); return r.ok; } catch { return false; } };
      return { allowed: await check('/normal.js?${token}'), blocked: await check(${JSON.stringify(`${blockedPath}?${token}`)}),
        cosmeticHidden: getComputedStyle(document.querySelector('#cosmetic-target')).display === 'none',
        normalVisible: getComputedStyle(document.querySelector('#normal')).display !== 'none' };
    })()`);
    const received = requests.slice(before);
    let nativeError: string | undefined;
    if (!packagePath) {
      try { await view.webContents.loadURL(`${origin}${blockedPath}?native-${token}`); }
      catch (error) { nativeError = String(error); }
      assert.equal(nativeError?.includes("ERR_BLOCKED_BY_CLIENT") ?? false, loaded);
    }
    assert.equal(result.allowed, true);
    assert.equal(result.normalVisible, true);
    assert.equal(result.blocked, !loaded);
    assert.equal(received.includes(`${blockedPath}?${token}`), !loaded);
    assert.deepEqual(workerErrors, [], "Post-navigation worker failures must not be hidden by READY");
    if (!packagePath) assert.equal(result.cosmeticHidden, loaded);
    console.log(JSON.stringify({ probe: "filtering", phase, label, roleId, loaded, result, received, nativeError }));
    if (loaded && label === "open") {
      const workers = handle.session.serviceWorkers;
      const scope = `chrome-extension://${id}/`;
      const worker = await workers.startWorkerForScope(scope);
      // Observe Chromium's actual idle termination; elapsed time is not evidence.
      await new Promise<void>(resolve => {
        const stopped = ({ versionId, runningStatus }: Electron.ServiceWorkersRunningStatusChangedEventParams) => {
          if (versionId !== worker.versionId || runningStatus !== "stopped") return;
          workers.removeListener("running-status-changed", stopped); resolve();
        };
        workers.on("running-status-changed", stopped);
      });
      assert.equal(worker.isDestroyed(), true);
      const restarted = await workers.startWorkerForScope(scope);
      assert.equal(restarted.scope, scope);
      await view.webContents.loadURL(origin);
      const receiptStart = requests.length;
      const restartedResult = await view.webContents.executeJavaScript(`(async () => {
        const check = async path => { try { return (await fetch(path)).ok; } catch { return false; } };
        return { allowed: await check('/normal.js?worker-${token}'),
          blocked: await check(${JSON.stringify(`${blockedPath}?worker-${token}`)}) };
      })()`);
      assert.deepEqual(restartedResult, { allowed: true, blocked: false });
      const restartedReceipts = requests.slice(receiptStart);
      assert.equal(restartedReceipts.includes(`/normal.js?worker-${token}`), true);
      assert.equal(restartedReceipts.includes(`${blockedPath}?worker-${token}`), false);
      assert.deepEqual(workerErrors, []);
      console.log(JSON.stringify({ probe: "filtering-worker-restart", phase, roleId,
        result: restartedResult, received: restartedReceipts }));
    }
    if (loaded) { sessions.retireSurface(handle as never, surface, false); await sessions.release(handle as never); }
    handle.session.serviceWorkers.removeListener("console-message", onConsole);
    view.webContents.close(); window.close();
  }
  await observe("unassigned", false, "baseline");
  await observe("assigned", true, "open");
  await observe("assigned", true, "reopen");
  await observe("unassigned", false, "isolation");
  console.log(JSON.stringify({ probe: "filtering-terminal", phase, outcomes, diagnostics: recentChromiumExtensionRuntimeDiagnostics() }));
  await new Promise<void>(resolve => server.close(() => resolve()));
  clearTimeout(deadline); app.quit();
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
