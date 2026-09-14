import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { isAbsolute, join } from "node:path";

import { app, BaseWindow, session, WebContentsView } from "electron";

import { RionChromeExtensions } from
  "../third_party/electron-chrome-extensions/src/browser/rion";
import type { CompatibilityReadyRecord } from
  "../third_party/electron-chrome-extensions/src/browser/api/compatibility";

const root = process.env.RION_EXTENSION_COMPAT_PROBE_DIR;
const preloadPath = process.env.RION_EXTENSION_COMPAT_PRELOAD;
const signingKeyPath = process.env.RION_EXTENSION_COMPAT_SIGNING_KEY;
if (
  !root || !preloadPath || !signingKeyPath ||
  !isAbsolute(root) || !isAbsolute(preloadPath) || !isAbsolute(signingKeyPath)
) {
  throw new Error("The compatibility probe requires absolute isolated paths.");
}
app.setPath("userData", join(root, "app"));

function withDeadline<Value>(promise: Promise<Value>): Promise<Value> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Extension compatibility probe deadline exceeded.")), 20_000);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, reject);
  });
}

void app.whenReady().then(async () => {
  const extensionPath = join(root, "compat-extension");
  mkdirSync(extensionPath, { recursive: true });
  const { publicKey } = JSON.parse(readFileSync(
    signingKeyPath,
    "utf8"
  ));
  writeFileSync(join(extensionPath, "manifest.json"), JSON.stringify({
    background: { service_worker: "background.js" },
    content_scripts: [{
      js: ["content.js"],
      matches: ["http://127.0.0.1/*"],
      run_at: "document_end"
    }],
    declarative_net_request: { rule_resources: [
      { enabled: true, id: "probe", path: "rules.json" },
      { enabled: false, id: "disabled", path: "rules.json" }
    ] },
    host_permissions: ["http://127.0.0.1/*"],
    key: publicKey,
    manifest_version: 3,
    name: "Rion extension compatibility probe",
    permissions: ["contextMenus", "declarativeNetRequest", "notifications", "offscreen", "storage", "webNavigation"],
    optional_permissions: ["management"],
    version: "1.0.0"
  }));
  writeFileSync(join(extensionPath, "rules.json"), JSON.stringify([{
    action: { type: "block" },
    condition: { resourceTypes: ["xmlhttprequest"], urlFilter: "||blocked.invalid^" },
    id: 1,
    priority: 1
  }]));
  writeFileSync(join(extensionPath, "offscreen.html"), "<!doctype html><title>probe</title>");
  writeFileSync(join(extensionPath, "background.js"), `
    const removed = () => undefined;
    chrome.permissions.onRemoved.addListener(removed);
    chrome.webNavigation.onCompleted.addListener(() => undefined);
    chrome.runtime.onMessage.addListener((_message, _sender, reply) => {
      void (async () => {
        await chrome.storage.session.set({ probe: 'ready' });
        const stored = await chrome.storage.session.get('probe');
        const managementBefore = await chrome.permissions.contains({ permissions: ['management'] });
        const managementGranted = await chrome.permissions.request({ permissions: ['management'] });
        const managementAfter = await chrome.permissions.contains({ permissions: ['management'] });
        const self = await chrome.management.getSelf();
        let managementListDenied = false;
        try {
          await chrome.management.getAll();
        } catch {
          managementListDenied = true;
        }
        const menuId = chrome.contextMenus.create({ id: 'probe-menu', title: 'Probe menu' });
        const duplicateMenuDenied = await new Promise(resolve => {
          chrome.contextMenus.create({ id: 'probe-menu', title: 'Duplicate' }, () => resolve(Boolean(chrome.runtime.lastError)));
        });
        const unavailableTab = await new Promise(resolve => {
          chrome.tabs.create({ url: 'https://example.invalid/' }, result => resolve({
            resultMissing: result === undefined, error: chrome.runtime.lastError?.message
          }));
        });
        const lastErrorCleared = chrome.runtime.lastError === undefined;
        const missingMenu = await new Promise(resolve => {
          chrome.contextMenus.update('missing-menu', { title: 'Missing' }, () => resolve(chrome.runtime.lastError?.message));
        });
        await chrome.contextMenus.update('probe-menu', { title: 'Updated probe menu' });
        await chrome.contextMenus.remove('probe-menu');
        await chrome.contextMenus.removeAll();
        const permissionLevel = await chrome.notifications.getPermissionLevel();
        const tabs = await chrome.tabs.query({ active: true });
        const enabledRulesets = await chrome.declarativeNetRequest.getEnabledRulesets();
        await chrome.offscreen.createDocument({
          url: 'offscreen.html', reasons: ['DOM_PARSER'], justification: 'compatibility probe'
        });
        const offscreenCreated = await chrome.offscreen.hasDocument();
        await chrome.offscreen.closeDocument();
        reply({
          menuId, duplicateMenuDenied, unavailableTab, lastErrorCleared, missingMenu,
          managementBefore, managementGranted, managementAfter, managementListDenied,
          managementSelf: self.id === chrome.runtime.id,
          enabledRulesets,
          notificationApi: typeof permissionLevel === 'string',
          offscreenCreated,
          permissionsOnRemoved: chrome.permissions.onRemoved.hasListener(removed),
          sessionStorage: stored.probe,
          tabCount: tabs.length,
          webNavigation: typeof chrome.webNavigation.onCompleted.addListener === 'function'
        });
      })().catch(error => reply({ error: String(error) }));
      return true;
    });
  `);
  writeFileSync(join(extensionPath, "content.js"), `
    chrome.runtime.sendMessage({ probe: true }, reply => {
      console.log('RION_EXTENSION_COMPAT_REPLY=' + JSON.stringify(reply ?? {
        error: chrome.runtime.lastError?.message
      }));
    });
  `);

  const rolePath = join(root, "role");
  mkdirSync(rolePath, { recursive: true });
  const nativeSession = session.fromPath(rolePath, { cache: false });
  let resolveReady!: (record: CompatibilityReadyRecord) => void;
  const ready = new Promise<CompatibilityReadyRecord>((resolve) => { resolveReady = resolve; });
  const host = new RionChromeExtensions({
    license: "GPL-3.0",
    onCompatibilityReady: (_extensionId, record) => resolveReady(record),
    preloadPath,
    requestPermissions: async () => false,
    session: nativeSession
  });
  const window = new BaseWindow({ show: false });
  const view = new WebContentsView({ webPreferences: {
    contextIsolation: true, nodeIntegration: false, sandbox: true, session: nativeSession
  } });
  window.contentView.addChildView(view);
  host.addTab(view.webContents, window);
  const response = new Promise<Record<string, unknown>>((resolveResponse) => {
    view.webContents.on("console-message", (event) => {
      if (event.message.startsWith("RION_EXTENSION_COMPAT_REPLY=")) {
        resolveResponse(JSON.parse(event.message.slice("RION_EXTENSION_COMPAT_REPLY=".length)));
      }
    });
  });
  const server = createServer((_request, output) => output.end("<!doctype html><body>probe</body>"));
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const extension = await nativeSession.extensions.loadExtension(extensionPath, { allowFileAccess: false });
  const receipt = await withDeadline(ready);
  assert.equal(receipt.staticRulesetStatus, "enabled");
  assert(receipt.availableApis.includes("permissions"));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Compatibility probe server missing.");
  await view.webContents.loadURL(`http://127.0.0.1:${address.port}/`);
  const result = await withDeadline(response);
  assert.deepEqual(result, {
    menuId: "probe-menu", duplicateMenuDenied: true,
    unavailableTab: { resultMissing: true, error: 'RION_EXTENSION_API_UNAVAILABLE:tabs.create' },
    lastErrorCleared: true,
    missingMenu: 'RION_CONTEXT_MENU_NOT_FOUND',
    managementBefore: false,
    managementGranted: false,
    managementAfter: false,
    managementListDenied: true,
    managementSelf: true,
    enabledRulesets: ["probe"],
    notificationApi: true,
    offscreenCreated: true,
    permissionsOnRemoved: true,
    sessionStorage: "ready",
    tabCount: 1,
    webNavigation: true
  });
  nativeSession.extensions.removeExtension(extension.id);
  host.removeTab(view.webContents);
  view.webContents.close();
  window.destroy();
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  console.log(`RION_EXTENSION_COMPAT_PROBE=${JSON.stringify({
    electron: process.versions.electron,
    extensionId: extension.id,
    platform: process.platform,
    result
  })}`);
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
