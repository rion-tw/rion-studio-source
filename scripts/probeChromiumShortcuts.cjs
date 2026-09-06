// Isolated Windows API comparison. Never imported by production code.
const { app, BrowserWindow, WebContentsView, Menu } = require("electron");
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const { writeFile } = require("node:fs/promises");
const { resolve, join } = require("node:path");
const [reportPath, userData] = process.argv.slice(2);
if (process.platform !== "win32" || !reportPath || !userData) {
  throw new Error("Use bundled Electron on Windows: probeChromiumShortcuts.cjs REPORT USER_DATA");
}
app.setPath("userData", resolve(userData));
app.on("window-all-closed", () => {});
const root = resolve(__dirname, "..");
const fixture = "data:text/html," + encodeURIComponent(
  '<!doctype html><title>Shortcut probe</title><body tabindex="0">Isolated shortcut surface</body>'
);
// Test observation boundary only: an empty sample is not proof of suppression.
const observe = () => new Promise(resolveObservation => setTimeout(resolveObservation, 150));
const F11 = 0x7a;
const SHIFT = 0x10;

function inputDriver() {
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", join(root, "tests/fixtures/chromium-shortcuts/send-input.ps1")],
  { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const pending = new Map();
  let nextId = 0;
  let readyResolve;
  let readyReject;
  let failure;
  const ready = new Promise((resolveReady, rejectReady) => {
    readyResolve = resolveReady;
    readyReject = rejectReady;
  });
  const fail = error => {
    failure = error;
    readyReject(error);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  child.on("error", fail);
  child.on("exit", (code, signal) => fail(new Error(`Input driver exited: ${code}/${signal}`)));
  child.stderr.on("data", chunk => process.stderr.write(chunk));
  createInterface({ input: child.stdout }).on("line", line => {
    let result;
    try { result = JSON.parse(line); } catch { fail(new Error(`Invalid input receipt: ${line}`)); return; }
    if (result.ready) { readyResolve(); return; }
    const request = pending.get(result.id);
    if (!request) { fail(new Error("Unexpected native input receipt")); return; }
    pending.delete(result.id);
    if (result.error) request.reject(new Error(result.error));
    else request.resolve(result);
  });
  return {
    async send(host, keys, focus = false) {
      await ready;
      if (failure) throw failure;
      const id = ++nextId;
      const handle = host.getNativeWindowHandle().readBigUInt64LE().toString();
      const result = new Promise((resolveResult, reject) => pending.set(id, { resolve: resolveResult, reject }));
      child.stdin.write(JSON.stringify({ id, handle, processId: process.pid, keys, focus }) + "\n");
      const receipt = await result;
      if (receipt.inserted !== keys.length) throw new Error("Incomplete native input insertion");
      return receipt;
    },
    close() { child.stdin.end(); }
  };
}

async function probe() {
  const addon = require(join(root, "build/native", `win32-${process.arch}`, "rion-core.node"));
  const options = { show: false, width: 640, height: 480,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } };
  const host = new BrowserWindow(options);
  const popup = new BrowserWindow(options);
  const role = new WebContentsView({ webPreferences: options.webPreferences });
  const web = new WebContentsView({ webPreferences: options.webPreferences });
  const surfaces = [
    { name: "main", host, contents: host.webContents },
    { name: "role-view", host, contents: role.webContents, view: role },
    { name: "global-web-view", host, contents: web.webContents, view: web },
    { name: "popup", host: popup, contents: popup.webContents }
  ];
  host.contentView.addChildView(role);
  host.contentView.addChildView(web);
  for (const view of [role, web]) view.setBounds({ x: 0, y: 0, width: 600, height: 400 });
  const driver = inputDriver();
  const outcomes = [];
  let nativeRegistered = false;
  let activeHost = host;
  let mode = "observe";
  let events = [];
  let stage = "setup";
  const record = (kind, details = {}) => events.push({ kind, stage, ...details });
  try {
    for (const surface of surfaces) {
      await surface.contents.loadURL(fixture);
      await surface.contents.executeJavaScript(`window.shortcutEvents = [];
        for (const type of ['keydown', 'keyup']) document.addEventListener(type, event => {
          if (event.code === 'F11') window.shortcutEvents.push({ type, trusted: event.isTrusted,
            repeat: event.repeat, shift: event.shiftKey });
        }, true);`);
      let captured = false;
      surface.contents.on("before-input-event", (event, input) => {
        if (input.code !== "F11" && input.key !== "F11") return;
        record("before-input", { surface: surface.name, type: input.type,
          repeat: input.isAutoRepeat, shift: input.shift });
        if (mode !== "before-input") return;
        const plain = !input.shift && !input.alt && !input.meta && !input.control;
        if (input.type === "keyDown" && (captured || plain)) {
          captured = true;
          event.preventDefault();
        } else if (input.type === "keyUp" && captured) {
          captured = false;
          event.preventDefault();
          record("command", { surface: surface.name });
        }
      });
    }
    for (mode of ["native-hook", "before-input", "menu"]) {
      Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: "Probe", submenu: [{
        label: "Fullscreen probe", accelerator: "F11", registerAccelerator: mode === "menu",
        click: () => record("command", { surface: "menu-owner" })
      }] }]));
      for (const surface of surfaces) {
        activeHost = surface.host;
        role.setVisible(surface.view === role);
        web.setVisible(surface.view === web);
        activeHost.show();
        await driver.send(activeHost, [], true);
        surface.contents.focus();
        if (mode === "native-hook") {
          const nativeHandle = activeHost.getNativeWindowHandle();
          addon.registerWindowsRuntimeShortcutOwner(nativeHandle, "1", () => {
            addon.acknowledgeWindowsRuntimeShortcutOwner(nativeHandle, "1");
            record("command", { surface: surface.name });
          }, message => record("native-error", { message }));
          nativeRegistered = true;
        }
        try {
          for (const scenario of ["plain", "repeat", "modifier-during-press"]) {
            events = [];
            await surface.contents.executeJavaScript("window.shortcutEvents = []");
            stage = "down";
            await driver.send(activeHost, [{ code: F11, up: false }]);
            await observe();
            const commandsBeforeRelease = events.filter(event => event.kind === "command").length;
            if (scenario === "repeat") {
              stage = "repeat";
              await driver.send(activeHost, [{ code: F11, up: false }]);
              await observe();
            }
            if (scenario === "modifier-during-press") {
              stage = "modifier";
              await driver.send(activeHost, [{ code: SHIFT, up: false }]);
              await observe();
            }
            stage = "up";
            await driver.send(activeHost, [{ code: F11, up: true },
              ...(scenario === "modifier-during-press" ? [{ code: SHIFT, up: true }] : [])]);
            await observe();
            outcomes.push({ mode, surface: surface.name, scenario, commandsBeforeRelease,
              events: [...events], hostFocused: activeHost.isFocused(),
              pageEvents: await surface.contents.executeJavaScript("window.shortcutEvents") });
          }
        } finally {
          if (nativeRegistered) {
            addon.unregisterWindowsRuntimeShortcutOwner(activeHost.getNativeWindowHandle(), "1");
            nativeRegistered = false;
          }
        }
      }
    }
    await writeFile(reportPath, JSON.stringify({ platform: process.platform,
      electron: process.versions.electron, chromium: process.versions.chrome,
      scope: "isolated native windows and WebContentsViews; not production Role replacement parity",
      outcomes }, null, 2) + "\n");
  } finally {
    // Always release test-owned keys before retiring the exact foreground HWND.
    await driver.send(activeHost, [{ code: F11, up: true }, { code: SHIFT, up: true }]).catch(() => {});
    driver.close();
    for (const view of [role, web]) view.webContents.close();
    popup.destroy();
    host.destroy();
  }
}
app.whenReady().then(probe).then(() => app.quit()).catch(error => {
  console.error(error);
  app.exit(1);
});
