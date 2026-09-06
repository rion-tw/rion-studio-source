const { randomUUID } = require("node:crypto");
const { mkdtempSync, writeSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const { app, BaseWindow, ipcMain, screen, WebContentsView } = require("electron");

const PROBE_PREFIX = "RION_ELECTRON_WINDOWS_CHROMIUM_INPUT_PROBE=";

function withDiagnosticDeadline(promise, milliseconds) {
  let deadline;
  return Promise.race([
    promise.then((value) => ({ received: true, value })),
    new Promise((resolve) => {
      // Diagnostic-only external liveness boundary. Missing native/renderer
      // evidence is a failed probe and never becomes capability success.
      deadline = setTimeout(() => resolve({ received: false }), milliseconds);
    })
  ]).finally(() => clearTimeout(deadline));
}

function exactProbe(receipt, surfaceHandle, parentHandle) {
  if (
    !receipt ||
    receipt.abiVersion !== 6 ||
    !receipt.currentProcessOwned ||
    !receipt.exactParent ||
    !receipt.childWindowStyle ||
    !receipt.popupWindowStyleAbsent ||
    !receipt.noActivateStyle ||
    !receipt.foregroundWindowPreserved ||
    !receipt.activeWindowPreserved ||
    !receipt.focusWindowPreserved ||
    !/^[0-9a-f]{64}$/u.test(receipt.focusIdentity) ||
    typeof receipt.parentWasForeground !== "boolean" ||
    typeof receipt.parentVisible !== "boolean" ||
    typeof receipt.surfaceVisible !== "boolean" ||
    !Number.isSafeInteger(receipt.clientWidth) ||
    receipt.clientWidth < 1 ||
    !Number.isSafeInteger(receipt.clientHeight) ||
    receipt.clientHeight < 1 ||
    !Number.isSafeInteger(receipt.dpi) ||
    receipt.dpi < 48 ||
    receipt.dpi > 768 ||
    typeof receipt.surfaceHandleToken !== "string" ||
    !/^[0-9a-f]{64}$/u.test(receipt.surfaceHandleToken) ||
    typeof receipt.parentHandleToken !== "string" ||
    !/^[0-9a-f]{64}$/u.test(receipt.parentHandleToken) ||
    receipt.surfaceHandleToken === receipt.parentHandleToken ||
    surfaceHandle.equals(parentHandle)
  ) {
    throw new Error(
      `Electron did not produce an exact no-activate WS_CHILD: ${JSON.stringify(receipt)}`
    );
  }
  return receipt;
}

function exactNativeBase(receipt, expected, probe) {
  if (
    receipt.status !== "submitted" ||
    receipt.submissionApi !== "webContents.sendInputEvent" ||
    receipt.roleId !== expected.roleId ||
    receipt.surfaceGeneration !== expected.surfaceGeneration ||
    receipt.nativeGeneration !== expected.nativeGeneration ||
    receipt.bindingRevision !== expected.bindingRevision ||
    receipt.surfaceHandleToken !== expected.surfaceHandleToken ||
    receipt.parentHandleToken !== expected.parentHandleToken ||
    receipt.probeRevision !== expected.probeRevision ||
    receipt.inputEpoch !== expected.inputEpoch ||
    receipt.deliveryMode !== expected.deliveryMode ||
    receipt.withinDeadline !== true ||
    receipt.currentProcessOwned !== true ||
    receipt.exactParent !== true ||
    receipt.childWindowStyle !== true ||
    receipt.popupWindowStyleAbsent !== true ||
    receipt.noActivateStyle !== true ||
    receipt.targetAttached !== true ||
    receipt.noActivationApiCalled !== true ||
    receipt.foregroundWindowPreserved !== true ||
    receipt.activeWindowPreserved !== true ||
    receipt.focusWindowPreserved !== true ||
    receipt.parentWasForeground !== true ||
    receipt.parentVisible !== true ||
    receipt.surfaceVisible !== (expected.deliveryMode === "foreground") ||
    receipt.targetWasForeground !== false ||
    receipt.targetHadThreadFocus !== false ||
    receipt.clientWidth !== probe.clientWidth ||
    receipt.clientHeight !== probe.clientHeight ||
    receipt.dpi !== probe.dpi ||
    !/^[1-9][0-9]*$/u.test(receipt.dispatchSequence) ||
    !/^[1-9][0-9]*$/u.test(receipt.submittedAtMs)
  ) {
    throw new Error(`The ${receipt.requestId} native receipt is not exact.`);
  }
}

function closeWindow(window) {
  if (window && !window.isDestroyed()) window.destroy();
}

void (async () => {
  let child;
  let control;
  let controlView;
  let onPrivateReceipt;
  let parent;
  let view;
  const armWaiters = new Map();
  const inputWaiters = new Map();
  const cancelWaiters = new Map();
  const privateReceipts = [];
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const channel = `rion-windows-input-probe:${randomUUID()}`;
  const frameToken = randomUUID();
  try {
    if (process.platform !== "win32") {
      throw new Error("The physical Chromium trusted-input probe requires Windows.");
    }
    const addonPath = process.env.RION_ELECTRON_ADDON_PATH ?? join(
      __dirname,
      "..",
      "build",
      "native",
      `${process.platform}-${process.arch}`,
      "rion-core.node"
    );
    app.setPath(
      "userData",
      mkdtempSync(join(tmpdir(), "rion-windows-input-probe-"))
    );
    await app.whenReady();
    const addon = require(addonPath);
    if (addon.windowsChromiumInputProbeAbiVersion() !== 6) {
      throw new Error("The Win32 trusted-input probe ABI does not match Electron.");
    }

    const display = screen.getPrimaryDisplay();
    parent = new BaseWindow({
      x: display.workArea.x + 80,
      y: display.workArea.y + 80,
      width: 760,
      height: 560,
      useContentSize: true,
      frame: true,
      show: false
    });
    child = new BaseWindow({
      parent,
      show: false,
      focusable: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      movable: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      backgroundColor: "#00000000"
    });
    const parentBounds = parent.getContentBounds();
    child.setBounds(parentBounds);
    child.hide();
    const surfaceHandle = Buffer.from(child.getNativeWindowHandle());
    const parentHandle = Buffer.from(parent.getNativeWindowHandle());
    const beforeAttachProbe = exactProbe(
      addon.attachWindowsChromiumInputHwnd(surfaceHandle, parentHandle),
      surfaceHandle,
      parentHandle
    );
    const childBounds = child.getContentBounds();
    const expectedPhysicalWidth = Math.round(
      childBounds.width * beforeAttachProbe.dpi / 96
    );
    const expectedPhysicalHeight = Math.round(
      childBounds.height * beforeAttachProbe.dpi / 96
    );
    if (
      beforeAttachProbe.clientWidth !== expectedPhysicalWidth ||
      beforeAttachProbe.clientHeight !== expectedPhysicalHeight ||
      beforeAttachProbe.dpi !== Math.round(display.scaleFactor * 96)
    ) {
      throw new Error(
        "The Win32 client receipt does not match Electron DIP/DPI projection."
      );
    }

    onPrivateReceipt = (event, receipt) => {
      if (
        event.sender !== view?.webContents ||
        event.senderFrame.routingId !== event.sender.mainFrame.routingId ||
        !receipt ||
        receipt.roleId !== "probe-role" ||
        receipt.surfaceGeneration !== 1 ||
        receipt.frameToken !== frameToken
      ) {
        return;
      }
      privateReceipts.push(receipt);
      if (receipt.kind === "ready" && receipt.documentUrl.startsWith("data:")) {
        resolveReady(receipt);
        return;
      }
      if (receipt.kind === "cancelled" || receipt.kind === "cancel-rejected") {
        cancelWaiters.get(receipt.inputSequence)?.(receipt);
        cancelWaiters.delete(receipt.inputSequence);
        return;
      }
      if (receipt.kind === "armed" || receipt.kind === "arm-rejected") {
        armWaiters.get(receipt.inputSequence)?.(receipt);
        armWaiters.delete(receipt.inputSequence);
        return;
      }
      if (receipt.kind !== "input") return;
      const waiter = inputWaiters.get(receipt.inputSequence);
      if (!waiter) return;
      waiter.receipts.push(receipt);
      if (!receipt.matches || !receipt.isTrusted ||
          waiter.receipts.length === waiter.expectedCount) {
        inputWaiters.delete(receipt.inputSequence);
        waiter.resolve([...waiter.receipts]);
      }
    };
    ipcMain.on(channel, onPrivateReceipt);

    view = new WebContentsView({
      webPreferences: {
        additionalArguments: [
          `--rion-windows-input-probe-channel=${channel}`,
          "--rion-windows-input-probe-role=probe-role",
          "--rion-windows-input-probe-generation=1",
          `--rion-windows-input-probe-frame-token=${frameToken}`
        ],
        contextIsolation: true,
        devTools: false,
        nodeIntegration: false,
        preload: join(
          __dirname,
          "electronWindowsChromiumTrustedInputProbePreload.cjs"
        ),
        sandbox: true,
        webviewTag: false
      }
    });
    const viewBounds = {
      x: 40,
      y: 36,
      width: Math.max(320, childBounds.width - 80),
      height: Math.max(240, childBounds.height - 72)
    };
    view.setBounds(viewBounds);
    view.setVisible(true);
    child.contentView.addChildView(view);
    if (child.contentView.children.length !== 1 ||
        child.contentView.children[0] !== view) {
      throw new Error("The child HWND does not own exactly one WebContentsView.");
    }
    const afterAttachProbe = exactProbe(
      addon.probeWindowsChromiumInputHwnd(surfaceHandle, parentHandle),
      surfaceHandle,
      parentHandle
    );
    if (
      afterAttachProbe.surfaceHandleToken !== beforeAttachProbe.surfaceHandleToken ||
      afterAttachProbe.parentHandleToken !== beforeAttachProbe.parentHandleToken ||
      afterAttachProbe.clientWidth !== beforeAttachProbe.clientWidth ||
      afterAttachProbe.clientHeight !== beforeAttachProbe.clientHeight ||
      afterAttachProbe.dpi !== beforeAttachProbe.dpi
    ) {
      throw new Error("The exact child HWND changed during WebContents attachment.");
    }

    const loaded = new Promise((resolve, reject) => {
      view.webContents.once("did-finish-load", resolve);
      view.webContents.once(
        "did-fail-load",
        (_event, code, _description, _url, isMainFrame) => {
          if (isMainFrame) reject(new Error(`Probe page failed with ${code}.`));
        }
      );
    });
    await view.webContents.loadURL(
      `data:text/html,${encodeURIComponent(
        "<meta charset=utf-8><input id=probe autofocus>"
      )}`
    );
    await loaded;
    const readyReceipt = await withDiagnosticDeadline(ready, 3_000);
    if (!readyReceipt.received) {
      throw new Error("The isolated Windows probe preload did not become ready.");
    }

    const armInput = async (inputSequence, expectedEvents) => {
      let resolveArm;
      const arm = new Promise((resolve) => { resolveArm = resolve; });
      let resolveInput;
      const input = new Promise((resolve) => { resolveInput = resolve; });
      armWaiters.set(inputSequence, resolveArm);
      inputWaiters.set(inputSequence, {
        expectedCount: expectedEvents.length,
        receipts: [],
        resolve: resolveInput
      });
      view.webContents.send(`${channel}:arm`, { inputSequence, expectedEvents });
      const armReceipt = await withDiagnosticDeadline(arm, 3_000);
      if (!armReceipt.received || armReceipt.value.kind !== "armed") {
        armWaiters.delete(inputSequence);
        inputWaiters.delete(inputSequence);
        throw new Error(`The preload rejected input sequence ${inputSequence}.`);
      }
      return { armReceipt: armReceipt.value, input };
    };

    const cancelInput = async (inputSequence) => {
      const cancelled = new Promise(resolve => cancelWaiters.set(inputSequence, resolve));
      view.webContents.send(`${channel}:cancel`, { inputSequence });
      const receipt = await withDiagnosticDeadline(cancelled, 3_000);
      cancelWaiters.delete(inputSequence);
      if (!receipt.received || receipt.value.kind !== "cancelled") {
        throw new Error(`The preload did not acknowledge cancellation of ${inputSequence}.`);
      }
      inputWaiters.delete(inputSequence);
    };

    const parentFocused = new Promise((resolve) => parent.once("focus", resolve));
    parent.show();
    child.showInactive();
    exactProbe(
      addon.projectWindowsChromiumInputHwnd(surfaceHandle, parentHandle, true),
      surfaceHandle,
      parentHandle
    );
    parent.focus();
    await parentFocused;
    view.webContents.focus();
    const activeElement = await view.webContents.executeJavaScript(
      "document.querySelector('#probe').focus(); document.activeElement?.id",
      true
    );
    if (activeElement !== "probe") {
      throw new Error("The target Chromium input could not establish initial focus.");
    }

    const foregroundProbe = exactProbe(
      addon.probeWindowsChromiumInputHwnd(surfaceHandle, parentHandle),
      surfaceHandle,
      parentHandle
    );
    if (!foregroundProbe.parentWasForeground || foregroundProbe.targetWasForeground ||
        foregroundProbe.targetHadThreadFocus || !parent.isFocused()) {
      throw new Error("The exact runtime parent did not own foreground focus.");
    }
    const preDispatchDomState = await view.webContents.executeJavaScript(
      `({
        activeElementId: document.activeElement?.id ?? null,
        documentHasFocus: document.hasFocus(),
        visibilityState: document.visibilityState
      })`,
      true
    );

    const identity = {
      roleId: "probe-role",
      surfaceGeneration: 1,
      nativeGeneration: 1,
      bindingRevision: "1",
      surfaceHandleToken: foregroundProbe.surfaceHandleToken,
      parentHandleToken: foregroundProbe.parentHandleToken,
      probeRevision: "1",
      inputEpoch: "1",
      deliveryMode: "foreground"
    };
    const { submitOwnedChromiumKey, submitOwnedChromiumClick } =
      require("./electronLoadChromiumInputOwner.cjs");
    const submissionOwner = (request) => ({
      identity: {
        roleId: identity.roleId, surfaceGeneration: identity.surfaceGeneration,
        nativeGeneration: identity.nativeGeneration, bindingRevision: identity.bindingRevision,
        surfaceHandleToken: identity.surfaceHandleToken, parentHandleToken: identity.parentHandleToken
      },
      probeRevision: request.probeRevision,
      contents: view.webContents,
      viewport: () => view.getBounds(),
      nowMs: Date.now,
      probe: () => exactProbe(addon.probeWindowsChromiumInputHwnd(
        surfaceHandle, parentHandle
      ), surfaceHandle, parentHandle)
    });
    const submitKey = request => submitOwnedChromiumKey(submissionOwner(request), request);
    const submitClick = request => submitOwnedChromiumClick(submissionOwner(request), request);
    const keyPending = await armInput("windows-probe-key", [
      { type: "keydown", code: "KeyA" },
      { type: "keyup", code: "KeyA" }
    ]);
    const keyDown = submitKey({
        ...identity,
        requestId: "windows-probe-key-down",
        deadlineMs: String(Date.now() + 5_000),
        deliveryMode: "foreground",
        eventType: "keyDown",
        code: "KeyA",
        ctrl: false,
        alt: false,
        shift: false,
        meta: false,
        repeat: false
      });
    const keyUp = submitKey({
        ...identity,
        requestId: "windows-probe-key-up",
        deadlineMs: String(Date.now() + 5_000),
        deliveryMode: "foreground",
        eventType: "keyUp",
        code: "KeyA",
        ctrl: false,
        alt: false,
        shift: false,
        meta: false,
        repeat: false
      });
    exactNativeBase(keyDown, identity, foregroundProbe);
    exactNativeBase(keyUp, identity, foregroundProbe);
    if (
      keyDown.requestId !== "windows-probe-key-down" ||
      keyUp.requestId !== "windows-probe-key-up" ||
      keyDown.eventType !== "keyDown" ||
      keyUp.eventType !== "keyUp" ||
      keyDown.code !== "KeyA" ||
      keyUp.code !== "KeyA" ||
      BigInt(keyUp.dispatchSequence) <= BigInt(keyDown.dispatchSequence)
    ) {
      throw new Error("The exact native key receipt sequence is invalid.");
    }
    const keyDom = await withDiagnosticDeadline(keyPending.input, 3_000);
    if (!keyDom.received || keyDom.value.length !== 2 ||
        keyDom.value.some((receipt) => !receipt.matches || !receipt.isTrusted)) {
      throw new Error(`Chromium did not emit the exact trusted DOM key sequence: ${JSON.stringify({
        preDispatchDomState,
        foregroundProbe,
        keyDown,
        keyUp,
        received: keyDom.received,
        receipts: privateReceipts.filter(receipt =>
          receipt.inputSequence === "windows-probe-key").slice(-8)
      })}`);
    }

    await cancelInput("windows-probe-key");
    const zoomFactor = 1.25;
    const clientX = 80;
    const clientY = 96;
    view.webContents.setZoomFactor(zoomFactor);
    const mousePending = await armInput("windows-probe-mouse", [
      { type: "mousedown", button: 0, clientX: null, clientY: null },
      { type: "mouseup", button: 0, clientX: null, clientY: null },
      { type: "click", button: 0, clientX: null, clientY: null }
    ]);
    const mouse = submitClick({
        ...identity,
        requestId: "windows-probe-mouse",
        inputEpoch: "2",
        deadlineMs: String(Date.now() + 5_000),
        deliveryMode: "foreground",
        clientX,
        clientY,
        zoomFactor,
        button: 0
      });
    exactNativeBase(mouse, { ...identity, inputEpoch: "2" }, foregroundProbe);
    const expectedNativeX = Math.round(
      clientX * zoomFactor
    );
    const expectedNativeY = Math.round(
      clientY * zoomFactor
    );
    if (
      mouse.requestId !== "windows-probe-mouse" ||
      mouse.button !== 0 ||
      mouse.inputX !== expectedNativeX ||
      mouse.inputY !== expectedNativeY ||
      mouse.dispatchedEventCount !== 2
    ) {
      throw new Error("The Chromium view-local DIP mouse receipt is invalid.");
    }
    const mouseDom = await withDiagnosticDeadline(mousePending.input, 3_000);
    if (!mouseDom.received || mouseDom.value.length !== 3 ||
        mouseDom.value.some((receipt) =>
          !receipt.matches || !receipt.isTrusted ||
          receipt.clientX !== mouse.expectedDomClientX ||
          receipt.clientY !== mouse.expectedDomClientY
        )) {
      throw new Error("Chromium did not emit the exact trusted DOM mouse sequence.");
    }

    // Create the visible sibling Role host inside the same foreground runtime
    // parent. The probed Role is then hidden without selecting, showing, or
    // focusing it again; only the private preload arm message may cross in.
    control = new BaseWindow({
      parent,
      show: false,
      focusable: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      movable: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      backgroundColor: "#00000000"
    });
    control.setBounds(parentBounds);
    controlView = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        devTools: false,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false
      }
    });
    controlView.setBounds({
      x: 0,
      y: 0,
      width: childBounds.width,
      height: childBounds.height
    });
    control.contentView.addChildView(controlView);
    await controlView.webContents.loadURL(
      `data:text/html,${encodeURIComponent(
        "<meta charset=utf-8><input id=foreground-role autofocus>"
      )}`
    );
    // Match the product lifecycle: establish the exact native parent and child
    // styles before attempting Chromium focus or checking sibling ownership.
    const controlHandle = Buffer.from(control.getNativeWindowHandle());
    exactProbe(
      addon.attachWindowsChromiumInputHwnd(controlHandle, parentHandle),
      controlHandle,
      parentHandle
    );
    control.showInactive();
    exactProbe(
      addon.projectWindowsChromiumInputHwnd(controlHandle, parentHandle, true),
      controlHandle,
      parentHandle
    );
    view.setVisible(false);
    child.hide();
    exactProbe(
      addon.projectWindowsChromiumInputHwnd(surfaceHandle, parentHandle, false),
      surfaceHandle,
      parentHandle
    );
    controlView.webContents.focus();
    const foregroundRoleFocused = await controlView.webContents.executeJavaScript(
      "document.querySelector('#foreground-role').focus(); document.hasFocus()",
      true
    );
    if (!foregroundRoleFocused || view.webContents.isFocused() ||
        child.isVisible() || view.getVisible()) {
      throw new Error(`The sibling Role did not retain exact foreground ownership: ${JSON.stringify({
        foregroundRoleFocused, parentFocused: parent.isFocused(),
        siblingContentsFocused: controlView.webContents.isFocused(),
        targetContentsFocused: view.webContents.isFocused(),
        targetHostVisible: child.isVisible(), targetViewVisible: view.getVisible(),
        controlProbe: addon.probeWindowsChromiumInputHwnd(controlHandle, parentHandle)
      })}`);
    }
    const controlProbe = exactProbe(
      addon.probeWindowsChromiumInputHwnd(controlHandle, parentHandle),
      controlHandle,
      parentHandle
    );
    if (!controlProbe.parentWasForeground || !controlProbe.parentVisible ||
        !controlProbe.surfaceVisible) {
      throw new Error("The visible sibling Role did not share the exact foreground parent.");
    }
    const hiddenProbe = exactProbe(
      addon.probeWindowsChromiumInputHwnd(surfaceHandle, parentHandle),
      surfaceHandle,
      parentHandle
    );
    if (!hiddenProbe.parentWasForeground || !hiddenProbe.parentVisible ||
        hiddenProbe.surfaceVisible || hiddenProbe.targetWasForeground ||
        hiddenProbe.targetHadThreadFocus || !parent.isFocused()) {
      throw new Error("The target Role did not remain an exact hidden sibling surface.");
    }
    const hiddenIdentity = {
      ...identity,
      probeRevision: "2",
      inputEpoch: "3",
      deliveryMode: "background"
    };
    const hiddenKeyPending = await armInput("windows-probe-hidden-key", [
      { type: "keydown", code: "KeyB" },
      { type: "keyup", code: "KeyB" }
    ]);
    const hiddenKeyDown = submitKey({
        ...hiddenIdentity,
        requestId: "windows-probe-hidden-key-down",
        deadlineMs: String(Date.now() + 5_000),
        eventType: "keyDown",
        code: "KeyB",
        ctrl: false,
        alt: false,
        shift: false,
        meta: false,
        repeat: false
      });
    const hiddenKeyUp = submitKey({
        ...hiddenIdentity,
        requestId: "windows-probe-hidden-key-up",
        deadlineMs: String(Date.now() + 5_000),
        eventType: "keyUp",
        code: "KeyB",
        ctrl: false,
        alt: false,
        shift: false,
        meta: false,
        repeat: false
      });
    exactNativeBase(hiddenKeyDown, hiddenIdentity, hiddenProbe);
    exactNativeBase(hiddenKeyUp, hiddenIdentity, hiddenProbe);
    const hiddenKeyDom = await withDiagnosticDeadline(hiddenKeyPending.input, 3_000);
    if (!hiddenKeyDom.received || hiddenKeyDom.value.length !== 2 ||
        hiddenKeyDom.value.some((receipt) => !receipt.matches || !receipt.isTrusted) ||
        !controlView.webContents.isFocused() || view.webContents.isFocused() ||
        child.isVisible() || view.getVisible()) {
      throw new Error(
        "Hidden Chromium Role input lacked exact trusted DOM continuity or changed presentation."
      );
    }
    if (!parent.isFocused()) {
      throw new Error("Native input changed the exact foreground runtime parent.");
    }
    const finalProbe = exactProbe(
      addon.probeWindowsChromiumInputHwnd(surfaceHandle, parentHandle),
      surfaceHandle,
      parentHandle
    );
    writeSync(1, `${PROBE_PREFIX}${JSON.stringify({
      candidateEvidence: "foreground-and-hidden-product-path",
      platform: process.platform,
      displayScaleFactor: display.scaleFactor,
      beforeAttachProbe,
      afterAttachProbe,
      foregroundProbe,
      finalProbe,
      singleWebContentsSurface: child.contentView.children.length === 1 &&
        child.contentView.children[0] === view,
      preDispatchDomState,
      readyReceipt,
      keyArmReceipt: keyPending.armReceipt,
      keyDown,
      keyUp,
      keyDom,
      mouseArmReceipt: mousePending.armReceipt,
      mouse,
      mouseDom,
      controlProbe,
      hiddenProbe,
      hiddenKeyArmReceipt: hiddenKeyPending.armReceipt,
      hiddenKeyDown,
      hiddenKeyUp,
      hiddenKeyDom,
      hiddenPresentationPreserved: !child.isVisible() && !view.getVisible() &&
        !view.webContents.isFocused() && controlView.webContents.isFocused(),
      privateReceipts
    })}\n`);

    ipcMain.removeListener(channel, onPrivateReceipt);
    onPrivateReceipt = undefined;
    child.contentView.removeChildView(view);
    view.webContents.close({ waitForBeforeUnload: false });
    view = undefined;
    control.contentView.removeChildView(controlView);
    controlView.webContents.close({ waitForBeforeUnload: false });
    controlView = undefined;
    closeWindow(control);
    control = undefined;
    closeWindow(child);
    child = undefined;
    closeWindow(parent);
    parent = undefined;
    app.exit(0);
  } catch (error) {
    try {
      if (onPrivateReceipt) ipcMain.removeListener(channel, onPrivateReceipt);
      if (view && !view.webContents.isDestroyed()) {
        if (child?.contentView.children.includes(view)) {
          child.contentView.removeChildView(view);
        }
        view.webContents.close({ waitForBeforeUnload: false });
      }
      if (controlView && !controlView.webContents.isDestroyed()) {
        if (control?.contentView.children.includes(controlView)) {
          control.contentView.removeChildView(controlView);
        }
        controlView.webContents.close({ waitForBeforeUnload: false });
      }
      closeWindow(control);
      closeWindow(child);
      closeWindow(parent);
    } catch {
      // Preserve the original physical-probe failure.
    }
    writeSync(2, `${error instanceof Error ? error.stack : String(error)}\n`);
    app.exit(1);
  }
})();
