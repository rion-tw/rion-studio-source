// Real Chromium world-boundary regression; no external debugger or user profile.
const { app, BrowserWindow } = require("electron");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { resolve, dirname } = require("node:path");
const [reportPath, userData] = process.argv.slice(2);
if (!reportPath || !userData || !["darwin", "win32"].includes(process.platform)) {
  throw new Error("Use bundled Electron: probeChromiumCompatibleInput.cjs REPORT ISOLATED_USER_DATA");
}
app.setPath("userData", resolve(userData));
app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  window.webContents.on("console-message", event => console.error(event.message));
  try {
    mkdirSync(userData, { recursive: true });
    const fixturePath = resolve(userData, "fixture.html");
    writeFileSync(fixturePath, "<canvas id='game' width='640' height='480' tabindex='0'></canvas>");
    await window.loadFile(fixturePath);
    await window.webContents.executeJavaScript(`globalThis.received = []; const pressed = new Set();
      for (const type of ['keydown','keyup']) document.querySelector('canvas').addEventListener(type, event => {
        if (type === 'keydown') pressed.add(event.keyCode); else pressed.delete(event.keyCode);
        received.push({ type, code: event.code, keyCode: event.keyCode, which: event.which,
          charCode: event.charCode, altKey: event.altKey, ctrlKey: event.ctrlKey,
          metaKey: event.metaKey, shiftKey: event.shiftKey, altState: event.getModifierState('Alt'),
          pressed: [...pressed], isTrusted: event.isTrusted });
      }); document.querySelector('canvas').focus();`);
    const manifest = resolve("src/shared/browser-overlay/macroOverlayRuntime.js");
    const source = [...readFileSync(manifest, "utf8").matchAll(/@source\s+"([^"]+)"/gu)]
      .map(match => readFileSync(resolve(dirname(manifest), match[1]), "utf8")).join("\n");
    const replace = (text, name, value) => text.replace(JSON.stringify(name), value);
    let overlay = source;
    for (const [name, value] of Object.entries({
      "__RION_STUDIO_MACRO_OVERLAY_SHORTCUT_GUARD__": readFileSync("src/shared/browser-overlay/macroOverlayShortcutGuard.js", "utf8").trim(),
      // Deterministic physical precondition only; the production endpoint is unchanged.
      "__RION_STUDIO_MACRO_OVERLAY_TRUSTED_EVENT_GUARD__": "() => true",
      "__RION_STUDIO_MACRO_OVERLAY_BINDING__": "async () => ({ macros: [], statuses: [] })",
      "__RION_STUDIO_MACRO_OVERLAY_CSS__": '""',
      "__RION_STUDIO_MACRO_COORDINATE_MEASUREMENT_MODULE_SOURCE__": '""',
      "__RION_STUDIO_MACRO_COORDINATE_MEASUREMENT_MODULE_IMPORTER__": "() => Promise.reject(new Error('unused'))"
    })) overlay = replace(overlay, name, value);
    await window.webContents.executeJavaScriptInIsolatedWorld(999, [{ code:
      `globalThis.__rionStudioDocumentInstanceId = 'document'; ${overlay}` }]);
    const send = async (code, phase, coreBefore, coreAfter) => {
      const command = { requestId: `request-${++sequence}`, ownerId: "macro", roleId: "role", generation: 1,
        inputEpoch: 1, frameToken: "document", documentInstanceId: "document", sequence,
        deadlineMs: Date.now() + 30000, intent: phase === "keyUp" ? "cleanup" : "normal", action: "key",
        modifierState: { coreCodesBefore: coreBefore, coreCodesAfter: coreAfter, nativePhysicalCodes: physical ? ["AltLeft"] : [] },
        key: { type: phase, code, key: code === "AltLeft" ? "Alt" : "3", location: code === "AltLeft" ? 1 : 0,
          windowsVirtualKeyCode: code === "AltLeft" ? 18 : 51, modifiers: physical || coreAfter.length ? 1 : 0, autoRepeat: false } };
      commands.push(command);
      return window.webContents.executeJavaScriptInIsolatedWorld(999, [{ code:
        `globalThis.__rionStudioMacroOverlay.dispatchCompatibleInput(${JSON.stringify(command)})` }]);
    };
    let sequence = 0, physical = false;
    const receipts = [], commands = [];
    const cycle = async () => {
      receipts.push(await send("AltLeft", "rawKeyDown", [], ["AltLeft"]));
      receipts.push(await send("Digit3", "rawKeyDown", ["AltLeft"], ["AltLeft"]));
      receipts.push(await send("Digit3", "keyUp", ["AltLeft"], ["AltLeft"]));
      receipts.push(await send("AltLeft", "keyUp", ["AltLeft"], []));
    };
    await cycle();
    physical = true;
    await window.webContents.executeJavaScript(`document.querySelector('canvas').dispatchEvent(new KeyboardEvent('keydown', {
      code: 'AltLeft', key: 'Alt', keyCode: 18, which: 18, altKey: true, bubbles: true }));`);
    for (let index = 0; index < 100; index++) await cycle();
    await window.webContents.executeJavaScript(`document.querySelector('canvas').dispatchEvent(new KeyboardEvent('keyup', {
      code: 'AltLeft', key: 'Alt', keyCode: 18, which: 18, bubbles: true }));`);
    await window.webContents.executeJavaScript(`document.querySelector('canvas').dispatchEvent(new KeyboardEvent('keydown', {
      code: 'AltLeft', key: 'Alt', keyCode: 18, which: 18, altKey: true, bubbles: true }));`);
    await window.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: "window.dispatchEvent(new Event('blur'))" }]);
    const events = await window.webContents.executeJavaScript("received");
    const reconciliation = await require("./probeChromiumModifierReconciliation.cjs")(window.webContents);
    writeFileSync(reportPath, JSON.stringify({ platform: process.platform, chromium: process.versions.chrome, receipts, commands, events, reconciliation }));
  } finally { window.destroy(); app.quit(); }
}).catch(error => { console.error(error); app.exit(1); });
