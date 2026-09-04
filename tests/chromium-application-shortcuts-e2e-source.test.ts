import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, it } from "vitest";

let bridge = "";
let cleanExitDiagnostics = "";
let coreFlowDiagnostics = "";
let e2eMain = "";
let manifest = "";
let macroSupport = "";
let nativeApplicationActions = "";
let nativeWindowControlObserver = "";
let productionMain = "";
let productionPreload = "";
let roleSurfaceLifecycleObserver = "";
let shellSpec = "";
let wdioConfig = "";

beforeAll(async () => {
  [bridge, cleanExitDiagnostics, coreFlowDiagnostics, e2eMain, manifest, macroSupport,
    nativeApplicationActions, nativeWindowControlObserver, productionMain,
    productionPreload, roleSurfaceLifecycleObserver, shellSpec, wdioConfig] =
    await Promise.all([
      readFile("src/electron/e2e/desktopE2eBridge.ts", "utf8"),
      readFile("src/electron/e2e/cleanExitDiagnosticsObserver.ts", "utf8"),
      readFile("src/electron/e2e/coreFlowDiagnosticsObserver.ts", "utf8"),
      readFile("src/electron/e2e/index.ts", "utf8"),
      readFile("docs/e2e-coverage.json", "utf8"),
      readFile("e2e/desktop/specs/chromium-macro-cutover-support.ts", "utf8"),
      readFile("e2e/desktop/support/native-application-actions.ts", "utf8"),
      readFile("src/electron/e2e/nativeWindowControlObserver.ts", "utf8"),
      readFile("src/electron/main/index.ts", "utf8"),
      readFile("src/electron/preload/index.ts", "utf8"),
      readFile("src/electron/e2e/roleSurfaceLifecycleObserver.ts", "utf8"),
      readFile("e2e/desktop/specs/chromium-shell.e2e.ts", "utf8"),
      readFile("e2e/desktop/wdio.electron.conf.ts", "utf8")
    ]);
});

describe("Chromium application-shortcut E2E journey", () => {
  it("uses visible Quick Access and exact focused-runtime OS input", () => {
    expect(shellSpec).toContain("launchChromiumRoleVisible");
    expect(shellSpec).toContain('rendererCall("getEmbeddedRuntimeState")');
    expect(shellSpec).toContain("empty.coreTabIds.length === 0");
    expect(shellSpec).not.toContain(
      '(await rendererCall("listGameWindows"))\n      .filter'
    );
    expect(shellSpec).toContain('targetMode: "focused-runtime"');
    expect(shellSpec).toContain("focusVisibleMacosAppKitRuntime");
    expect(nativeApplicationActions).toContain(
      "focusedWindowIdentifier is expectedWindowIdentifier"
    );
    expect(nativeApplicationActions).toContain(
      "mainWindowIdentifier is expectedWindowIdentifier"
    );
    expect(nativeApplicationActions).not.toContain(
      "focusedWindow is targetWindow"
    );
    expect(nativeApplicationActions).toContain(
      "launcherWindowCount is greater than 1"
    );
    expect(nativeApplicationActions).toContain(
      "mainWindowIdentifier is not focusedWindowIdentifier"
    );
    expect(nativeApplicationActions).toContain(
      "runtimeTabWindowIdentifier is not focusedWindowIdentifier"
    );
    expect(nativeApplicationActions).not.toContain(
      "mainWindow is not focusedWindow"
    );
    expect(shellSpec).toContain("electronDesktopE2eApplicationShortcutRuntime");
    expect(shellSpec).toContain(
      "electronDesktopE2eArmApplicationShortcutFullscreenExit"
    );
    expect(shellSpec).toContain("waitForTerminalMacosFullscreenExit");
    expect(shellSpec).toContain("RION_STUDIO_E2E_TERMINAL_NATIVE_QUIT");
    expect(shellSpec).not.toContain('rendererCall("getCurrentWindowState")');
    expect(shellSpec).not.toContain("devicePixelRatio");
    expect(macroSupport).toContain("chromiumRoleLaunchDiagnostic");
    expect(macroSupport).toContain("electronDesktopE2eRolePlaceholderRuntime");
    expect(macroSupport).toContain("projectionOutcome");
    expect(e2eMain).toContain(
      "installElectronDesktopE2eRoleSurfaceLifecycleObserver(app, artifactDirectory)"
    );
    expect(e2eMain).toContain(
      "installElectronDesktopE2eNativeAttachmentLifecycleObserver("
    );
    expect(e2eMain).toContain(
      "installElectronDesktopE2eNativeWindowControlObserver()"
    );
    expect(e2eMain).toContain(
      "installElectronDesktopE2eCleanExitDiagnosticsObserver()"
    );
    expect(cleanExitDiagnostics).toContain("cleanExitRuntimePrepare");
    expect(cleanExitDiagnostics).toContain("cleanExitRuntimeExecutor");
    expect(cleanExitDiagnostics).toContain("cleanExitRoleSurface");
    expect(cleanExitDiagnostics).toContain("cleanExitRoleSession");
    expect(cleanExitDiagnostics).toContain("cleanExitRolePlaceholders");
    expect(cleanExitDiagnostics).toContain("cleanExitCoreShutdown");
    expect(nativeWindowControlObserver).toContain("toggleFullscreenForTab");
    expect(nativeWindowControlObserver).toContain("readWindowsShortcutActiveTab");
    expect(nativeWindowControlObserver).toContain("runtimeFullscreenIngress");
    expect(coreFlowDiagnostics).toContain(
      'candidate.type === "layoutCreateDividers"'
    );
    expect(coreFlowDiagnostics).toContain(
      'candidate.type === "layoutResolve"'
    );
    expect(roleSurfaceLifecycleObserver).toContain('"did-start-navigation"');
    expect(roleSurfaceLifecycleObserver).toContain('"did-fail-provisional-load"');
    expect(roleSurfaceLifecycleObserver).toContain('"render-process-gone"');
    expect(roleSurfaceLifecycleObserver).toContain('"before-input-event"');
    expect(roleSurfaceLifecycleObserver).toContain("queueMicrotask");
    expect(roleSurfaceLifecycleObserver).toContain(
      "defaultPrevented: inputEvent.defaultPrevented"
    );
    expect(roleSurfaceLifecycleObserver).toContain(
      '"electron-role-surface-lifecycle-observations.json"'
    );
    expect(roleSurfaceLifecycleObserver).toContain(
      '"electron-windows-role-attachment-observations.json"'
    );
    expect(roleSurfaceLifecycleObserver).toContain('"attach-resolved"');
  });

  it("asserts exact receipts, stable native ownership, and an unchanged main window", () => {
    expect(shellSpec).toContain("expectExactZoomReceipt");
    expect(shellSpec).toContain("expectStableShortcutOwners");
    expect(shellSpec).toContain("expectLauncherMainWindowUnchanged");
    expect(shellSpec).toContain("expectExactSurfaceZoomFactors");
    expect(shellSpec).toContain(
      "expect(current.mainWindow.zoomFactor).toBe(initial.mainWindow.zoomFactor)"
    );
    expect(shellSpec).toContain("popupSurfaceCount: 0");
    expect(shellSpec).toContain("current.coreWindow.windowZoomFactor");
    expect(shellSpec).toContain("initial.nativeWindow.appKitIdentity");
  });

  it("keeps the read-only endpoint E2E-only under the existing paired journeys", () => {
    expect(bridge).toContain("applicationShortcutRuntime");
    expect(e2eMain).toContain("applicationShortcutRuntimeObserver.install()");
    expect(productionMain).not.toContain("applicationShortcutRuntime");
    expect(productionPreload).not.toContain("applicationShortcutRuntime");
    expect(manifest).toContain("CHROMIUM-MACOS-APPKIT-APPLICATION-SHORTCUTS-030");
    expect(manifest).toContain("CHROMIUM-WINDOWS-APPLICATION-SHORTCUTS-030");
    expect(wdioConfig).toContain("captureMainProcessLogs: true");
  });

  it("selects the launcher without entering hidden Chromium targets and closes event-bound", () => {
    expect(wdioConfig).toContain("await runnerBrowser.getPuppeteer()");
    expect(wdioConfig).toContain(
      'pageLoadStrategy: process.platform === "win32" ? "none" : "normal"'
    );
    expect(wdioConfig).toContain("webDriverHandles.has(handle)");
    expect(wdioConfig).toContain("target.url()");
    expect(wdioConfig).not.toContain("url: await browser.getUrl()");
    expect(wdioConfig).toContain("await requestElectronDesktopE2eClose()");
    expect(wdioConfig).toContain("beforeSession:");
    expect(wdioConfig).toContain(
      'overwriteStubCommand("deleteSession", async () => undefined)'
    );
    expect(wdioConfig).not.toContain("runnerBrowser.overwriteCommand(");
  });

  it("observes terminal phases without replacing immutable native hosts", () => {
    expect(e2eMain).toContain("ChromiumRuntimeEffectExecutor.prototype");
    expect(e2eMain).toContain("execute = async function (effect, context)");
    expect(e2eMain).toContain(
      "originalExecuteRuntimeEffect.call(this, effect, context)"
    );
    expect(e2eMain).toContain('action.type === "embeddedFollowRoleOwnership"');
    expect(e2eMain).toContain('action.type === "embeddedApplyAppKitProjection"');
    expect(e2eMain).not.toContain("Object.create(host)");
    expect(e2eMain).not.toContain("hostFactory.create =");
    expect(e2eMain).not.toContain("hostFactory.createEmpty =");
    expect(e2eMain).not.toContain("host.applyAppKitPhaseProjection =");
    expect(e2eMain).not.toContain("host.applyWindowsChromeProjection =");
  });
});
