// Native compatibility experiment only; never loaded by the product runtime.
const { app, BrowserWindow, WebContentsView } = require("electron");
const { writeFile } = require("node:fs/promises");
const { resolve } = require("node:path");

const [reportPath, userData] = process.argv.slice(2);
if (!reportPath || !userData || !["darwin", "win32"].includes(process.platform)) {
  throw new Error("Use bundled Electron: probeChromiumInput.cjs REPORT_PATH ISOLATED_USER_DATA");
}
app.setPath("userData", resolve(userData));
app.on("window-all-closed", () => {});
const fixture = "data:text/html," + encodeURIComponent(
  '<!doctype html><meta charset="utf-8"><title>Input compatibility probe</title>' +
  '<body style="margin:0;height:100vh" tabindex="0">Isolated input fixture</body>'
);
const keyboard = [
  { type: "keyDown", keyCode: "A" },
  { type: "keyUp", keyCode: "A" }
];
const middleButton = [
  { type: "mouseDown", x: 120, y: 90, button: "middle", clickCount: 1 },
  { type: "mouseUp", x: 120, y: 90, button: "middle", clickCount: 1 }
];
const state = contents => contents.executeJavaScript(`({
  focused: document.hasFocus(), visibility: document.visibilityState,
  width: innerWidth, height: innerHeight
})`);

async function sample(view, host, name, inputs, expectedTypes) {
  const contents = view.webContents;
  const before = { hostFocused: host.isFocused(), hostVisible: host.isVisible(),
    contentsFocused: contents.isFocused(), document: await state(contents) };
  // Test-only observation deadline. Expiry is indeterminate, never successful delivery.
  await contents.executeJavaScript(`(() => {
    const expected = ${JSON.stringify(expectedTypes)};
    const events = [];
    window.inputProbe = new Promise(resolve => {
      let deadline;
      const finish = status => {
        clearTimeout(deadline);
        for (const type of new Set(expected)) document.removeEventListener(type, receive, true);
        resolve({ status, events });
      };
      const receive = event => {
        events.push({ type: event.type, trusted: event.isTrusted, key: event.key ?? null,
          code: event.code ?? null, button: event.button ?? null, buttons: event.buttons ?? null,
          shift: event.shiftKey, control: event.ctrlKey, alt: event.altKey, meta: event.metaKey,
          repeat: event.repeat ?? false, x: event.clientX ?? null, y: event.clientY ?? null });
        if (events.length === expected.length) finish(
          events.every((event, index) => event.type === expected[index]) ? "received" : "mismatch"
        );
      };
      for (const type of new Set(expected)) document.addEventListener(type, receive, true);
      deadline = setTimeout(() => finish("indeterminate"), 1500);
    });
  })()`);
  for (const input of inputs) contents.sendInputEvent(input);
  const receipt = await contents.executeJavaScript("window.inputProbe");
  return { name, inputs, expectedTypes, before, receipt,
    after: { hostFocused: host.isFocused(), hostVisible: host.isVisible(),
      contentsFocused: contents.isFocused(), document: await state(contents) } };
}

async function focus(host, view) {
  if (!host.isFocused()) {
    await new Promise(resolveFocus => {
      host.once("focus", resolveFocus);
      host.show();
      host.focus();
    });
  }
  view.webContents.focus();
}

async function probe() {
  const options = { show: false, width: 640, height: 480,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } };
  const host = new BrowserWindow(options);
  const other = new BrowserWindow(options);
  const view = new WebContentsView({ webPreferences: options.webPreferences });
  host.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 600, height: 400 });
  const outcomes = [];
  try {
    await view.webContents.loadURL(fixture);
    await other.loadURL(fixture);
    await focus(host, view);
    outcomes.push(await sample(view, host, "foreground", keyboard, ["keydown", "keyup"]));
    outcomes.push(await sample(view, host, "modifiers-and-repeat", [
      { type: "keyDown", keyCode: "Shift", modifiers: ["shift"] },
      { type: "keyDown", keyCode: "A", modifiers: ["shift"] },
      { type: "keyDown", keyCode: "A", modifiers: ["shift", "isAutoRepeat"] },
      { type: "keyUp", keyCode: "A", modifiers: ["shift"] },
      { type: "keyUp", keyCode: "Shift" }
    ], ["keydown", "keydown", "keydown", "keyup", "keyup"]));
    for (const [keyCode, modifier] of [["Control", "control"], ["Alt", "alt"], ["Meta", "meta"]]) {
      outcomes.push(await sample(view, host, `modifier-${modifier}`, [
        { type: "keyDown", keyCode, modifiers: [modifier] },
        { type: "keyDown", keyCode: "A", modifiers: [modifier] },
        { type: "keyUp", keyCode: "A", modifiers: [modifier] },
        { type: "keyUp", keyCode }
      ], ["keydown", "keydown", "keyup", "keyup"]));
    }
    for (const zoom of [1, 1.5]) {
      view.webContents.setZoomFactor(zoom);
      outcomes.push(await sample(view, host, `middle-button-zoom-${zoom}`,
        middleButton, ["mousedown", "mouseup"]));
    }
    view.webContents.setZoomFactor(1);
    outcomes.push(await sample(view, host, "held-before-reload", [keyboard[0]], ["keydown"]));
    await view.webContents.loadURL(fixture);
    await focus(host, view);
    outcomes.push(await sample(view, host, "held-release-after-reload", [keyboard[1]], ["keyup"]));
    outcomes.push(await sample(view, host, "reloaded", keyboard, ["keydown", "keyup"]));
    // Do not focus either target after hiding/backgrounding it to repair delivery.
    view.setVisible(false);
    outcomes.push(await sample(view, host, "hidden-view", keyboard, ["keydown", "keyup"]));
    outcomes.push(await sample(view, host, "hidden-view-middle", middleButton, ["mousedown", "mouseup"]));
    view.setVisible(true);
    await focus(other, { webContents: other.webContents });
    outcomes.push(await sample(view, host, "background-host", keyboard, ["keydown", "keyup"]));
    outcomes.push(await sample(view, host, "background-host-middle", middleButton, ["mousedown", "mouseup"]));
    host.hide();
    outcomes.push(await sample(view, host, "hidden-host", keyboard, ["keydown", "keyup"]));
    outcomes.push(await sample(view, host, "hidden-host-middle", middleButton, ["mousedown", "mouseup"]));
    await writeFile(reportPath, JSON.stringify({ platform: process.platform,
      electron: process.versions.electron, chromium: process.versions.chrome,
      scope: "isolated WebContentsView API probe; not a Role/native-adapter receipt", outcomes
    }, null, 2) + "\n");
  } finally {
    view.webContents.close();
    host.destroy();
    other.destroy();
  }
}

app.whenReady().then(probe).then(() => app.quit()).catch(error => {
  console.error(error);
  app.exit(1);
});
