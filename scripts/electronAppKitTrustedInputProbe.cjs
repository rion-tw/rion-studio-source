const { mkdtempSync, writeSync } = require("node:fs");
const { randomUUID } = require("node:crypto");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const { app, BaseWindow, ipcMain, screen, WebContentsView } = require("electron");

const PROBE_PREFIX = "RION_ELECTRON_APPKIT_INPUT_PROBE=";

function addedNodes(before, after) {
  const prior = new Set(before.map((node) => node.address));
  return after.filter((node) => !prior.has(node.address));
}

function withDiagnosticDeadline(promise, milliseconds) {
  let deadline;
  return Promise.race([
    promise.then((value) => ({ received: true, value })),
    new Promise((resolve) => {
      // Diagnostic-only liveness bound: this probe must fail closed if
      // Chromium emits no exact callback for the native dispatch.
      deadline = setTimeout(() => resolve({ received: false }), milliseconds);
    })
  ]).finally(() => clearTimeout(deadline));
}

void (async () => {
  let controlWindow;
  let nativeHost;
  let onPrivateReceipt;
  let roleView;
  let surfaceCapture;
  let surfaceOwned = false;
  let window;
  const identity = {
    logicalWindowId: "appkit-input-probe-window",
    launchGeneration: "appkit-input-probe-launch-1",
    nativeGeneration: 1
  };
  const dispatchMode = process.env.RION_APPKIT_INPUT_PROBE_MODE ?? "direct-view";
  const foregroundControl = dispatchMode.startsWith("foreground-");
  const nativeDispatchMode = foregroundControl
    ? dispatchMode.slice("foreground-".length)
    : dispatchMode;
  const privateReceiptChannel = `rion-appkit-input-probe:${randomUUID()}`;
  const frameToken = randomUUID();
  const isolatedReceipts = [];
  const armWaiters = new Map();
  const inputWaiters = new Map();
  let resolveIsolatedReady;
  const isolatedReady = new Promise((resolve) => {
    resolveIsolatedReady = resolve;
  });
  try {
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
      mkdtempSync(join(tmpdir(), "rion-appkit-input-probe-"))
    );
    await app.whenReady();
    const displayScaleFactor = screen.getPrimaryDisplay().scaleFactor;
    const addon = require(addonPath);
    window = new BaseWindow({
      width: 800,
      height: 600,
      frame: true,
      show: false,
      useContentSize: true
    });
    nativeHost = addon.attachAppKitRuntimeHost(
      window.getNativeWindowHandle(),
      identity,
      () => undefined
    );
    if (typeof nativeHost.snapshotNativeViewTree !== "function") {
      throw new Error("The AppKit native-view feasibility snapshot is unavailable.");
    }

    onPrivateReceipt = (event, receipt) => {
      if (
        event.sender !== roleView?.webContents ||
        event.senderFrame.routingId !== event.sender.mainFrame.routingId ||
        !receipt ||
        receipt.roleId !== "probe-role" ||
        receipt.surfaceGeneration !== 1 ||
        receipt.frameToken !== frameToken
      ) {
        return;
      }
      isolatedReceipts.push(receipt);
      if (receipt.kind === "ready" && receipt.documentUrl.startsWith("data:")) {
        resolveIsolatedReady(receipt);
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
    ipcMain.on(privateReceiptChannel, onPrivateReceipt);

    roleView = new WebContentsView({
      webPreferences: {
        additionalArguments: [
          `--rion-appkit-probe-channel=${privateReceiptChannel}`,
          "--rion-appkit-probe-role=probe-role",
          "--rion-appkit-probe-generation=1",
          `--rion-appkit-probe-frame-token=${frameToken}`
        ],
        contextIsolation: true,
        devTools: false,
        nodeIntegration: false,
        preload: join(__dirname, "electronAppKitTrustedInputProbePreload.cjs"),
        sandbox: true,
        webviewTag: false
      }
    });
    // Non-zero slot offsets prove that the native NSView hierarchy, rather
    // than CSS coordinates, owns conversion into window coordinates.
    roleView.setBounds({ x: 73, y: 57, width: 700, height: 500 });
    roleView.setVisible(false);
    surfaceCapture = nativeHost.beginInputSurfaceCapture(identity, "probe-role", 1);
    const beforeAttach = nativeHost.snapshotNativeViewTree(identity);
    window.contentView.addChildView(roleView);
    const hiddenAfterAttach = nativeHost.snapshotNativeViewTree(identity);
    let surfaceOwnership;
    try {
      surfaceOwnership = nativeHost.commitInputSurfaceCapture(
        identity,
        "probe-role",
        1,
        surfaceCapture.captureSequence
      );
    } catch (error) {
      throw new Error(
        `${error.message}; hidden tree=${JSON.stringify(hiddenAfterAttach)}`,
        { cause: error }
      );
    }
    surfaceOwned = true;
    const afterAttach = hiddenAfterAttach;
    const hiddenCapturedRoot = addedNodes(beforeAttach, afterAttach).find(
      (node) => node.className === "WebContentsViewCocoa"
    );
    if (!hiddenCapturedRoot?.hidden || !hiddenCapturedRoot.attachedToWindow) {
      throw new Error("The hidden attached Chromium root was not captured exactly.");
    }

    const loaded = new Promise((resolve, reject) => {
      roleView.webContents.once("did-finish-load", resolve);
      roleView.webContents.once(
        "did-fail-load",
        (_event, code, _description, _url, isMainFrame) => {
          if (isMainFrame) reject(new Error(`Probe page failed with ${code}.`));
        }
      );
    });
    await roleView.webContents.loadURL(
      `data:text/html,${encodeURIComponent(
        "<meta charset=utf-8><input id=probe autofocus>"
      )}`
    );
    await loaded;
    const isolatedReadyReceipt = await withDiagnosticDeadline(isolatedReady, 2_000);
    if (!isolatedReadyReceipt.received) {
      throw new Error("The isolated preload did not publish exact main-frame readiness.");
    }
    const armIsolatedInput = async (inputSequence, expectedEvents) => {
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
      roleView.webContents.send(`${privateReceiptChannel}:arm`, {
        inputSequence,
        expectedEvents
      });
      const armReceipt = await withDiagnosticDeadline(arm, 2_000);
      if (!armReceipt.received || armReceipt.value.kind !== "armed") {
        armWaiters.delete(inputSequence);
        inputWaiters.delete(inputSequence);
        throw new Error(`The isolated preload rejected input sequence ${inputSequence}.`);
      }
      return { armReceipt: armReceipt.value, input };
    };
    const afterLoad = nativeHost.snapshotNativeViewTree(identity);
    const immediateAdded = addedNodes(beforeAttach, afterAttach);
    const loadedAdded = addedNodes(beforeAttach, afterLoad);
    const immediateRoots = immediateAdded.filter((candidate) =>
      !immediateAdded.some((node) => node.address === candidate.parentAddress)
    );
    const rendererTargets = loadedAdded.filter((candidate) =>
      candidate.acceptsFirstResponder &&
      candidate.attachedToWindow &&
      candidate.className.includes("RenderWidgetHostView")
    );
    if (rendererTargets.length !== 1) {
      throw new Error(
        `Expected one exact Chromium renderer target, received ${rendererTargets.length}.`
      );
    }

    roleView.setVisible(true);
    const targetFocused = new Promise((resolve) => window.once("focus", resolve));
    window.show();
    window.focus();
    await targetFocused;
    roleView.webContents.focus();
    const activeElement = await roleView.webContents.executeJavaScript(
      "document.querySelector('#probe').focus(); document.activeElement?.id",
      true
    );
    if (activeElement !== "probe") {
      throw new Error("The Chromium probe input did not become the active element.");
    }

    controlWindow = new BaseWindow({
      width: 320,
      height: 200,
      frame: true,
      show: false,
      useContentSize: true
    });
    const controlFocused = new Promise((resolve) =>
      controlWindow.once("focus", resolve)
    );
    controlWindow.show();
    controlWindow.focus();
    await controlFocused;
    if (foregroundControl) {
      const refocused = new Promise((resolve) => window.once("focus", resolve));
      window.focus();
      await refocused;
      roleView.webContents.focus();
    } else if (window.isFocused() || !controlWindow.isFocused()) {
      throw new Error("The AppKit target window did not enter exact background state.");
    }

    const backgroundTree = nativeHost.snapshotNativeViewTree(identity);
    const rendererTarget = backgroundTree.find(
      (candidate) => candidate.address === rendererTargets[0].address
    );
    if (!rendererTarget?.attachedToWindow || rendererTarget.hidden) {
      throw new Error("The exact background Chromium target is detached or hidden.");
    }
    const preDispatchDomState = await roleView.webContents.executeJavaScript(
      `({
        activeElementId: document.activeElement?.id ?? null,
        documentHasFocus: document.hasFocus(),
        visibilityState: document.visibilityState
      })`,
      true
    );
    const beforeInputEvents = [];
    let resolveBeforeInput;
    const beforeInputEvent = new Promise((resolve) => {
      resolveBeforeInput = resolve;
    });
    const onBeforeInput = (_event, input) => {
      const receipt = {
        code: input.code,
        isAutoRepeat: input.isAutoRepeat,
        key: input.key,
        type: input.type
      };
      beforeInputEvents.push(receipt);
      resolveBeforeInput(receipt);
    };
    roleView.webContents.on("before-input-event", onBeforeInput);
    const electronFocusEvents = [];
    for (const [source, emitter] of [
      ["control-window", controlWindow],
      ["target-web-contents", roleView.webContents],
      ["target-window", window]
    ]) {
      emitter.on("blur", () => electronFocusEvents.push(`${source}:blur`));
      emitter.on("focus", () => electronFocusEvents.push(`${source}:focus`));
    }
    await roleView.webContents.executeJavaScript(
      `(() => {
        globalThis.__rionAppKitFocusEvents = [];
        addEventListener("blur", () => globalThis.__rionAppKitFocusEvents.push("window:blur"));
        addEventListener("focus", () => globalThis.__rionAppKitFocusEvents.push("window:focus"));
        globalThis.__rionAppKitKeyReceipt = new Promise((resolve) => {
          addEventListener("keydown", (event) => resolve({
            activeElementId: document.activeElement?.id ?? null,
            code: event.code,
            isTrusted: event.isTrusted,
            key: event.key
          }), { once: true });
        });
        return true;
      })()`,
      true
    );
    const domKeyEvent = roleView.webContents.executeJavaScript(
      "globalThis.__rionAppKitKeyReceipt",
      true
    );
    const isolatedKeyPending = await armIsolatedInput("probe-key-sequence", [
      { type: "keydown", code: "KeyA" },
      { type: "keyup", code: "KeyA" }
    ]);
    const nativeKeyReceipt = nativeDispatchMode === "direct-view"
      ? {
          down: nativeHost.submitNativeBackgroundKey(identity, {
            requestId: "probe-key-down",
            roleId: "probe-role",
            surfaceGeneration: 1,
            inputEpoch: "1",
            deadlineMs: String(Date.now() + 5_000),
            eventType: "keyDown",
            code: "KeyA",
            modifierFlags: 0,
            repeat: false
          }),
          up: nativeHost.submitNativeBackgroundKey(identity, {
            requestId: "probe-key-up",
            roleId: "probe-role",
            surfaceGeneration: 1,
            inputEpoch: "1",
            deadlineMs: String(Date.now() + 5_000),
            eventType: "keyUp",
            code: "KeyA",
            modifierFlags: 0,
            repeat: false
          })
        }
      : nativeHost.probeDispatchKey(
          identity,
          rendererTarget.address,
          0,
          "a",
          0,
          nativeDispatchMode
        );
    const beforeInputCountAtNativeReturn = beforeInputEvents.length;
    roleView.webContents.removeListener("before-input-event", onBeforeInput);
    const [beforeInputReceipt, domKeyReceipt] = await Promise.all([
      withDiagnosticDeadline(beforeInputEvent, 2_000),
      withDiagnosticDeadline(domKeyEvent, 2_000)
    ]);
    const isolatedKeyReceipt = await withDiagnosticDeadline(
      isolatedKeyPending.input,
      2_000
    );
    if (!isolatedKeyReceipt.received || isolatedKeyReceipt.value.length !== 2) {
      throw new Error("The isolated preload did not acknowledge the exact key sequence.");
    }
    const mouseProbeReceipts = [];
    for (const [index, zoomFactor] of [1, 1.25, 2].entries()) {
      const clientX = 80;
      const clientY = 120;
      roleView.webContents.setZoomFactor(zoomFactor);
      if (roleView.webContents.getZoomFactor() !== zoomFactor) {
        throw new Error(`Chromium rejected probe zoom ${zoomFactor}.`);
      }
      await roleView.webContents.executeJavaScript(
        `(() => {
          globalThis.__rionAppKitMouseEvents = [];
          globalThis.__rionAppKitMouseReceipt = new Promise((resolve) => {
            for (const type of ["mousedown", "mouseup", "click"]) {
              addEventListener(type, (event) => {
                const receipt = {
                  button: event.button,
                  clientX: event.clientX,
                  clientY: event.clientY,
                  isTrusted: event.isTrusted,
                  type: event.type
                };
                globalThis.__rionAppKitMouseEvents.push(receipt);
                if (type === "click") resolve(receipt);
              }, { once: true });
            }
          });
          return true;
        })()`,
        true
      );
      const beforeMouseInputEvent = new Promise((resolve) => {
        roleView.webContents.once("before-input-event", (_event, input) => {
          resolve({
            code: input.code,
            key: input.key,
            type: input.type
          });
        });
      });
      const domMouseEvent = roleView.webContents.executeJavaScript(
        "globalThis.__rionAppKitMouseReceipt",
        true
      );
      const expectedMouseEvents = ["mousedown", "mouseup", "click"].map((type) => ({
        type,
        button: 0,
        clientX,
        clientY
      }));
      const isolatedMousePending = await armIsolatedInput(
        `probe-mouse-sequence-${index + 1}`,
        expectedMouseEvents
      );
      const nativeMouseReceipt = nativeHost.submitNativeBackgroundMouse(identity, {
        requestId: `probe-mouse-click-${index + 1}`,
        roleId: "probe-role",
        surfaceGeneration: 1,
        inputEpoch: String(index + 2),
        deadlineMs: String(Date.now() + 5_000),
        clientX,
        clientY,
        zoomFactor,
        button: 0,
        modifierFlags: 0
      });
      const expectedAppKitPointX = nativeMouseReceipt.targetX +
        clientX * zoomFactor;
      const expectedAppKitPointY = nativeMouseReceipt.targetFlipped
        ? nativeMouseReceipt.targetY + clientY * zoomFactor
        : nativeMouseReceipt.targetY + nativeMouseReceipt.targetHeight -
          clientY * zoomFactor;
      if (
        nativeMouseReceipt.clientX !== clientX ||
        nativeMouseReceipt.clientY !== clientY ||
        nativeMouseReceipt.zoomFactor !== zoomFactor ||
        nativeMouseReceipt.appKitPointX !== expectedAppKitPointX ||
        nativeMouseReceipt.appKitPointY !== expectedAppKitPointY ||
        !Number.isFinite(nativeMouseReceipt.windowPointX) ||
        !Number.isFinite(nativeMouseReceipt.windowPointY)
      ) {
        throw new Error(
          `The native CSS-to-AppKit receipt mismatched: ${JSON.stringify(nativeMouseReceipt)}`
        );
      }
      const [beforeMouseInputReceipt, domMouseReceipt] = await Promise.all([
        withDiagnosticDeadline(beforeMouseInputEvent, 2_000),
        withDiagnosticDeadline(domMouseEvent, 2_000)
      ]);
      const isolatedMouseReceipt = await withDiagnosticDeadline(
        isolatedMousePending.input,
        2_000
      );
      if (!isolatedMouseReceipt.received || isolatedMouseReceipt.value.length !== 3 ||
          !domMouseReceipt.received ||
          domMouseReceipt.value.clientX !== clientX ||
          domMouseReceipt.value.clientY !== clientY) {
        throw new Error(
          `The isolated preload did not acknowledge the exact mouse sequence: ${JSON.stringify({
            isolatedMouseReceipt,
            nativeMouseReceipt,
            domMouseReceipt
          })}`
        );
      }
      const domMouseEvents = await roleView.webContents.executeJavaScript(
        "globalThis.__rionAppKitMouseEvents",
        true
      );
      mouseProbeReceipts.push({
        beforeMouseInputReceipt,
        domMouseEvents,
        domMouseReceipt,
        isolatedMouseArmReceipt: isolatedMousePending.armReceipt,
        isolatedMouseReceipt,
        nativeMouseReceipt,
        zoomFactor
      });
    }
    await new Promise((resolve) => setImmediate(resolve));
    const domFocusEvents = await roleView.webContents.executeJavaScript(
      "globalThis.__rionAppKitFocusEvents",
      true
    );
    writeSync(1, `${PROBE_PREFIX}${JSON.stringify({
      afterAttachCount: afterAttach.length,
      afterLoadCount: afterLoad.length,
      backgroundTarget: rendererTarget,
      beforeInputReceipt,
      beforeInputCountAtNativeReturn,
      beforeInputEvents,
      beforeAttachCount: beforeAttach.length,
      dispatchMode,
      displayScaleFactor,
      domFocusEvents,
      domKeyReceipt,
      electronFocusEvents,
      foregroundControl,
      immediateAdded,
      immediateRootCount: immediateRoots.length,
      immediateRoots,
      hiddenCapturedRoot,
      isolatedKeyArmReceipt: isolatedKeyPending.armReceipt,
      isolatedKeyReceipt,
      isolatedReadyReceipt,
      isolatedReceipts,
      loadedAdded,
      nativeKeyReceipt,
      mouseProbeReceipts,
      platform: process.platform,
      preDispatchDomState,
      surfaceCapture,
      surfaceOwnership
    })}\n`);

    const controlClosed = new Promise((resolve) =>
      controlWindow.once("closed", resolve)
    );
    controlWindow.close();
    await controlClosed;
    controlWindow = undefined;
    if (!nativeHost.retireInputSurface(identity, "probe-role", 1)) {
      throw new Error("The exact AppKit input-surface ownership did not retire.");
    }
    surfaceOwned = false;
    window.contentView.removeChildView(roleView);
    const destroyed = new Promise((resolve) => roleView.webContents.once("destroyed", resolve));
    roleView.webContents.close({ waitForBeforeUnload: false });
    await destroyed;
    roleView = undefined;
    nativeHost.destroy(identity);
    nativeHost = undefined;
    ipcMain.removeListener(privateReceiptChannel, onPrivateReceipt);
    onPrivateReceipt = undefined;
    const closed = new Promise((resolve) => window.once("closed", resolve));
    window.close();
    await closed;
    window = undefined;
    app.exit(0);
  } catch (error) {
    try {
      if (roleView && !roleView.webContents.isDestroyed()) {
        if (surfaceOwned) {
          nativeHost?.retireInputSurface(identity, "probe-role", 1);
          surfaceOwned = false;
        } else if (surfaceCapture) {
          nativeHost?.cancelInputSurfaceCapture(
            identity,
            "probe-role",
            1,
            surfaceCapture.captureSequence
          );
        }
        window?.contentView.removeChildView(roleView);
        roleView.webContents.close({ waitForBeforeUnload: false });
      }
      nativeHost?.destroy(identity);
      if (onPrivateReceipt) {
        ipcMain.removeListener(privateReceiptChannel, onPrivateReceipt);
        onPrivateReceipt = undefined;
      }
      if (controlWindow && !controlWindow.isDestroyed()) controlWindow.close();
      if (window && !window.isDestroyed()) window.close();
    } catch {
      // Preserve the original bounded feasibility failure.
    }
    writeSync(2, `${error instanceof Error ? error.stack : String(error)}\n`);
    app.exit(1);
  }
})();
