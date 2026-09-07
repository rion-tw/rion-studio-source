// Isolated source-data precondition. Never opens a user's Chrome profile.
const { app, BrowserWindow, session } = require("electron");
const { mkdirSync, writeFileSync } = require("node:fs");
const { isAbsolute, join } = require("node:path");

const [root, origin] = process.argv.slice(2);
if (!root || !isAbsolute(root) || !root.endsWith("chrome-import-source") ||
    new URL(origin).hostname !== "127.0.0.1") {
  throw new Error("The Chrome import source fixture requires an isolated root and loopback origin");
}
mkdirSync(root, { recursive: true });
app.setPath("userData", join(root, "fixture-host"));
app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  const store = session.fromPath(join(root, "Default"));
  // A fixed fixture protocol gives real Chromium origin-keyed DOM Storage
  // without connecting a browser profile to the product runtime.
  store.protocol.handle("http", request => {
    if (![origin, "http://excluded.example.test"].includes(new URL(request.url).origin)) {
      throw new Error("Unexpected fixture origin");
    }
    return new Response("<!doctype html><title>Import source fixture</title>", {
      headers: { "content-type": "text/html" }
    });
  });
  const window = new BrowserWindow({
    show: false,
    webPreferences: { session: store, sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  for (const url of [origin, "http://excluded.example.test"]) {
    await window.loadURL(url);
    await window.webContents.executeJavaScript(
      'localStorage.setItem("rion-e2e-session", "chrome-import-marker")'
    );
  }
  store.flushStorageData();
  await store.cookies.flushStore();
  window.destroy();
  writeFileSync(join(root, "Local State"), JSON.stringify({
    profile: { info_cache: { Default: { name: "Chromium Import Role" } } }
  }));
  app.quit();
}).catch(error => {
  process.stderr.write(String(error.stack ?? error) + "\n");
  app.exit(1);
});
