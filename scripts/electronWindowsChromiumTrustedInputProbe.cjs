const { randomUUID } = require("node:crypto");
const { mkdtempSync, writeSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const { app, BrowserWindow, ipcMain, screen, WebContentsView, webContents, session } = require("electron");

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

function exactNativeBase(receipt, expected, probe) {
  if (receipt.ownerKind !== "view" || receipt.status !== "submitted" ||
      receipt.submissionApi !== "webContents.sendInputEvent" ||
      receipt.roleId !== expected.roleId || receipt.surfaceGeneration !== expected.surfaceGeneration ||
      receipt.nativeGeneration !== expected.nativeGeneration || receipt.bindingRevision !== expected.bindingRevision ||
      receipt.parentIdentity !== expected.parentIdentity || receipt.webContentsId !== expected.webContentsId ||
      receipt.probeRevision !== probe.probeRevision || receipt.inputEpoch !== expected.inputEpoch ||
      receipt.deliveryMode !== expected.deliveryMode || !receipt.viewAttached || !receipt.foregroundPreserved ||
      JSON.stringify(receipt.observation) !== JSON.stringify(probe.observation) ||
      !/^[1-9][0-9]*$/u.test(receipt.dispatchSequence) || !/^[1-9][0-9]*$/u.test(receipt.submittedAtMs)) {
    throw new Error(`The ${receipt.requestId} exact View submission receipt is invalid.`);
  }
}

function closeWindow(window) {
  if (window && !window.isDestroyed()) window.destroy();
}

void (async () => {
  let attachments;
  let focus;
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
    if (typeof addon.readWindowsRuntimeForeground !== "function") throw new Error("Native parent observation is unavailable.");

    const display = screen.getPrimaryDisplay();
    parent = new BrowserWindow({
      x: display.workArea.x + 80,
      y: display.workArea.y + 80,
      width: 760,
      height: 560,
      useContentSize: true,
      frame: true,
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true,
        partition: `rion-input-probe-host-${randomUUID()}` }
    });
    const parentBounds = parent.getContentBounds();
    const { ChromiumViewAttachmentCoordinator, ChromiumViewTrustedInputHost,
      ChromiumViewFocusAdmission, windowsChromiumViewParentBinding } = require("./electronLoadChromiumInputOwner.cjs");
    const parentBinding = windowsChromiumViewParentBinding({ window: parent, logicalParent: parent,
      identity: { nativeGeneration: 1, ownerRevision: "1" } }, addon,
    () => webContents.getFocusedWebContents()?.id ?? null);
    let attachmentFailure;
    attachments = new ChromiumViewAttachmentCoordinator({ resolveParent: candidate => candidate === parent ? parentBinding : null,
      nowMs: Date.now, onError: error => { attachmentFailure = error; } });
    focus = new ChromiumViewFocusAdmission({ attachments, nowMs: Date.now,
      deadlines: { schedule: (callback, delay) => setTimeout(callback, delay), cancel: clearTimeout },
      activateParent: target => {
        if (!parent.isVisible()) parent.show();
        target.observe();
        if (!parent.isFocused()) parent.focus();
      } });
    const hosts = new ChromiumViewTrustedInputHost({ attachments, focus: request => focus.focus(request) });
    const attach = async (roleId, target) => attachments.attach({ roleId, generation: 1, parent, view: target,
      isCancelled: () => false, attach: () => parent.contentView.addChildView(target),
      attachTo: host => host.contentView.addChildView(target), detach: () => parent.contentView.removeChildView(target) });
    const admitFocus = async roleId => {
      const binding = hosts.resolve(roleId, 1);
      if (!binding) throw new Error("The probe has no current View input owner.");
      const now = Date.now();
      const receipt = await binding.native.focusForeground(binding.identity, { roleId, surfaceGeneration: 1,
        requestId: `focus-${roleId}`, inputEpoch: 0, scheduledAtMs: now, deadlineMs: now + 5000,
        intent: "normal", action: { type: "focus" }, expectedInputNeutralityBefore: true, expectedInputNeutralityAfter: true });
      if (receipt.status !== "applied") throw new Error(`View focus admission failed: ${JSON.stringify(receipt)}`);
      return receipt;
    };

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
        session: session.fromPartition(`probe-target-${randomUUID()}`),
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
      width: 600,
      height: 400
    };
    view.setBounds(viewBounds);
    view.setVisible(true);
    await attach("probe-role", view);

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

    const focusReceipt = await admitFocus("probe-role");
    const activeElement = await view.webContents.executeJavaScript(
      "document.querySelector('#probe').focus(); document.activeElement?.id", true);
    if (activeElement !== "probe") throw new Error("The target input did not establish initial DOM focus.");
    const binding = hosts.resolve("probe-role", 1);
    const probe = mode => {
      if (attachmentFailure) throw attachmentFailure;
      return binding.native.probeExactInputSurface(binding.identity, mode);
    };
    const foregroundProbe = probe("foreground");
    const preDispatchDomState = await view.webContents.executeJavaScript(
      `({
        activeElementId: document.activeElement?.id ?? null,
        documentHasFocus: document.hasFocus(),
        visibilityState: document.visibilityState
      })`,
      true
    );

    const identity = { ...binding.identity, inputEpoch: "1", deliveryMode: "foreground" };
    const submitKey = request => binding.native.submitNativeBackgroundKey(binding.identity, request);
    const submitClick = request => binding.native.submitNativeBackgroundMouse(binding.identity, request);
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
    const expectedViewport = { width: Math.round(viewBounds.width / zoomFactor), height: Math.round(viewBounds.height / zoomFactor) };
    await view.webContents.executeJavaScript(`(() => {
      window.viewportProbe = new Promise(resolve => {
        let deadline;
        const finish = status => { clearTimeout(deadline); removeEventListener("resize", inspect);
          resolve({ status, width: innerWidth, height: innerHeight }); };
        const inspect = () => { if (innerWidth === ${expectedViewport.width} && innerHeight === ${expectedViewport.height}) finish("applied"); };
        addEventListener("resize", inspect);
        deadline = setTimeout(() => finish("indeterminate"), 3000);
      });
    })()`);
    view.webContents.setZoomFactor(zoomFactor);
    const viewportAcknowledgement = await view.webContents.executeJavaScript("window.viewportProbe");
    if (viewportAcknowledgement.status !== "applied") throw new Error("The visible renderer did not acknowledge zoom.");
    const mouseProbe = probe("foreground");

    const mousePending = await armInput("windows-probe-mouse", [
      { type: "mousedown", button: 0, clientX, clientY },
      { type: "mouseup", button: 0, clientX, clientY },
      { type: "click", button: 0, clientX, clientY }
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
    exactNativeBase(mouse, { ...identity, inputEpoch: "2" }, mouseProbe);
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

    // A separate Session and exact sibling View share only the runtime parent.
    controlView = new WebContentsView({
      webPreferences: {
        session: session.fromPartition(`probe-sibling-${randomUUID()}`),
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
      width: parentBounds.width,
      height: parentBounds.height
    });
    controlView.setVisible(true);
    await attach("sibling-role", controlView);
    await controlView.webContents.loadURL(
      `data:text/html,${encodeURIComponent(
        "<meta charset=utf-8><input id=foreground-role autofocus>"
      )}`
    );
    view.setVisible(false);
    attachments.syncPresentation({ roleId: "probe-role", generation: 1, parent, physicalParent: parent, view });
    await admitFocus("sibling-role");
    const foregroundRoleFocused = await controlView.webContents.executeJavaScript(
      "document.querySelector('#foreground-role').focus(); document.hasFocus()", true);
    if (!foregroundRoleFocused || view.webContents.isFocused() || view.getVisible()) {
      throw new Error("The sibling View did not retain exact foreground ownership.");
    }
    const sibling = hosts.resolve("sibling-role", 1);
    const controlProbe = sibling.native.probeExactInputSurface(sibling.identity, "foreground");
    const hiddenFocusReceipt = await admitFocus("probe-role");
    const hiddenProbe = probe("background");
    const hiddenIdentity = {
      ...identity,
      inputEpoch: "3",
      deliveryMode: "background"
    };
    const hiddenKeyPending = await armInput("windows-probe-hidden-key", [
      { type: "keydown", code: "KeyB", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false },
      { type: "keyup", code: "KeyB", ctrlKey: true, shiftKey: true, altKey: false, metaKey: false }
    ]);
    const hiddenKeyDown = submitKey({
        ...hiddenIdentity,
        requestId: "windows-probe-hidden-key-down",
        deadlineMs: String(Date.now() + 5_000),
        eventType: "keyDown",
        code: "KeyB",
        ctrl: true,
        alt: false,
        shift: true,
        meta: false,
        repeat: false
      });
    const hiddenKeyUp = submitKey({
        ...hiddenIdentity,
        requestId: "windows-probe-hidden-key-up",
        deadlineMs: String(Date.now() + 5_000),
        eventType: "keyUp",
        code: "KeyB",
        ctrl: true,
        alt: false,
        shift: true,
        meta: false,
        repeat: false
      });
    exactNativeBase(hiddenKeyDown, hiddenIdentity, hiddenProbe);
    exactNativeBase(hiddenKeyUp, hiddenIdentity, hiddenProbe);
    const hiddenKeyDom = await withDiagnosticDeadline(hiddenKeyPending.input, 3_000);
    if (!hiddenKeyDom.received || hiddenKeyDom.value.length !== 2 ||
        hiddenKeyDom.value.some((receipt) => !receipt.matches || !receipt.isTrusted) ||
        !controlView.webContents.isFocused() || view.webContents.isFocused() ||
        view.getVisible()) {
      throw new Error(
        "Hidden Chromium Role input lacked exact trusted DOM continuity or changed presentation."
      );
    }
    await cancelInput("windows-probe-hidden-key");
    const hiddenMousePending = await armInput("windows-probe-hidden-middle", [
      { type: "mousedown", button: 1, clientX, clientY },
      { type: "mouseup", button: 1, clientX, clientY },
      { type: "auxclick", button: 1, clientX, clientY }
    ]);
    const hiddenMouseProbe = probe("background");
    const hiddenMouse = submitClick({ ...hiddenIdentity, requestId: "windows-probe-hidden-middle",
      inputEpoch: "4", deadlineMs: String(Date.now() + 5000), clientX, clientY, zoomFactor, button: 1 });
    exactNativeBase(hiddenMouse, { ...hiddenIdentity, inputEpoch: "4" }, hiddenMouseProbe);
    const hiddenMouseDom = await withDiagnosticDeadline(hiddenMousePending.input, 3000);
    if (!hiddenMouseDom.received || hiddenMouseDom.value.length !== 3 ||
        hiddenMouseDom.value.some(receipt => !receipt.isTrusted || !receipt.matches) ||
        !controlView.webContents.isFocused() || view.webContents.isFocused() || view.getVisible()) {
      throw new Error("Hidden middle-button input changed focus or lacked exact trusted CSS coordinates.");
    }
    if (!parent.isFocused()) {
      throw new Error("Native input changed the exact foreground runtime parent.");
    }
    const finalProbe = probe("background");
    writeSync(1, `${PROBE_PREFIX}${JSON.stringify({
      candidateEvidence: "foreground-and-hidden-product-path",
      platform: process.platform,
      displayScaleFactor: display.scaleFactor,
      ownerKind: "view",
      focusReceipt,
      hiddenFocusReceipt,
      viewportAcknowledgement,
      foregroundProbe,
      finalProbe,
      exactSiblingViews: parent.contentView.children.length === 2 &&
        parent.contentView.children.includes(view) && parent.contentView.children.includes(controlView) &&
        view.webContents.session !== controlView.webContents.session,
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
      hiddenMouse,
      hiddenMouseDom,
      hiddenPresentationPreserved: !view.getVisible() &&
        !view.webContents.isFocused() && controlView.webContents.isFocused(),
      privateReceipts
    })}\n`);

    ipcMain.removeListener(channel, onPrivateReceipt);
    onPrivateReceipt = undefined;
    await attachments.retire("probe-role", 1, parent);
    parent.contentView.removeChildView(view);
    view.webContents.close({ waitForBeforeUnload: false });
    view = undefined;
    await attachments.retire("sibling-role", 1, parent);
    parent.contentView.removeChildView(controlView);
    controlView.webContents.close({ waitForBeforeUnload: false });
    controlView = undefined;
    focus.dispose();
    await attachments.dispose();
    closeWindow(parent);
    parent = undefined;
    app.exit(0);
  } catch (error) {
    try {
      if (onPrivateReceipt) ipcMain.removeListener(channel, onPrivateReceipt);
      focus?.dispose();
      await attachments?.dispose();
      for (const target of [view, controlView]) {
        if (target && !target.webContents.isDestroyed()) {
          if (parent?.contentView.children.includes(target)) parent.contentView.removeChildView(target);
          target.webContents.close({ waitForBeforeUnload: false });
        }
      }
      closeWindow(parent);
    } catch {
      // Preserve the original physical-probe failure.
    }
    writeSync(2, `${error instanceof Error ? error.stack : String(error)}\n`);
    app.exit(1);
  }
})();
