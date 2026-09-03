import { $, browser, expect } from "@wdio/globals";

import type { AppSnapshot } from "../../../src/shared/types";
import {
  electronDesktopE2eApplicationShortcutRuntime,
  electronDesktopE2eGameWindowRuntime,
  electronDesktopE2eProbe,
  type ElectronDesktopE2eApplicationShortcutRuntimeInspection
} from "../support/electron-driver";
import {
  pressVisibleMacosApplicationShortcut,
  pressVisibleWindowsApplicationShortcut
} from
  "../support/native-application-actions";
import { rendererCall } from "../support/renderer-bridge";
import {
  bootstrapChromiumMacroCutover,
  launchChromiumRoleVisible,
  macroFixtureUrl
} from "./chromium-macro-cutover-support";

// [journey:CHROMIUM-MACOS-APPKIT-SHELL-001]
// [journey:CHROMIUM-WINDOWS-SHELL-001]
// [journey:CHROMIUM-MACOS-APPKIT-APPLICATION-SHORTCUTS-030]
// [journey:CHROMIUM-WINDOWS-APPLICATION-SHORTCUTS-030]

interface ChromiumShellProbe {
  gestureMode?: string;
  hasBridge: boolean;
  nodeProcessType: string;
  nodeRequireType: string;
  snapshot: AppSnapshot;
  userAgent: string;
}

type ApplicationShortcutCommand =
  | "newGameWindow"
  | "toggleFullscreen"
  | "zoomIn"
  | "zoomReset";

type ChromiumShellPlatform = "macos" | "windows";

const SHORTCUT_FIXTURE_ID = "chromium-application-shortcuts";
const SHORTCUT_GAME_NAME = "Chromium Application Shortcut Game";
const SHORTCUT_ROLE_NAME = "Chromium Application Shortcut Role";

function runtimeTarget(): string {
  const value = process.env.RION_STUDIO_E2E_RUNTIME_TARGET;
  if (!value) throw new Error("RION_STUDIO_E2E_RUNTIME_TARGET is required");
  return value;
}

async function pressApplicationShortcut(input: Readonly<{
  command: ApplicationShortcutCommand;
  platform: ChromiumShellPlatform;
  processId: number;
  runtimeTabName?: string;
  targetMode?: "focused-runtime";
}>): Promise<void> {
  const nativeInput = {
    command: input.command,
    processId: input.processId,
    ...(input.runtimeTabName ? { runtimeTabName: input.runtimeTabName } : {}),
    ...(input.targetMode ? { targetMode: input.targetMode } : {})
  };
  if (input.platform === "macos") {
    await pressVisibleMacosApplicationShortcut(nativeInput);
  } else {
    await pressVisibleWindowsApplicationShortcut(nativeInput);
  }
}

async function waitApplicationShortcutRuntime(
  windowId: string,
  predicate: (
    inspection: ElectronDesktopE2eApplicationShortcutRuntimeInspection
  ) => boolean,
  timeoutMsg: string
): Promise<ElectronDesktopE2eApplicationShortcutRuntimeInspection> {
  let inspection: ElectronDesktopE2eApplicationShortcutRuntimeInspection | undefined;
  await browser.waitUntil(async () => {
    try {
      const candidate = await electronDesktopE2eApplicationShortcutRuntime(windowId);
      if (!predicate(candidate)) return false;
      inspection = candidate;
      return true;
    } catch {
      return false;
    }
  }, { timeout: 20_000, timeoutMsg });
  if (!inspection) throw new Error(timeoutMsg);
  return inspection;
}

function expectStableShortcutOwners(
  current: ElectronDesktopE2eApplicationShortcutRuntimeInspection,
  initial: ElectronDesktopE2eApplicationShortcutRuntimeInspection,
  platform: ChromiumShellPlatform
): void {
  expect(current.nativeWindow).toEqual(expect.objectContaining({
    activeTabId: initial.nativeWindow.activeTabId,
    appKitIdentity: initial.nativeWindow.appKitIdentity,
    focused: true,
    hostKind: initial.nativeWindow.hostKind,
    parentNativeHostId: initial.nativeWindow.parentNativeHostId,
    tabIds: initial.nativeWindow.tabIds,
    visible: true,
    windowGeneration: initial.nativeWindow.windowGeneration,
    windowId: initial.windowId
  }));
  expect(current.roleSurfaces.map((surface) => ({
    baseZoomFactor: surface.baseZoomFactor,
    generation: surface.generation,
    roleId: surface.roleId,
    tabId: surface.tabId
  }))).toEqual(initial.roleSurfaces.map((surface) => ({
    baseZoomFactor: surface.baseZoomFactor,
    generation: surface.generation,
    roleId: surface.roleId,
    tabId: surface.tabId
  })));
  expect(current.roleSurfaces[0]?.visible).toBe(true);
  if (platform === "macos") {
    expect(current.nativeWindow.hostKind).toBe("appkit-chromium");
    expect(current.nativeWindow.appKitIdentity).toEqual(
      initial.nativeWindow.appKitIdentity
    );
  } else {
    expect(current.nativeWindow.hostKind).toBe("bundled-chromium");
    expect(current.nativeWindow.appKitIdentity).toBeNull();
  }
}

function expectLauncherMainWindowUnchanged(
  current: ElectronDesktopE2eApplicationShortcutRuntimeInspection,
  initial: ElectronDesktopE2eApplicationShortcutRuntimeInspection
): void {
  expect(current.mainWindow.browserWindowId).toBe(initial.mainWindow.browserWindowId);
  expect(current.mainWindow.webContentsId).toBe(initial.mainWindow.webContentsId);
  expect(current.mainWindow.zoomFactor).toBe(initial.mainWindow.zoomFactor);
  expect(current.mainWindow.fullscreen).toBe(initial.mainWindow.fullscreen);
}

function expectExactSurfaceZoomFactors(
  runtime: ElectronDesktopE2eApplicationShortcutRuntimeInspection
): void {
  const expected = (baseZoomFactor: number) => Math.min(
    5,
    Math.max(0.25, baseZoomFactor * runtime.nativeWindow.windowZoomFactor)
  );
  for (const surface of runtime.roleSurfaces) {
    expect(surface.appliedZoomFactor).toBe(expected(surface.baseZoomFactor));
  }
  for (const surface of runtime.globalWebSurfaces) {
    expect(surface.appliedZoomFactor).toBe(expected(surface.baseZoomFactor));
  }
}

function expectExactZoomReceipt(
  before: ElectronDesktopE2eApplicationShortcutRuntimeInspection,
  current: ElectronDesktopE2eApplicationShortcutRuntimeInspection,
  action: "in" | "reset",
  priorSequence: number
): void {
  const observation = current.zoomJournal.observations.at(-1);
  if (!observation) throw new Error(`The ${action} shortcut has no Core receipt`);
  expect(observation.sequence).toBe(priorSequence + 1);
  expect(observation.receipt).toEqual(expect.objectContaining({
    action,
    globalWebSurfaceCount: current.globalWebSurfaces.length,
    nextZoomFactor: current.nativeWindow.windowZoomFactor,
    popupSurfaceCount: 0,
    previousZoomFactor: before.nativeWindow.windowZoomFactor,
    roleSurfaceCount: current.roleSurfaces.length,
    sourceTopologyRevision: before.nativeWindow.topologyRevision,
    status: "applied",
    topologyRevision: current.nativeWindow.topologyRevision,
    windowGeneration: current.nativeWindow.windowGeneration,
    windowId: current.windowId
  }));
  expect(observation.receipt.failureCode).toBeUndefined();
  expect(current.coreWindow.windowZoomFactor)
    .toBe(observation.receipt.nextZoomFactor);
  expect(current.popupSurfaces).toEqual([]);
}

async function createFocusedApplicationShortcutRuntime(input: Readonly<{
  platform: ChromiumShellPlatform;
  processId: number;
}>): Promise<Readonly<{
  windowId: string;
  initial: ElectronDesktopE2eApplicationShortcutRuntimeInspection;
}>> {
  const context = await bootstrapChromiumMacroCutover();
  expect(context.platform).toBe(input.platform);
  const launchUrl = macroFixtureUrl(SHORTCUT_FIXTURE_ID);
  const game = await rendererCall("createGame", {
    defaultLaunchUrl: launchUrl,
    name: SHORTCUT_GAME_NAME
  });
  const role = await rendererCall("createRole", {
    gameId: game.id,
    launchUrl,
    name: SHORTCUT_ROLE_NAME
  });
  const persistedWindowIds = (await rendererCall("listGameWindows"))
    .map((window) => window.id);
  const beforeWindowIds = new Set(
    (await rendererCall("getEmbeddedRuntimeState")).windows
      .map((window) => window.windowId)
  );
  await pressApplicationShortcut({
    command: "newGameWindow",
    platform: input.platform,
    processId: input.processId
  });
  let windowId: string | undefined;
  await browser.waitUntil(async () => {
    const created = (await rendererCall("getEmbeddedRuntimeState")).windows
      .filter((window) => !beforeWindowIds.has(window.windowId));
    if (created.length > 1) {
      throw new Error("The native New Window shortcut created multiple Game Windows");
    }
    const createdWindow = created[0];
    if (!createdWindow) return false;
    windowId = createdWindow.windowId;
    try {
      const empty = (await electronDesktopE2eGameWindowRuntime(windowId))
        .currentRuntime;
      return createdWindow.id === windowId && createdWindow.visible &&
        createdWindow.tabCount === 0 && createdWindow.activeTabId === undefined &&
        empty?.windowId === windowId && empty.visible &&
        empty.coreTabIds.length === 0 && empty.nativeTabIds.length === 0;
    } catch {
      return false;
    }
  }, {
    timeout: 20_000,
    timeoutMsg: "The native New Window shortcut did not create one exact empty Game Window"
  });
  if (!windowId) throw new Error("The native New Window Game Window is unavailable");
  expect((await rendererCall("listGameWindows")).map((window) => window.id))
    .toEqual(persistedWindowIds);
  const launched = await launchChromiumRoleVisible(
    role,
    SHORTCUT_FIXTURE_ID,
    { id: windowId }
  );
  expect(launched.windowId).toBe(windowId);
  const initial = await waitApplicationShortcutRuntime(
    windowId,
    (runtime) => runtime.nativeWindow.focused && runtime.nativeWindow.visible &&
      runtime.nativeWindow.activeTabId === launched.tabId &&
      runtime.roleSurfaces.length === 1 && runtime.roleSurfaces[0]?.roleId === role.id &&
      runtime.roleSurfaces[0].visible,
    "Visible Quick Access did not focus the exact populated runtime Game Window"
  );
  expect(initial.coreWindow.windowZoomFactor).toBe(1);
  expect(initial.nativeWindow.windowZoomFactor).toBe(1);
  expect(initial.mainWindow).toEqual(expect.objectContaining({
    fullscreen: false,
    zoomFactor: 1
  }));
  expect(initial.globalWebSurfaces).toEqual([]);
  expect(initial.popupSurfaces).toEqual([]);
  expect(initial.zoomJournal.observations).toEqual([]);
  if (input.platform === "macos") {
    expect(initial.nativeWindow.hostKind).toBe("appkit-chromium");
    expect(initial.nativeWindow.appKitIdentity).toEqual(expect.objectContaining({
      logicalWindowId: windowId,
      nativeGeneration: expect.any(Number)
    }));
  } else {
    expect(initial.nativeWindow.hostKind).toBe("bundled-chromium");
    expect(initial.nativeWindow.appKitIdentity).toBeNull();
  }
  expectExactSurfaceZoomFactors(initial);
  return { windowId, initial };
}

async function verifyFocusedApplicationShortcuts(input: Readonly<{
  platform: ChromiumShellPlatform;
  processId: number;
}>): Promise<void> {
  const { windowId, initial } = await createFocusedApplicationShortcutRuntime(input);
  const initialSequence = initial.zoomJournal.observations.at(-1)?.sequence ?? 0;
  await pressApplicationShortcut({
    ...input,
    command: "zoomIn",
    runtimeTabName: SHORTCUT_ROLE_NAME,
    targetMode: "focused-runtime"
  });
  const zoomed = await waitApplicationShortcutRuntime(
    windowId,
    (runtime) => runtime.zoomJournal.observations.at(-1)?.sequence ===
        initialSequence + 1 &&
      runtime.nativeWindow.windowZoomFactor > initial.nativeWindow.windowZoomFactor,
    "The focused native zoom-in shortcut did not produce an exact Core receipt"
  );
  expectStableShortcutOwners(zoomed, initial, input.platform);
  expectLauncherMainWindowUnchanged(zoomed, initial);
  expectExactSurfaceZoomFactors(zoomed);
  expectExactZoomReceipt(initial, zoomed, "in", initialSequence);

  const zoomedSequence = zoomed.zoomJournal.observations.at(-1)!.sequence;
  await pressApplicationShortcut({
    ...input,
    command: "zoomReset",
    runtimeTabName: SHORTCUT_ROLE_NAME,
    targetMode: "focused-runtime"
  });
  const reset = await waitApplicationShortcutRuntime(
    windowId,
    (runtime) => runtime.zoomJournal.observations.at(-1)?.sequence ===
        zoomedSequence + 1 && runtime.nativeWindow.windowZoomFactor === 1,
    "The focused native zoom-reset shortcut did not restore the exact runtime factor"
  );
  expectStableShortcutOwners(reset, initial, input.platform);
  expectLauncherMainWindowUnchanged(reset, initial);
  expectExactSurfaceZoomFactors(reset);
  expectExactZoomReceipt(zoomed, reset, "reset", zoomedSequence);

  const resetSequence = reset.zoomJournal.observations.at(-1)!.sequence;
  await pressApplicationShortcut({
    ...input,
    command: "toggleFullscreen",
    runtimeTabName: SHORTCUT_ROLE_NAME,
    targetMode: "focused-runtime"
  });
  const fullscreen = await waitApplicationShortcutRuntime(
    windowId,
    (runtime) => runtime.nativeWindow.presentation === "fullscreen" &&
      runtime.coreWindow.presentation === "fullscreen" &&
      runtime.nativeWindow.focused && runtime.nativeWindow.visible,
    "The focused native fullscreen shortcut did not reach the exact runtime host"
  );
  expectStableShortcutOwners(fullscreen, initial, input.platform);
  expectLauncherMainWindowUnchanged(fullscreen, initial);
  expectExactSurfaceZoomFactors(fullscreen);
  expect(fullscreen.zoomJournal.observations.at(-1)?.sequence).toBe(resetSequence);

  await pressApplicationShortcut({
    ...input,
    command: "toggleFullscreen",
    runtimeTabName: SHORTCUT_ROLE_NAME,
    targetMode: "focused-runtime"
  });
  const restored = await waitApplicationShortcutRuntime(
    windowId,
    (runtime) => runtime.nativeWindow.presentation === "normal" &&
      runtime.coreWindow.presentation === "normal" &&
      runtime.nativeWindow.focused && runtime.nativeWindow.visible,
    "The focused native fullscreen shortcut did not restore the exact runtime host"
  );
  expectStableShortcutOwners(restored, initial, input.platform);
  expectLauncherMainWindowUnchanged(restored, initial);
  expectExactSurfaceZoomFactors(restored);
  expect(restored.zoomJournal.observations.at(-1)?.sequence).toBe(resetSequence);
}

describe("Chromium desktop shell", () => {
  it("boots the isolated renderer and authoritative Rust bridge for its exact platform target", async () => {
    await browser.waitUntil(async () => browser.execute(() =>
      document.readyState === "complete" && typeof window.rionStudio?.getAppSnapshot === "function"
    ), {
      timeout: 45_000,
      timeoutMsg: "Electron Chromium renderer did not expose the Rion Studio preload bridge"
    });

    const snapshot = await rendererCall("getAppSnapshot");
    const probe = await browser.execute((authoritativeSnapshot) => ({
        gestureMode: document.documentElement.dataset.windowGestureMode,
        hasBridge: typeof window.rionStudio.getAppSnapshot === "function",
        nodeProcessType: typeof Reflect.get(globalThis, "process"),
        nodeRequireType: typeof Reflect.get(globalThis, "require"),
        snapshot: authoritativeSnapshot,
        userAgent: navigator.userAgent
      }), snapshot) as ChromiumShellProbe;

    expect(probe.hasBridge).toBe(true);
    expect(probe.userAgent).toMatch(/Electron\/\d+/u);
    expect(probe.userAgent).toMatch(/Chrome\/\d+/u);
    expect(probe.nodeProcessType).toBe("undefined");
    expect(probe.nodeRequireType).toBe("undefined");
    expect(Number.isSafeInteger(probe.snapshot.revision)).toBe(true);
    expect(Number.isSafeInteger(probe.snapshot.stateRevision)).toBe(true);
    expect(Number.isSafeInteger(probe.snapshot.runtimeRevision)).toBe(true);

    const target = runtimeTarget();
    if (target === "chromium-v23-macos-appkit") {
      expect(probe.gestureMode).toBe("native-non-client");
    } else if (target === "chromium-v23-windows") {
      expect(probe.gestureMode).toBe("native-non-client");
    } else {
      throw new Error(`Unexpected Chromium desktop E2E target ${target}`);
    }

    const root = await $("#root");
    await expect(root).toExist();
    const desktop = await electronDesktopE2eProbe();
    await verifyFocusedApplicationShortcuts({
      platform: desktop.platform,
      processId: desktop.processId
    });
  });
});
