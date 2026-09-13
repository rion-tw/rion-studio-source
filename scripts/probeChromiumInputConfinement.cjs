// Isolated native regression probe; uses production descriptors, AppKit host and menu.
const { app, BaseWindow, WebContentsView, Menu } = require("electron");
const { mkdirSync, mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { dirname, join, resolve } = require("node:path");
const { Module } = require("node:module");
const { buildSync } = require("esbuild");
const { chromiumCdpKeyDescriptor } = require("./electronLoadChromiumInputOwner.cjs");
const menuModule = new Module(__filename);
menuModule.paths = module.paths;
menuModule._compile(buildSync({
  entryPoints: [join(__dirname, "../src/electron/main/macosApplicationMenu.ts")],
  bundle: true, platform: "node", format: "cjs", write: false, external: ["electron"]
}).outputFiles[0].text, __filename);
const reportPath = resolve(process.argv[2] ?? ".desktop-e2e-artifacts/input-confinement.json");
app.setPath("userData", mkdtempSync(join(tmpdir(), "rion-input-confinement-")));
app.on("window-all-closed", () => {});
if (process.platform !== "darwin") throw new Error("The retained AppKit confinement probe requires macOS.");
mkdirSync(dirname(reportPath), { recursive: true });
const samples = [];
const identity = { logicalWindowId: "confinement", launchGeneration: "probe", nativeGeneration: 1 };
let host, window, view;
const turns = () => new Promise(resolveTurn => setImmediate(resolveTurn));
const snapshot = () => ({
  bounds: window.getBounds(), zoomed: window.isMaximized(), fullscreen: window.isFullScreen(),
  destroyed: window.isDestroyed(), focused: window.isFocused(), pageFocused: view.webContents.isFocused()
});
async function runSample(code, legacy, handled) {
  await view.webContents.executeJavaScript(`window.events = []; window.handled = ${handled};`);
  const before = snapshot();
  let deadline;
  const legacyPlacement = legacy ? new Promise(resolvePlacement => {
    window.once("resize", resolvePlacement);
    deadline = setTimeout(resolvePlacement, 2000); // Diagnostic-only negative control deadline.
  }) : null;
  for (const phase of ["rawKeyDown", "keyUp"]) {
    const descriptor = { ...chromiumCdpKeyDescriptor({
      phase, code, activeCodesBefore: phase === "keyUp" ? [code] : [],
      activeCodes: phase === "rawKeyDown" ? [code] : [], autoRepeat: false, suppressShortcut: true
    }, process.platform) };
    if (legacy) descriptor.nativeVirtualKeyCode = 24; // The former alphabetical KeyY mapping.
    await view.webContents.debugger.sendCommand("Input.dispatchKeyEvent", descriptor);
  }
  // The dispatch acknowledgement and subsequent renderer roundtrip fence input handling.
  const events = await view.webContents.executeJavaScript("window.events");
  if (legacyPlacement) await legacyPlacement;
  clearTimeout(deadline);
  await turns();
  const after = snapshot();
  const sample = { code, legacy, handled, before, after, events };
  samples.push(sample);
  if (events.length !== 2 || events.some(event => !event.trusted || event.code !== code || event.location !== 0)) {
    throw new Error(`DOM input mismatch: ${JSON.stringify(sample)}`);
  }
  if (!legacy && JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error(`Page input changed native window state: ${JSON.stringify(sample)}`);
  }
}
void (async () => {
  try {
    await app.whenReady();
    const addon = require(join(__dirname, `../build/native/${process.platform}-${process.arch}/rion-core.node`));
    menuModule.exports.installMacosApplicationMenu(Menu, "Rion Input Probe", () => {
      throw new Error("Page input invoked an application shortcut");
    }, () => { throw new Error("Page input invoked Quick Open"); });
    window = new BaseWindow({ width: 800, height: 600, show: false, frame: true });
    host = addon.attachAppKitRuntimeHost(window.getNativeWindowHandle(), identity, () => {});
    const layout = host.snapshotContentLayout(identity);
    host.applyTabProjection(identity, "1", [{ tabId: "role", name: "Input Confinement", phase: "ready", tabType: "role" }], "role");
    view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const capture = host.beginInputSurfaceCapture(identity, "role", 1);
    window.contentView.addChildView(view);
    host.commitInputSurfaceCapture(identity, "role", 1, capture.captureSequence);
    view.setBounds({ x: 0, y: Math.ceil(layout.yOffset), width: 800, height: 500 });
    await view.webContents.loadURL("data:text/html," + encodeURIComponent(`<body tabindex=0>Native input confinement<script>
      window.events=[]; window.handled=false;
      for (const type of ['keydown','keyup']) document.addEventListener(type,event=>{
        window.events.push({type:event.type,code:event.code,key:event.key,location:event.location,trusted:event.isTrusted});
        if(window.handled) event.preventDefault();
      });</script></body>`));
    const focused = new Promise((resolveFocus, rejectFocus) => {
      // Probe-only external acknowledgement deadline; expiry is a failure.
      const deadline = setTimeout(() => rejectFocus(new Error("Native focus event absent")), 8000);
      window.once("focus", () => { clearTimeout(deadline); resolveFocus(); });
    });
    window.show(); window.focus();
    await focused;
    view.webContents.focus();
    await view.webContents.executeJavaScript("document.body.focus()");
    host.probeCdpInputSurface(identity, "role", 1);
    view.webContents.debugger.attach("1.3");
    for (const handled of [false, true]) {
      for (const code of ["KeyY", "KeyA", "ArrowLeft", "ArrowRight", "BracketLeft", "BracketRight", "F12"]) {
        await runSample(code, false, handled);
      }
    }
    await runSample("KeyY", true, false);
    const legacy = samples.at(-1);
    const legacyReproduced = JSON.stringify(legacy.before.bounds) !== JSON.stringify(legacy.after.bounds);
    writeFileSync(reportPath, JSON.stringify({ status: "fixed-path-passed", legacyControl: legacyReproduced ? "reproduced" : "not-reproduced", electron: process.versions.electron, chromium: process.versions.chrome, samples }, null, 2));
    console.log(`Native confinement passed; legacy control ${legacyReproduced ? "reproduced" : "not reproduced"}: ${reportPath}`);
    app.exit(0);
  } catch (error) {
    writeFileSync(reportPath, JSON.stringify({ status: "failed", error: String(error), samples }, null, 2));
    console.error(error); app.exit(1);
  }
})();
