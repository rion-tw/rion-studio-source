// Native A/B validation for the production in-process CDP Input transport.
const { app, BrowserWindow } = require("electron");
const { writeFile } = require("node:fs/promises");
const { resolve } = require("node:path");
const {
  chromiumCdpKeyDescriptor,
  chromiumCdpMouseDescriptors,
  sendChromiumClick,
  sendChromiumKey
} = require("./electronLoadChromiumInputOwner.cjs");

const [reportPath, userData] = process.argv.slice(2);
if (!reportPath || !userData || !["darwin", "win32"].includes(process.platform)) {
  throw new Error("Use bundled Electron: probeChromiumCdpInput.cjs REPORT_PATH ISOLATED_USER_DATA");
}
app.setPath("userData", resolve(userData));
app.on("window-all-closed", () => {});
const fixture = "data:text/html," + encodeURIComponent(
  '<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh" tabindex="0">CDP input probe</body>'
);

const effect = (phase, code, activeCodes, autoRepeat = false) => ({
  phase, code, activeCodesBefore: activeCodes, activeCodes,
  autoRepeat, suppressShortcut: true
});

async function arm(contents, expectedTypes) {
  await contents.executeJavaScript(`(() => {
    const expectedTypes = ${JSON.stringify(expectedTypes)};
    const events = [];
    window.cdpInputReceipt = new Promise(resolveReceipt => {
      let deadline;
      const finish = status => {
        clearTimeout(deadline);
        for (const type of new Set(expectedTypes)) {
          document.removeEventListener(type, receive, true);
        }
        resolveReceipt({ status, events });
      };
      const receive = event => {
        events.push({
          type: event.type, trusted: event.isTrusted,
          code: event.code ?? null, key: event.key ?? null,
          location: event.location ?? 0, repeat: event.repeat ?? false,
          control: event.ctrlKey, alt: event.altKey,
          shift: event.shiftKey, meta: event.metaKey,
          button: event.button ?? null, buttons: event.buttons ?? null,
          x: event.clientX ?? null, y: event.clientY ?? null
        });
        if (events.length === expectedTypes.length) {
          finish(events.every((event, index) => event.type === expectedTypes[index])
            ? "received" : "mismatch");
        }
      };
      for (const type of new Set(expectedTypes)) {
        document.addEventListener(type, receive, true);
      }
      deadline = setTimeout(() => finish("indeterminate"), 2000);
    });
  })()`);
}

async function sample(contents, host, name, expectedTypes, submit) {
  await arm(contents, expectedTypes);
  const before = {
    hostFocused: host.isFocused(),
    contentsFocused: contents.isFocused(),
    visible: host.isVisible()
  };
  let accepted = 0;
  try {
    accepted = await submit();
  } catch (error) {
    return { name, before, after: before, accepted, commandError: String(error),
      receipt: { status: "indeterminate", events: [] } };
  }
  const receipt = await contents.executeJavaScript("window.cdpInputReceipt");
  return {
    name,
    before,
    after: {
      hostFocused: host.isFocused(),
      contentsFocused: contents.isFocused(),
      visible: host.isVisible()
    },
    accepted,
    receipt
  };
}

async function sendBaselineKeys(contents, effects) {
  for (const input of effects) {
    const has = prefix => input.activeCodes.some(code => code.startsWith(prefix));
    sendChromiumKey(contents, {
      eventType: input.phase,
      code: input.code,
      ctrl: has("Control"),
      alt: has("Alt"),
      shift: has("Shift"),
      meta: has("Meta"),
      repeat: input.autoRepeat
    });
  }
  return effects.length;
}

async function sendBaselineMouse(contents, button) {
  sendChromiumClick(contents, {
    clientX: 80,
    clientY: 96,
    zoomFactor: 1,
    button: button === "left" ? 0 : button === "middle" ? 1 : 2,
    ctrl: true,
    alt: false,
    shift: false,
    meta: false
  }, { width: 480, height: 360 });
  return 2;
}

async function sendBaselineRightControlCode(contents) {
  contents.sendInputEvent({
    type: "rawKeyDown",
    keyCode: "ControlRight",
    modifiers: ["control", "right"]
  });
  contents.sendInputEvent({
    type: "keyUp",
    keyCode: "ControlRight",
    modifiers: ["right"]
  });
  return 2;
}

async function sendCdpKeys(contents, effects) {
  for (const input of effects) {
    await contents.debugger.sendCommand(
      "Input.dispatchKeyEvent",
      chromiumCdpKeyDescriptor(input, process.platform)
    );
  }
  return effects.length;
}

async function sendCdpMouse(contents, button) {
  const descriptors = chromiumCdpMouseDescriptors({
    x: 80, y: 96, button, modifierCodes: ["ControlRight"]
  });
  for (const descriptor of descriptors) {
    await contents.debugger.sendCommand("Input.dispatchMouseEvent", descriptor);
  }
  return descriptors.length;
}

async function probe() {
  const target = new BrowserWindow({ show: true, width: 480, height: 360,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const sibling = new BrowserWindow({ show: true, width: 420, height: 320,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const outcomes = [];
  let detachReason = null;
  try {
    await Promise.all([target.loadURL(fixture), sibling.loadURL(fixture)]);
    sibling.focus();
    const chord = [
      effect("rawKeyDown", "ControlRight", ["ControlRight"]),
      effect("rawKeyDown", "ShiftLeft", ["ControlRight", "ShiftLeft"]),
      effect("rawKeyDown", "KeyA", ["ControlRight", "ShiftLeft", "KeyA"]),
      effect("rawKeyDown", "KeyA", ["ControlRight", "ShiftLeft", "KeyA"], true),
      effect("keyUp", "KeyA", ["ControlRight", "ShiftLeft"]),
      effect("keyUp", "ShiftLeft", ["ControlRight"]),
      effect("keyUp", "ControlRight", [])
    ];
    const chordEvents = [
      "keydown", "keydown", "keydown", "keydown", "keyup", "keyup", "keyup"
    ];
    outcomes.push(await sample(target.webContents, target, "baseline-background-chord",
      chordEvents, () => sendBaselineKeys(target.webContents, chord)));
    outcomes.push(await sample(target.webContents, target, "baseline-middle",
      ["mousedown", "mouseup", "auxclick"],
      () => sendBaselineMouse(target.webContents, "middle")));
    outcomes.push(await sample(target.webContents, target, "baseline-right",
      ["mousedown", "contextmenu", "mouseup", "auxclick"],
      () => sendBaselineMouse(target.webContents, "right")));
    outcomes.push(await sample(
      target.webContents,
      target,
      "baseline-control-right-dom-code",
      ["keydown", "keyup"],
      () => sendBaselineRightControlCode(target.webContents)
    ));
    target.webContents.debugger.on("detach", (_event, reason) => { detachReason = reason; });
    target.webContents.debugger.attach("1.3");
    outcomes.push(await sample(target.webContents, target, "cdp-background-chord",
      chordEvents,
      () => sendCdpKeys(target.webContents, chord)));
    outcomes.push(await sample(target.webContents, target, "cdp-middle",
      ["mousedown", "mouseup", "auxclick"],
      () => sendCdpMouse(target.webContents, "middle")));
    outcomes.push(await sample(target.webContents, target, "cdp-right",
      ["mousedown", "contextmenu", "mouseup", "auxclick"],
      () => sendCdpMouse(target.webContents, "right")));
    for (const code of ["F21", "F22", "F23", "F24"]) {
      outcomes.push(await sample(target.webContents, target, `cdp-${code.toLowerCase()}`,
        ["keydown", "keyup"], () => sendCdpKeys(target.webContents, [
          effect("rawKeyDown", code, [code]), effect("keyUp", code, [])
        ])));
    }
    target.hide();
    outcomes.push(await sample(target.webContents, target, "cdp-hidden-key",
      ["keydown", "keyup"], () => sendCdpKeys(target.webContents, [
        effect("rawKeyDown", "KeyB", ["KeyB"]), effect("keyUp", "KeyB", [])
      ])));
    target.webContents.debugger.detach();
    const findEvents = name => outcomes.find(outcome => outcome.name === name)?.receipt.events;
    const normalizeLegacyRightControl = events => events?.map(event =>
      event.code === "ControlLeft" && event.location === 2
        ? { ...event, code: "ControlRight" }
        : event);
    const baselineChord = findEvents("baseline-background-chord");
    const cdpChord = findEvents("cdp-background-chord");
    return {
      platform: process.platform,
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      transport: "in-process-webContents-debugger-input-only",
      productionPromoted: true,
      externalDebugTransport: false,
      detachReason,
      comparisons: {
        chordExceptLegacyRightControl: JSON.stringify(
          normalizeLegacyRightControl(baselineChord)
        ) === JSON.stringify(cdpChord),
        rightControlIdentityCorrected:
          baselineChord?.[0]?.code === "ControlLeft" &&
          baselineChord?.at(-1)?.code === "ControlLeft" &&
          cdpChord?.[0]?.code === "ControlRight" &&
          cdpChord?.at(-1)?.code === "ControlRight",
        middle: JSON.stringify(findEvents("baseline-middle")) ===
          JSON.stringify(findEvents("cdp-middle")),
        right: JSON.stringify(findEvents("baseline-right")) ===
          JSON.stringify(findEvents("cdp-right"))
      },
      outcomes
    };
  } finally {
    if (target.webContents.debugger.isAttached()) target.webContents.debugger.detach();
    target.destroy();
    sibling.destroy();
  }
}

app.whenReady().then(async () => {
  try {
    await writeFile(resolve(reportPath), JSON.stringify(await probe(), null, 2));
    app.quit();
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
