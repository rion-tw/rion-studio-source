const { app, session, WebContentsView } = require("electron");
const { readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { createServer } = require("node:http");
const { join, isAbsolute } = require("node:path");
const assert = require("node:assert/strict");

const root = process.env.RION_EXTENSIONS_PROBE_DIR;
const phase = process.env.RION_EXTENSIONS_PROBE_PHASE;
if (!root || !isAbsolute(root) || !["seed", "restart"].includes(phase)) throw new Error("Isolated probe root and phase required");
if (!["darwin", "win32"].includes(process.platform)) throw new Error("A supported native host is required");
app.setPath("userData", join(root, "app"));
// DeadlineBound diagnostic: absent native acknowledgement fails the probe.
const deadline = setTimeout(() => { console.error("Extension probe deadline exceeded"); app.exit(2); }, 30000);

void app.whenReady().then(async () => {
  const extensionPath = join(root, "extension");
  if (phase === "seed") {
    mkdirSync(extensionPath, { recursive: true });
    const { publicKey } = JSON.parse(readFileSync(join(__dirname, "../crates/rion-core/src/extensions/test-signing-key.json"), "utf8"));
    writeFileSync(join(extensionPath, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Rion isolated extension fixture", version: "1.0", key: publicKey,
      permissions: ["storage"], background: { service_worker: "background.js" },
      content_scripts: [{ matches: ["http://127.0.0.1/*"], js: ["content.js"], run_at: "document_end" }] }));
    writeFileSync(join(extensionPath, "background.js"), `chrome.runtime.onMessage.addListener((message, sender, reply) => {
      chrome.storage.local.get('value', data => {
        if (message.write) chrome.storage.local.set({value:message.write}, () => reply({value:message.write}));
        else reply({value:data.value ?? null});
      }); return true;
    });`);
    writeFileSync(join(extensionPath, "content.js"), `document.body.dataset.extension = chrome.runtime.id;
      chrome.runtime.sendMessage({write:new URL(location.href).searchParams.get('write')}, reply => {
        console.log('RION_EXTENSION_REPLY=' + JSON.stringify(reply ?? {error:chrome.runtime.lastError?.message}));
      });`);
  }
  const server = createServer((_request, response) => response.end("<html><body>Isolated fixture</body></html>"));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function observe(nativeSession, write, enabled = true) {
    const view = new WebContentsView({ webPreferences: { session: nativeSession, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const reply = enabled ? new Promise(resolve => view.webContents.on("console-message", event => {
      if (event.message.startsWith("RION_EXTENSION_REPLY=")) resolve(JSON.parse(event.message.slice("RION_EXTENSION_REPLY=".length)));
    })) : Promise.resolve(null);
    await view.webContents.loadURL(`${origin}/?write=${write ?? ""}`);
    const value = await reply;
    const id = await view.webContents.executeJavaScript("document.body.dataset.extension ?? null");
    view.webContents.close();
    return { value, id };
  }
  const a = session.fromPath(join(root, "a"));
  const b = session.fromPath(join(root, "b"));
  const unloaded = await observe(a, null, false);
  assert.equal(unloaded.id, null, "An extension must be explicitly loaded on each process boot");
  const extA = await a.extensions.loadExtension(extensionPath, { allowFileAccess: false });
  const extB = await b.extensions.loadExtension(extensionPath, { allowFileAccess: false });
  assert.equal(extA.id, extB.id);
  if (phase === "seed") {
    assert.deepEqual((await observe(a, "role-a")).value, { value: "role-a" });
    assert.deepEqual((await observe(b)).value, { value: null });
    assert.deepEqual((await observe(b, "role-b")).value, { value: "role-b" });
    writeFileSync(join(root, "expected-id"), extA.id);
  } else assert.equal(extA.id, readFileSync(join(root, "expected-id"), "utf8"));
  assert.deepEqual((await observe(a)).value, { value: "role-a" });
  assert.deepEqual((await observe(b)).value, { value: "role-b" });
  const removed = new Promise(resolve => a.extensions.once("extension-unloaded", (_event, extension) => {
    assert.equal(extension.id, extA.id); resolve();
  }));
  a.extensions.removeExtension(extA.id);
  await removed;
  assert.equal((await observe(a, null, false)).id, null);
  await a.extensions.loadExtension(extensionPath, { allowFileAccess: false });
  assert.deepEqual((await observe(a)).value, { value: "role-a" });
  a.flushStorageData(); b.flushStorageData();
  await new Promise(resolve => server.close(resolve));
  console.log(`RION_EXTENSIONS_PROBE=${JSON.stringify({ phase, platform: process.platform, electron: process.versions.electron, id: extA.id, isolated: true, unloadVerified: true })}`);
  clearTimeout(deadline);
  app.quit();
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
