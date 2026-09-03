const { execFile } = require("node:child_process");
const { mkdtempSync, writeSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { promisify } = require("node:util");

const { app, BaseWindow, WebContentsView } = require("electron");

const PROBE_PREFIX = "RION_ELECTRON_APPKIT_PROBE=";
const DESKTOP_E2E_METHODS = Object.freeze([
  "desktopE2eAccessibilityPress",
  "desktopE2eAccessibilityClose",
  "desktopE2eAccessibilityShowMenu",
  "desktopE2eTitlebarGeometry",
  "desktopE2eFullscreenToolbarState",
  "desktopE2eStatusPresentation"
]);
const DIAGNOSTIC_DEADLINE_MS = 8_000;
const executeFile = promisify(execFile);

async function inspectMacosAccessibilityTabs(processId, tabNames) {
  const script = String.raw`
on run argv
  set targetPid to (item 1 of argv) as integer
  set expectedNames to items 2 thru -1 of argv
  tell application "System Events"
    set matchingProcesses to application processes whose unix id is targetPid
    if (count of matchingProcesses) is not 1 then error "exact AppKit probe process unavailable"
    set targetProcess to item 1 of matchingProcesses
    set radioCount to 0
    set matchingRadioCount to 0
    set tabGroupCount to 0
    set groupCount to 0
    set buttonCount to 0
    set allContents to get entire contents of targetProcess
    set totalCount to count of allContents
    set roleAttributeCount to 0
    repeat with candidateReference in allContents
      set candidate to contents of candidateReference
      try
        set candidateRole to value of attribute "AXRole" of candidate
        set roleAttributeCount to roleAttributeCount + 1
        if candidateRole is "AXRadioButton" then
          set radioCount to radioCount + 1
          set candidateDescription to value of attribute "AXDescription" of candidate
          if expectedNames contains candidateDescription then
            set matchingRadioCount to matchingRadioCount + 1
          end if
        else if candidateRole is "AXTabGroup" then
          set tabGroupCount to tabGroupCount + 1
        else if candidateRole is "AXGroup" then
          set groupCount to groupCount + 1
        else if candidateRole is "AXButton" then
          set buttonCount to buttonCount + 1
        end if
      end try
    end repeat
    return (radioCount as text) & tab & (matchingRadioCount as text) & tab & (tabGroupCount as text) & tab & (groupCount as text) & tab & (buttonCount as text) & tab & (totalCount as text) & tab & (roleAttributeCount as text)
  end tell
end run`;
  const { stdout } = await executeFile("/usr/bin/osascript", [
    "-e",
    script,
    "--",
    String(processId),
    ...tabNames
  ], { encoding: "utf8", timeout: DIAGNOSTIC_DEADLINE_MS });
  const values = stdout.trim().split("\t").map(Number);
  if (values.length !== 7 || values.some((value) => !Number.isSafeInteger(value))) {
    throw new Error(`Invalid AppKit AX hierarchy observation: ${stdout.trim()}.`);
  }
  return Object.freeze({
    buttonCount: values[4],
    groupCount: values[3],
    matchingRadioCount: values[1],
    radioCount: values[0],
    roleAttributeCount: values[6],
    tabGroupCount: values[2],
    totalCount: values[5]
  });
}

function withDiagnosticDeadline(promise, description) {
  let deadline;
  return Promise.race([
    promise.then((value) => ({ received: true, value })),
    new Promise((resolve) => {
      // Diagnostic-only external-liveness boundary: AppKit/Electron callbacks
      // are authoritative. Elapsed time only terminalizes this probe as failed.
      deadline = setTimeout(
        () => resolve({ received: false }),
        DIAGNOSTIC_DEADLINE_MS
      );
    })
  ]).finally(() => clearTimeout(deadline)).then((receipt) => {
    if (!receipt.received) {
      throw new Error(`Timed out waiting for ${description}.`);
    }
    return receipt.value;
  });
}

async function waitForDiagnosticSnapshot(read, matches, description) {
  const startedAt = Date.now();
  let observed;
  while (Date.now() - startedAt < DIAGNOSTIC_DEADLINE_MS) {
    observed = read();
    if (matches(observed)) return observed;
    await new Promise((resolve) => {
      // Diagnostic-only external-liveness sampling. A sample never establishes
      // success unless the exact native readback predicate is satisfied.
      setTimeout(resolve, 16);
    });
  }
  throw new Error(
    `Timed out waiting for ${description}; observed=${JSON.stringify(observed)}.`
  );
}

function exactIdentity(event, identity) {
  return event?.identity?.logicalWindowId === identity.logicalWindowId &&
    event.identity.launchGeneration === identity.launchGeneration &&
    event.identity.nativeGeneration === identity.nativeGeneration;
}

function assertDesktopE2eSurface(addon, expected) {
  const prototype = addon.NativeAppKitRuntimeHost?.prototype;
  if (!prototype) {
    throw new Error("The AppKit N-API runtime-host class is unavailable.");
  }
  const present = DESKTOP_E2E_METHODS.filter(
    (method) => typeof prototype[method] === "function"
  );
  if (expected && present.length !== DESKTOP_E2E_METHODS.length) {
    throw new Error(
      `The desktop-E2E addon is missing native probe methods: ${DESKTOP_E2E_METHODS.filter((method) => !present.includes(method)).join(", ")}.`
    );
  }
  if (!expected && present.length > 0) {
    throw new Error(
      `The production addon exposes forbidden desktop-E2E methods: ${present.join(", ")}.`
    );
  }
  return present;
}

function titlebarFitsNativeWindow(geometry) {
  const tolerance = 2;
  return geometry.valid && geometry.titleHidden && geometry.rootWidth > 0 &&
    geometry.trafficLightsMaxX > 0 &&
    geometry.tabMaxX > geometry.tabMinX &&
    geometry.tabMaxY > geometry.tabMinY &&
    geometry.tabMinX >= geometry.trafficLightsMaxX - tolerance &&
    geometry.tabMinX >= geometry.windowNameMaxX - tolerance &&
    geometry.tabMaxX <= geometry.rootMinX + geometry.rootWidth + tolerance;
}

function fullscreenToolbarEntered(state) {
  return state.valid && state.fullscreen && state.fullscreenHostReady &&
    state.alwaysShowInFullScreen && state.accessoryOnScreen &&
    state.accessoryVisibleHeight > 0.5 && state.tabStripOnScreen &&
    state.toolbarPinned && state.visibleTrafficLightCount === 3 &&
    state.alwaysHideTabCloseButton && state.tabCloseButtonEnabledCount === 0;
}

function fullscreenToolbarExited(state) {
  return state.valid && !state.fullscreen && !state.fullscreenHostReady &&
    state.alwaysShowInFullScreen && state.accessoryOnScreen &&
    state.accessoryVisibleHeight > 0.5 && state.tabStripOnScreen &&
    state.toolbarPinned && state.visibleTrafficLightCount === 3 &&
    state.alwaysHideTabCloseButton && state.tabCloseButtonEnabledCount === 0;
}

void (async () => {
  let controlWindow;
  let nativeHost;
  let roleView;
  let window;
  const identity = {
    logicalWindowId: "appkit-probe-window",
    launchGeneration: "appkit-probe-launch-1",
    nativeGeneration: 1
  };
  const events = [];
  const nativeEventWaiters = new Set();
  try {
    if (process.platform !== "darwin") {
      throw new Error("The retained AppKit runtime probe requires macOS.");
    }
    const desktopE2eBuild = process.env.RION_STUDIO_DESKTOP_E2E_BUILD === "1";
    const addonPath = process.env.RION_ELECTRON_ADDON_PATH ?? join(
      __dirname,
      "..",
      "build",
      "native",
      `${process.platform}-${process.arch}`,
      "rion-core.node"
    );
    const userDataDirectory = process.env.RION_ELECTRON_PROBE_USER_DATA_DIR ??
      mkdtempSync(join(tmpdir(), "rion-appkit-probe-"));
    app.setPath("userData", userDataDirectory);
    await app.whenReady();
    const addon = require(addonPath);
  if (addon.appKitRuntimeAbiVersion() !== 6) {
      throw new Error("The shared AppKit ABI v4 is unavailable.");
    }
    if (typeof addon.attachAppKitRuntimeHost !== "function") {
      throw new Error("The AppKit N-API attach function is unavailable.");
    }
    const desktopE2eMethods = assertDesktopE2eSurface(addon, desktopE2eBuild);

    window = new BaseWindow({
      width: 800,
      height: 600,
      minWidth: 640,
      minHeight: 480,
      frame: true,
      show: false,
      useContentSize: true
    });
    const nativeHandle = window.getNativeWindowHandle();
    let malformedHandleRejected = false;
    try {
      addon.attachAppKitRuntimeHost(
        Buffer.alloc(Math.max(1, nativeHandle.byteLength - 1)),
        identity,
        () => undefined
      );
    } catch {
      malformedHandleRejected = true;
    }
    if (!malformedHandleRejected) {
      throw new Error("The AppKit adapter accepted a malformed native handle.");
    }

    let resolveFirstEvent;
    let rejectFirstEvent;
    const firstEvent = new Promise((resolve, reject) => {
      resolveFirstEvent = resolve;
      rejectFirstEvent = reject;
    });
    nativeHost = addon.attachAppKitRuntimeHost(
      nativeHandle,
      identity,
      (eventJson) => {
        if (typeof eventJson !== "string") {
          rejectFirstEvent(new Error(
            "The AppKit N-API callback did not emit one raw JSON string argument."
          ));
          return;
        }
        const event = JSON.parse(eventJson);
        events.push(event);
        resolveFirstEvent(event);
        for (const waiter of nativeEventWaiters) {
          if (!waiter.matches(event)) continue;
          nativeEventWaiters.delete(waiter);
          waiter.resolve(event);
        }
      }
    );
    const layout = nativeHost.snapshotContentLayout(identity);
    if (!layout.valid || layout.heightInset < layout.yOffset) {
      throw new Error("The AppKit content-layout projection is invalid.");
    }
    const projectedTabs = [
      { tabId: "appkit-probe-tab-a", name: "AppKit Probe A", phase: "activating", tabType: "role" },
      { tabId: "appkit-probe-tab-b", name: "AppKit Probe B", phase: "ready", tabType: "role" }
    ];
    const projectionReceipt = nativeHost.applyTabProjection(
      identity,
      "1",
      projectedTabs,
      "appkit-probe-tab-a"
    );
    if (projectionReceipt.projectionRevision !== "1" ||
        projectionReceipt.tabCount !== 2 ||
        projectionReceipt.activeTabId !== "appkit-probe-tab-a") {
      throw new Error("The AppKit tab projection returned mismatched native evidence.");
    }
    if (desktopE2eBuild &&
        nativeHost.desktopE2eStatusPresentation(identity) !== 1) {
      throw new Error("The AppKit activating phase did not expose native loading status.");
    }
    const readyProjection = nativeHost.applyTabProjection(
      identity,
      "2",
      [{ ...projectedTabs[0], phase: "ready" }, projectedTabs[1]],
      "appkit-probe-tab-a"
    );
    if (readyProjection.projectionRevision !== "2" ||
        (desktopE2eBuild &&
          nativeHost.desktopE2eStatusPresentation(identity) !== 0)) {
      throw new Error("The AppKit ready phase did not clear native loading status.");
    }
    let staleProjectionRejected = false;
    try {
      nativeHost.applyTabProjection(
        identity,
        "2",
        [{ ...projectedTabs[0], phase: "failed" }, projectedTabs[1]],
        "appkit-probe-tab-a"
      );
    } catch {
      staleProjectionRejected = true;
    }
    if (!staleProjectionRejected) {
      throw new Error("The AppKit adapter accepted a same-revision phase conflict.");
    }
    let staleIdentityRejected = false;
    try {
      nativeHost.snapshotContentLayout({ ...identity, nativeGeneration: 2 });
    } catch {
      staleIdentityRejected = true;
    }
    if (!staleIdentityRejected) {
      throw new Error("The AppKit adapter accepted a stale native generation.");
    }
    const callbackEvent = await withDiagnosticDeadline(firstEvent, "the first AppKit callback");
    if (callbackEvent.type !== "layout" || !exactIdentity(callbackEvent, identity)) {
      throw new Error("The AppKit callback did not retain exact native identity.");
    }

    let nativeEvidence;
    if (desktopE2eBuild) {
      roleView = new WebContentsView({
        webPreferences: {
          contextIsolation: true,
          devTools: false,
          nodeIntegration: false,
          sandbox: true,
          webviewTag: false
        }
      });
      roleView.setBounds({
        x: 0,
        y: Math.ceil(layout.yOffset),
        width: 800,
        height: Math.max(1, 600 - Math.ceil(layout.heightInset))
      });
      window.contentView.addChildView(roleView);
      await roleView.webContents.loadURL(
        `data:text/html,${encodeURIComponent("<meta charset=utf-8><input id=probe autofocus>")}`
      );

      nativeHost.setWindowName(identity, "AppKit + Chromium Probe");
      nativeHost.setFullscreenPolicy(identity, true);
      nativeHost.setRevealLocked(identity, false);
      nativeHost.setTabCloseButtonsHidden(identity, false);
      const targetFocused = new Promise((resolve) => window.once("focus", resolve));
      window.show();
      window.focus();
      await withDiagnosticDeadline(targetFocused, "the AppKit target key-window event");
      roleView.webContents.focus();
      const activeElement = await roleView.webContents.executeJavaScript(
        "document.querySelector('#probe').focus(); document.activeElement?.id",
        true
      );
      if (activeElement !== "probe" || !roleView.webContents.isFocused()) {
        throw new Error("The embedded Chromium surface did not retain its input focus.");
      }

      const accessibilityHierarchy = await inspectMacosAccessibilityTabs(
        process.pid,
        projectedTabs.map((tab) => tab.name)
      );
      if (accessibilityHierarchy.radioCount !== projectedTabs.length ||
          accessibilityHierarchy.matchingRadioCount !== projectedTabs.length ||
          accessibilityHierarchy.tabGroupCount < 1) {
        throw new Error(
          `The retained AppKit tabs are absent from the process AX hierarchy: ${JSON.stringify(accessibilityHierarchy)}.`
        );
      }

      const titlebarGeometry = await waitForDiagnosticSnapshot(
        () => nativeHost.desktopE2eTitlebarGeometry(identity),
        titlebarFitsNativeWindow,
        "native titlebar/tab/traffic-light geometry"
      );
      const closeButtonsEnabled = await waitForDiagnosticSnapshot(
        () => nativeHost.desktopE2eFullscreenToolbarState(identity),
        (state) => state.valid && !state.alwaysHideTabCloseButton &&
          state.tabCloseButtonEnabledCount === 2,
        "native tab close-button enablement"
      );

      controlWindow = new BaseWindow({
        width: 320,
        height: 200,
        frame: true,
        show: false,
        useContentSize: true
      });
      const controlFocused = new Promise((resolve) => controlWindow.once("focus", resolve));
      controlWindow.show();
      controlWindow.focus();
      await withDiagnosticDeadline(controlFocused, "the control key-window event");
      if (window.isFocused() || roleView.webContents.isFocused() || !controlWindow.isFocused()) {
        throw new Error("The AppKit target did not enter the exact background focus state.");
      }
      const backgroundFocusBefore = {
        controlWindow: controlWindow.isFocused(),
        chromiumSurface: roleView.webContents.isFocused(),
        targetWindow: window.isFocused()
      };

      const runAccessibilityAction = async (invoke, actionType, tabId) => {
        let resolveEvent;
        const eventPromise = new Promise((resolve) => { resolveEvent = resolve; });
        const waiter = {
          matches: (event) => exactIdentity(event, identity) &&
            event.type === "action" && event.action?.type === actionType &&
            event.action.tabId === tabId &&
            event.action.sourceWindowId === identity.logicalWindowId,
          resolve: resolveEvent
        };
        nativeEventWaiters.add(waiter);
        try {
          if (!invoke()) {
            throw new Error(`AppKit rejected accessibility ${actionType} for ${tabId}.`);
          }
          return await withDiagnosticDeadline(
            eventPromise,
            `the exact ${actionType}/${tabId} AppKit action`
          );
        } finally {
          nativeEventWaiters.delete(waiter);
        }
      };
      const accessibilityPressEvent = await runAccessibilityAction(
        () => nativeHost.desktopE2eAccessibilityPress(identity, "appkit-probe-tab-b"),
        "activate",
        "appkit-probe-tab-b"
      );
      const accessibilityShowMenuEvent = await runAccessibilityAction(
        () => nativeHost.desktopE2eAccessibilityShowMenu(
          identity,
          "appkit-probe-tab-b"
        ),
        "openTabMenu",
        "appkit-probe-tab-b"
      );
      const accessibilityCloseEvent = await runAccessibilityAction(
        () => nativeHost.desktopE2eAccessibilityClose(identity, "appkit-probe-tab-b"),
        "stop",
        "appkit-probe-tab-b"
      );
      if (accessibilityCloseEvent.action.sourceWindowId !== identity.logicalWindowId ||
          JSON.stringify(accessibilityCloseEvent.action.orderedTabIds) !==
            JSON.stringify(["appkit-probe-tab-a"])) {
        throw new Error("The AppKit close action lost exact tab/window/order identity.");
      }
      const backgroundFocusAfter = {
        controlWindow: controlWindow.isFocused(),
        chromiumSurface: roleView.webContents.isFocused(),
        targetWindow: window.isFocused()
      };
      const chromiumFocusAfter = await roleView.webContents.executeJavaScript(
        "({ activeElementId: document.activeElement?.id ?? null, hasFocus: document.hasFocus() })",
        true
      );
      if (JSON.stringify(backgroundFocusAfter) !== JSON.stringify(backgroundFocusBefore) ||
          chromiumFocusAfter.activeElementId !== "probe" || chromiumFocusAfter.hasFocus) {
        throw new Error("A background AppKit accessibility action changed key/Chromium focus.");
      }
      const singleRoleProjection = nativeHost.applyTabProjection(
        identity,
        "3",
        [{ ...projectedTabs[0], phase: "ready" }],
        "appkit-probe-tab-a"
      );
      const popupTab = {
        tabId: "appkit-probe-popup",
        name: "Controlled Popup",
        phase: "ready",
        tabType: "popup"
      };
      const popupProjection = nativeHost.applyTabProjection(
        identity,
        "4",
        [popupTab],
        popupTab.tabId
      );
      const popupAccessibilityPressEvent = await runAccessibilityAction(
        () => nativeHost.desktopE2eAccessibilityPress(identity, popupTab.tabId),
        "activate",
        popupTab.tabId
      );
      const popupAccessibilityCloseEvent = await runAccessibilityAction(
        () => nativeHost.desktopE2eAccessibilityClose(identity, popupTab.tabId),
        "stop",
        popupTab.tabId
      );
      if (JSON.stringify(popupAccessibilityCloseEvent.action.orderedTabIds) !== "[]") {
        throw new Error("The AppKit popup close action retained a foreign tab owner.");
      }
      const reconciledProjection = nativeHost.applyTabProjection(
        identity,
        "5",
        [{ ...projectedTabs[0], phase: "ready" }],
        "appkit-probe-tab-a"
      );
      nativeHost.setTabCloseButtonsHidden(identity, true);
      const closeButtonsHidden = await waitForDiagnosticSnapshot(
        () => nativeHost.desktopE2eFullscreenToolbarState(identity),
        (state) => state.valid && state.alwaysHideTabCloseButton &&
          state.tabCloseButtonEnabledCount === 0,
        "native tab close-button hiding"
      );

      const controlClosed = new Promise((resolve) => controlWindow.once("closed", resolve));
      controlWindow.close();
      await withDiagnosticDeadline(controlClosed, "the control-window close event");
      controlWindow = undefined;
      const refocused = new Promise((resolve) => window.once("focus", resolve));
      window.focus();
      await withDiagnosticDeadline(refocused, "the target refocus event");
      roleView.webContents.focus();

      nativeHost.prepareFullscreen(identity, true);
      const enteredFullscreen = new Promise((resolve) =>
        window.once("enter-full-screen", resolve)
      );
      window.setFullScreen(true);
      await withDiagnosticDeadline(enteredFullscreen, "Electron enter-full-screen");
      if (!window.isFullScreen()) {
        throw new Error("Electron reported fullscreen entry without fullscreen state.");
      }
      const fullscreenEntered = await waitForDiagnosticSnapshot(
        () => nativeHost.desktopE2eFullscreenToolbarState(identity),
        fullscreenToolbarEntered,
        "the retained AppKit fullscreen toolbar entry state"
      );

      const leftFullscreen = new Promise((resolve) =>
        window.once("leave-full-screen", resolve)
      );
      window.setFullScreen(false);
      await withDiagnosticDeadline(leftFullscreen, "Electron leave-full-screen");
      nativeHost.prepareFullscreen(identity, false);
      if (window.isFullScreen()) {
        throw new Error("Electron reported fullscreen exit while still fullscreen.");
      }
      const fullscreenExited = await waitForDiagnosticSnapshot(
        () => nativeHost.desktopE2eFullscreenToolbarState(identity),
        fullscreenToolbarExited,
        "the retained AppKit fullscreen toolbar exit state"
      );
      const titlebarAfterFullscreen = await waitForDiagnosticSnapshot(
        () => nativeHost.desktopE2eTitlebarGeometry(identity),
        titlebarFitsNativeWindow,
        "post-fullscreen native titlebar geometry"
      );
      nativeEvidence = {
        accessibilityHierarchy,
        accessibilityCloseEvent,
        accessibilityPressEvent,
        accessibilityShowMenuEvent,
        backgroundFocusAfter,
        backgroundFocusBefore,
        chromiumFocusAfter,
        closeButtonsEnabled,
        closeButtonsHidden,
        fullscreenEntered,
        fullscreenExited,
        popupAccessibilityCloseEvent,
        popupAccessibilityPressEvent,
        popupProjection,
        reconciledProjection,
        singleRoleProjection,
        titlebarAfterFullscreen,
        titlebarGeometry
      };
    }

    if (!nativeHost.destroy(identity)) {
      throw new Error("The exact AppKit controller did not detach.");
    }
    if (nativeHost.destroy(identity)) {
      throw new Error("A duplicate AppKit controller destroy was not idempotent.");
    }
    nativeHost = undefined;
    if (roleView) {
      window.contentView.removeChildView(roleView);
      roleView.webContents.close();
      roleView = undefined;
    }
    const closed = new Promise((resolve) => window.once("closed", resolve));
    window.close();
    await withDiagnosticDeadline(closed, "the AppKit target-window close event");
    window = undefined;
    writeSync(1, `${PROBE_PREFIX}${JSON.stringify({
      abiVersion: addon.appKitRuntimeAbiVersion(),
      callbackEventCount: events.length,
      chrome: process.versions.chrome,
      desktopE2eBuild,
      desktopE2eMethods,
      electron: process.versions.electron,
      evidenceScope: desktopE2eBuild
        ? "standalone-native-appkit-chromium-adapter"
        : "production-addon-e2e-surface-absence",
      layout,
      malformedHandleRejected,
      nativeEvidence,
      nativeHandleBytes: nativeHandle.byteLength,
      platform: process.platform,
      projectionReceipt,
      staleIdentityRejected,
      staleProjectionRejected
    })}\n`);
    app.exit(0);
  } catch (error) {
    try {
      nativeHost?.destroy(identity);
      if (roleView && window && !window.isDestroyed()) {
        window.contentView.removeChildView(roleView);
        roleView.webContents.close();
      }
      if (controlWindow && !controlWindow.isDestroyed()) controlWindow.close();
      if (window && !window.isDestroyed()) window.close();
    } catch {
      // Preserve the original probe failure without crossing another native boundary.
    }
    writeSync(2, `${error instanceof Error ? error.stack : String(error)}\n`);
    app.exit(1);
  }
})();
