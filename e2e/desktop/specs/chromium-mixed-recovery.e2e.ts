// [state-combination:CHROMIUM-MACOS-APPKIT-MIXED-TOPOLOGY-RECOVERY]
// [state-combination:CHROMIUM-WINDOWS-MIXED-TOPOLOGY-RECOVERY]
import { clickWorkspaceSlot } from "../support/ui";
import { $, browser, expect } from "@wdio/globals";
import type {} from "@wdio/electron-service";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { Game, GameWindow, LaunchWorkspace, Role } from "../../../src/shared/types";
import {
  electronDesktopE2eGameWindowRuntime,
  electronDesktopE2eFullscreenToolbarRuntime,
  electronDesktopE2eProbe,
  electronDesktopE2eRoleSessionRuntime,
  electronDesktopE2eWorkspaceWebRuntime
} from "../support/electron-driver";
import { navigateVisibleElectronWorkspaceWebChrome, withRolePageTarget } from
  "../support/electron-role-surface";
import { fixtureCursor, waitFixtureEvent } from "../support/fixture";
import { clickVisibleRuntimeTab, clickVisibleRuntimeWindowControl } from "../support/native-runtime-tabs";
import { focusVisibleMacosAppKitRuntime } from "../support/native-application-actions";
import { forceTerminateProcessTree } from "../support/process";
import { rendererCall } from "../support/renderer-bridge";
import { runtimeEffectCursor, waitForRestoreSavedGameWindowCompletion,
  waitForRestoreSessionTerminal, waitForSavedWindowRestoreCompletion } from
  "../support/terminal-cleanup-evidence";
import {
  acceptLegalAndSkipFirstRun,
  clickWorkspaceCreateAction,
  ensureEnglishUi,
  navigate,
  setEditorName,
  submitEditor,
  waitForRoute
} from "../support/ui";

// [journey:CHROMIUM-MACOS-APPKIT-MIXED-RECOVERY-021]
// [journey:CHROMIUM-WINDOWS-MIXED-RECOVERY-021]

const GAME_NAME = "Chromium Mixed Recovery Game";
const ROLE_TAB_NAME = "Chromium Mixed Recovery Role tab";
const ROLE_WORKSPACE_NAME = "Chromium Mixed Recovery Workspace role";
const WORKSPACE_NAME = "Chromium Mixed Recovery Workspace";
const WINDOW_NAME = "Chromium Mixed Recovery Window";
const ROLE_TAB_FIXTURE = "chromium-mixed-recovery-role-tab";
const ROLE_WORKSPACE_FIXTURE = "chromium-mixed-recovery-role-workspace";
const WEB_FIXTURE = "chromium-mixed-recovery-web";
const MARKERS = {
  roleTab: "chromium-mixed-recovery-role-tab-marker",
  roleWorkspace: "chromium-mixed-recovery-role-workspace-marker",
  web: "chromium-mixed-recovery-web-marker"
} as const;

interface MixedRecoveryLifecycle {
  contractVersion: 1;
  platform: "macos" | "windows";
  placement: GameWindow["placement"];
  roleTab: { chromiumPathSha256: string; roleId: string; tabId: string };
  roleWorkspace: { chromiumPathSha256: string; roleId: string };
  web: { marker: string; slotId: string };
  windowId: string;
  workspace: { id: string; tabId: string;
    slots: Awaited<ReturnType<typeof electronDesktopE2eWorkspaceWebRuntime>>["coreSlots"] };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by mixed recovery`);
  return value;
}

function fixtureUrl(fixtureId: string, marker: string): string {
  const url = new URL(`/role/${fixtureId}`, required("RION_STUDIO_E2E_FIXTURE_ORIGIN"));
  url.searchParams.set("marker", marker);
  url.searchParams.set("mode", "seed");
  return url.href;
}

function lifecyclePath(): string {
  return resolve(dirname(required("RION_STUDIO_E2E_ARTIFACT_DIR")),
    "chromium-mixed-recovery-evidence.json");
}

async function openSection(label: string, route: string): Promise<void> {
  const sidebar = await $(".app-main-sidebar");
  await sidebar.waitForDisplayed({ timeout: 20_000 });
  const button = await sidebar.$(`button*=${label}`);
  await button.waitForClickable({ timeout: 10_000 });
  await button.click();
  await waitForRoute(route);
}

async function findEntity<Value extends { name: string }>(
  name: string,
  read: () => Promise<Value[]>
): Promise<Value> {
  let entity: Value | undefined;
  await browser.waitUntil(async () => {
    entity = (await read()).find((candidate) => candidate.name === name);
    return entity !== undefined;
  }, { timeout: 15_000, timeoutMsg: `Missing persisted entity ${name}` });
  return entity!;
}

async function menuAction(entityId: string, triggerLabel: string, action: string): Promise<void> {
  const row = await $(`[data-selection-id='${entityId}']`);
  await row.waitForDisplayed({ timeout: 10_000 });
  await row.scrollIntoView({ block: "center", inline: "center" });
  await row.moveTo();
  const trigger = await row.$(`button[aria-label='${triggerLabel}']`);
  await trigger.waitForClickable({ timeout: 10_000 });
  await trigger.click();
  const item = await $(`//*[@role='menuitem' and normalize-space(.)='${action}']`);
  await item.waitForClickable({ timeout: 10_000 });
  await item.click();
}

async function createGameAndRoles(): Promise<readonly [Game, Role, Role]> {
  await openSection("Games", "/games");
  await $("button=New game").click();
  await waitForRoute("/games/new");
  await setEditorName(GAME_NAME);
  await $("#game-launch-url").setValue(fixtureUrl(ROLE_TAB_FIXTURE, MARKERS.roleTab));
  await submitEditor("/games");
  const game = await findEntity(GAME_NAME, () => rendererCall("listGames"));
  const roles: Role[] = [];
  for (const [name, fixture, marker] of [
    [ROLE_TAB_NAME, ROLE_TAB_FIXTURE, MARKERS.roleTab],
    [ROLE_WORKSPACE_NAME, ROLE_WORKSPACE_FIXTURE, MARKERS.roleWorkspace]
  ] as const) {
    await openSection("Games", "/games");
    await menuAction(game.id, "Game actions", "Add role");
    await waitForRoute(`/roles/new?gameId=${game.id}`);
    await setEditorName(name);
    await $("#role-launch-url").setValue(fixtureUrl(fixture, marker));
    await submitEditor("/roles");
    roles.push(await findEntity(name, () => rendererCall("listRoles")));
  }
  return [game, roles[0]!, roles[1]!];
}

async function createWorkspace(role: Role): Promise<LaunchWorkspace> {
  await openSection("Workspaces", "/workspaces");
  await clickWorkspaceCreateAction();
  await waitForRoute("/workspaces/new");
  await setEditorName(WORKSPACE_NAME);
  await $("#workspace-slot-content").click();
  await $("[role='option']=Website").click();
  await clickWorkspaceSlot(1);
  await $("#workspace-slot-content").click();
  await $("[role='option']=Role").click();
  await $(`[data-workspace-role-id='${role.id}']`).click();
  await submitEditor("/workspaces");
  return findEntity(WORKSPACE_NAME, () => rendererCall("listLaunchWorkspaces"));
}

async function createWindow(): Promise<GameWindow> {
  await openSection("Windows", "/game-windows");
  const prior = new Set((await rendererCall("listGameWindows")).map(({ id }) => id));
  await $("button=New game window").click();
  let created: GameWindow | undefined;
  await browser.waitUntil(async () => {
    created = (await rendererCall("listGameWindows")).find(({ id }) => !prior.has(id));
    return created !== undefined;
  }, { timeout: 15_000, timeoutMsg: "Visible Game Window creation did not commit" });
  await menuAction(created!.id, "Game window actions", "Rename");
  await $("#rename-game-window-name").setValue(WINDOW_NAME);
  await (await $("dialog[open]")).$("button=Save").click();
  return findEntity(WINDOW_NAME, () => rendererCall("listGameWindows"));
}

async function quickAccessLaunch(
  source: Role | LaunchWorkspace,
  kind: "role" | "workspace",
  windowId: string
): Promise<void> {
  await openSection("Home", "/dashboard");
  await $("[data-testid='quick-access-trigger']").click();
  const palette = await $("[data-testid='quick-access-palette'][open]");
  await palette.$("input[role='combobox']").setValue(source.name);
  await $(`#quick-access-option-${kind}-${source.id}`).waitForDisplayed({ timeout: 10_000 });
  const destinations = await $(`[data-testid='quick-access-destination-${kind}-${source.id}']`);
  await destinations.waitForClickable({ timeout: 10_000 });
  await destinations.click();
  const destination = await $(
    `[data-testid='quick-access-destination-option-window-${windowId}']`
  );
  await destination.waitForClickable({ timeout: 10_000 });
  await destination.click();
}

async function waitSession(
  afterSequence: number,
  roleId: string,
  marker: string,
  stored: boolean
): Promise<void> {
  const event = await waitFixtureEvent({ afterSequence, kind: "session", roleId });
  expect(event.session).toEqual({
    after: { cookie: marker, localStorage: marker },
    before: stored
      ? { cookie: marker, localStorage: marker }
      : { cookie: null, localStorage: null },
    marker,
    mode: "seed"
  });
}

async function activateTab(input: Readonly<{
  mainWindowHandle: string;
  name: string;
  platform: "macos" | "windows";
  tabId: string;
  windowId: string;
}>): Promise<void> {
  await clickVisibleRuntimeTab({
    mainWindowHandle: input.mainWindowHandle,
    platform: input.platform,
    tabId: input.tabId,
    tabName: input.name
  });
  await browser.waitUntil(async () => (await rendererCall("getEmbeddedRuntimeState"))
    .windows.find(({ id }) => id === input.windowId)?.activeTabId === input.tabId, {
    timeout: 30_000,
    timeoutMsg: `Visible native tab ${input.tabId} did not activate`
  });
}

async function waitForWorkspaceWebRuntime(windowId: string) {
  let inspection: Awaited<ReturnType<
    typeof electronDesktopE2eWorkspaceWebRuntime
  >> | undefined;
  await browser.waitUntil(async () => {
    try {
      inspection = await electronDesktopE2eWorkspaceWebRuntime(windowId);
      return inspection.phase === "ready" && inspection.visible && inspection.web.visible;
    } catch {
      return false;
    }
  }, {
    interval: 100,
    timeout: 45_000,
    timeoutMsg: "Mixed recovery Workspace Web did not reach authoritative ready"
  });
  return inspection!;
}

async function exactNative(lifecycle: MixedRecoveryLifecycle) {
  const [roleTab, roleWorkspace, web, gameWindow, toolbar] = await Promise.all([
    electronDesktopE2eRoleSessionRuntime(lifecycle.roleTab.roleId),
    electronDesktopE2eRoleSessionRuntime(lifecycle.roleWorkspace.roleId),
    waitForWorkspaceWebRuntime(lifecycle.windowId),
    electronDesktopE2eGameWindowRuntime(lifecycle.windowId),
    electronDesktopE2eFullscreenToolbarRuntime(lifecycle.windowId)
  ]);
  return { gameWindow, roleTab, roleWorkspace, web, toolbar };
}

async function writeRuntime(lifecycle: MixedRecoveryLifecycle): Promise<void> {
  let native: Awaited<ReturnType<typeof exactNative>> | undefined;
  let saved: GameWindow | undefined;
  let lastInspectionError: string | undefined;
  try {
    await browser.waitUntil(async () => {
      try {
        [native, saved] = await Promise.all([
          exactNative(lifecycle), findEntity(WINDOW_NAME, () => rendererCall("listGameWindows"))
        ]);
        return saved.placement.presentation === "maximized" &&
          native.gameWindow.currentRuntime?.nativeDisplay.presentation === "maximized" &&
          native.web.presentation === "maximized" && native.toolbar.presentation === "maximized";
      } catch (error) {
        lastInspectionError = error instanceof Error ? error.message : String(error);
        if (lastInspectionError.includes("has a stale Core/native Chromium fence:") ||
            lastInspectionError.includes("has stale preference, presentation, or native fences:") ||
            lastInspectionError.includes("has divergent Core/browser/native")) return false;
        throw error;
      }
    }, { timeout: 45_000, timeoutMsg: "Mixed recovery saved/native maximized placement did not agree" });
  } catch (error) {
    await writeFile(resolve(required("RION_STUDIO_E2E_ARTIFACT_DIR"), "mixed-placement-failure.json"),
      `${JSON.stringify({ lifecycle, native, saved, lastInspectionError }, null, 2)}\n`);
    throw error;
  }
  const mainWindowHandle = await browser.getWindowHandle();
  const readViewport = (url: string) => withRolePageTarget(url, mainWindowHandle,
    () => browser.executeAsync((done: (viewport: {
      width: number; height: number; visibility: string; renderFrames: number;
    }) => void) => {
      // Chromium can defer a hidden WebContents resize until its real native
      // tab becomes visible. Read the first completed render after activation,
      // without retrying document dimensions toward the expected native bounds.
      requestAnimationFrame(() => requestAnimationFrame(() => done({
        width: window.innerWidth, height: window.innerHeight,
        visibility: document.visibilityState, renderFrames: 2
      })));
    }));
  const roleTabVisibilityCursor = await fixtureCursor();
  await activateTab({ mainWindowHandle, name: ROLE_TAB_NAME, platform: lifecycle.platform,
    tabId: lifecycle.roleTab.tabId, windowId: lifecycle.windowId });
  const roleTabVisibility = await waitFixtureEvent({ afterSequence: roleTabVisibilityCursor,
    kind: "visibility", roleId: ROLE_TAB_FIXTURE });
  const roleTabToolbar = await electronDesktopE2eFullscreenToolbarRuntime(lifecycle.windowId);
  const roleTabRuntime = (await rendererCall("getEmbeddedRuntimeState"))
    .windows.find(({ id }) => id === lifecycle.windowId)!;
  const roleTabViewport = await readViewport(fixtureUrl(ROLE_TAB_FIXTURE, MARKERS.roleTab));

  const workspaceVisibilityCursor = await fixtureCursor();
  await activateTab({ mainWindowHandle, name: WORKSPACE_NAME, platform: lifecycle.platform,
    tabId: lifecycle.workspace.tabId, windowId: lifecycle.windowId });
  const [roleWorkspaceVisibility, webVisibility] = await Promise.all([
    waitFixtureEvent({ afterSequence: workspaceVisibilityCursor, kind: "visibility", roleId: ROLE_WORKSPACE_FIXTURE }),
    waitFixtureEvent({ afterSequence: workspaceVisibilityCursor, kind: "visibility", roleId: WEB_FIXTURE })
  ]);
  [native, saved] = await Promise.all([
    exactNative(lifecycle), findEntity(WINDOW_NAME, () => rendererCall("listGameWindows"))
  ]);
  const runtime = await rendererCall("getEmbeddedRuntimeState");
  const live = runtime.windows.find(({ id }) => id === lifecycle.windowId);
  const runtimeState = { activeTabId: live?.activeTabId, visible: live?.visible,
    projectionPending: Boolean(live?.projectionPending),
    restoreInProgressWindowIds: (runtime.savedWindows ?? [])
      .filter(({ state }) => state === "restoring").map(({ id }) => id) };
  const viewports = {
    roleTab: roleTabViewport,
    roleWorkspace: await readViewport(fixtureUrl(ROLE_WORKSPACE_FIXTURE, MARKERS.roleWorkspace)),
    web: await readViewport(native!.web.web.contentUrl)
  };
  const viewportActivation = {
    roleTab: { activeTabId: roleTabRuntime.activeTabId, afterSequence: roleTabVisibilityCursor,
      toolbar: roleTabToolbar, visibilityEvent: roleTabVisibility },
    workspace: { activeTabId: live?.activeTabId, afterSequence: workspaceVisibilityCursor,
      visibilityEvents: { roleWorkspace: roleWorkspaceVisibility, web: webVisibility } }
  };
  await writeFile(
    resolve(required("RION_STUDIO_E2E_ARTIFACT_DIR"), "chromium-mixed-recovery-runtime.json"),
    `${JSON.stringify({ lifecycle, native, saved, viewports, viewportActivation, runtimeState }, null, 2)}\n`
  );
  expect(saved!.placement).toEqual(lifecycle.placement);
  expect(native!.web.coreSlots).toEqual(lifecycle.workspace.slots);
  expect(native!.toolbar.workspaceTabs.find(({ tabId }) => tabId === lifecycle.workspace.tabId)?.slots)
    .toEqual(lifecycle.workspace.slots);
  expect(runtimeState).toEqual({ activeTabId: lifecycle.workspace.tabId, visible: true,
    projectionPending: false, restoreInProgressWindowIds: [] });
  expect(roleTabRuntime.activeTabId).toBe(lifecycle.roleTab.tabId);
  expect(roleTabToolbar.native.windowGeneration).toBe(roleTabToolbar.windowGeneration);
  expect(roleTabToolbar.native.topologyRevision).toBe(roleTabToolbar.topologyRevision);
  const roleTabSurface = roleTabToolbar.surfaces.find(({ id }) => id === lifecycle.roleTab.roleId)!;
  expect(roleTabSurface.visible).toBe(true);
  expect(roleTabSurface.tabId).toBe(lifecycle.roleTab.tabId);
  expect(native!.web.role!.visible).toBe(true);
  expect(native!.web.web.visible).toBe(true);
  const roleTabBounds = roleTabSurface.bounds;
  const roleWorkspaceBounds = native!.web.role!.bounds;
  const webBounds = native!.web.web.contentBounds;
  for (const [viewport, bounds] of [
    [viewports.roleTab, roleTabBounds], [viewports.roleWorkspace, roleWorkspaceBounds],
    [viewports.web, webBounds]
  ] as const) {
    expect(viewport.visibility).toBe("visible");
    expect(viewport.renderFrames).toBe(2);
    expect({ width: viewport.width, height: viewport.height })
      .toEqual({ width: bounds.width, height: bounds.height });
  }
  expect(native!.web.web.slotBounds.height).toBe(
    native!.web.web.chromeBounds.height + native!.web.web.contentBounds.height
  );
}

async function captureBackgroundRestore(lifecycle: MixedRecoveryLifecycle, launcherUrl: string) {
  if (lifecycle.platform !== "windows") return;
  const gameWindow = await electronDesktopE2eGameWindowRuntime(lifecycle.windowId);
  const runtimeNativeHostId = gameWindow.currentRuntime?.parentNativeHostId;
  if (!runtimeNativeHostId) throw new Error("Restored mixed Game Window has no exact native host");
  const launcherFocus = await browser.electron.execute((electron, input) => {
    const launchers = electron.BrowserWindow.getAllWindows().filter(window =>
      window.webContents.getURL() === input.launcherUrl);
    if (launchers.length !== 1) throw new Error("Exact mixed-recovery launcher is unavailable");
    const runtime = electron.BrowserWindow.fromId(input.runtimeNativeHostId);
    if (!runtime || runtime.isDestroyed()) throw new Error("Exact restored native window is unavailable");
    const native = process.getBuiltinModule("module").createRequire(input.nativeAddonPath)(input.nativeAddonPath) as {
      readWindowsRuntimeForeground: (handle: Buffer) => { parentWasForeground: boolean;
        parentVisible: boolean; parentMinimized: boolean; parentIdentity: string; focusIdentity: string };
    };
    if (typeof native.readWindowsRuntimeForeground !== "function") {
      throw new Error("The bundled native foreground readback is unavailable");
    }
    return { launcherNativeHostId: launchers[0].id, launcherFocused: launchers[0].isFocused(),
      focusedNativeHostId: electron.BrowserWindow.getFocusedWindow()?.id ?? null,
      runtimeNativeFocused: runtime.isFocused(),
      nativeForeground: {
        launcher: native.readWindowsRuntimeForeground(launchers[0].getNativeWindowHandle()),
        runtime: native.readWindowsRuntimeForeground(runtime.getNativeWindowHandle())
      } };
  }, { launcherUrl, runtimeNativeHostId,
    nativeAddonPath: resolve("build", "native", `${process.platform}-${process.arch}`, "rion-core.node") });
  await writeFile(resolve(required("RION_STUDIO_E2E_ARTIFACT_DIR"), "mixed-restored-background-native.json"),
    `${JSON.stringify({ gameWindow, launcherFocus }, null, 2)}\n`);
  expect(gameWindow.currentRuntime).toEqual(expect.objectContaining({ visible: true, focused: false }));
  expect(gameWindow.currentRuntime?.nativeDisplay.presentation).toBe("maximized");
  expect(launcherFocus.launcherFocused).toBe(true);
  expect(launcherFocus.focusedNativeHostId).toBe(launcherFocus.launcherNativeHostId);
  expect(launcherFocus.runtimeNativeFocused).toBe(false);
  expect(launcherFocus.nativeForeground.launcher).toEqual(expect.objectContaining({
    parentWasForeground: true, parentVisible: true, parentMinimized: false
  }));
  expect(launcherFocus.nativeForeground.runtime).toEqual(expect.objectContaining({
    parentWasForeground: false, parentVisible: true, parentMinimized: false
  }));
}

async function readLifecycle(platform: "macos" | "windows"): Promise<MixedRecoveryLifecycle> {
  const lifecycle = JSON.parse(await readFile(lifecyclePath(), "utf8")) as MixedRecoveryLifecycle;
  expect(lifecycle).toEqual(expect.objectContaining({ contractVersion: 1, platform }));
  return lifecycle;
}

async function waitExactRuntime(lifecycle: MixedRecoveryLifecycle): Promise<void> {
  await browser.waitUntil(async () => {
    const [runtime, topology] = await Promise.all([
      rendererCall("getEmbeddedRuntimeState"),
      rendererCall("getDisplayTopology")
    ]);
    const live = runtime.windows[0];
    return runtime.windows.length === 1
      && live?.id === lifecycle.windowId
      && topology.displays.some(({ id }) => id === live.displayId)
      && runtime.tabs.map(({ id }) => id).sort().join("|") ===
        [lifecycle.roleTab.tabId, lifecycle.workspace.tabId].sort().join("|");
  }, { timeout: 45_000, timeoutMsg: "Exact mixed native topology did not become live" });
}

async function showWindow(windowId: string): Promise<void> {
  await openSection("Windows", "/game-windows");
  const show = await $(`[data-selection-id='${windowId}'] button[aria-label='Show']`);
  await show.waitForClickable({ timeout: 10_000 });
  await show.click();
}

async function seedPhase(platform: "macos" | "windows"): Promise<void> {
  const [, roleTab, roleWorkspace] = await createGameAndRoles();
  const workspace = await createWorkspace(roleWorkspace);
  const gameWindow = await createWindow();
  let cursor = await fixtureCursor();
  await quickAccessLaunch(roleTab, "role", gameWindow.id);
  await waitSession(cursor, ROLE_TAB_FIXTURE, MARKERS.roleTab, false);
  cursor = await fixtureCursor();
  await quickAccessLaunch(workspace, "workspace", gameWindow.id);
  await waitSession(cursor, ROLE_WORKSPACE_FIXTURE, MARKERS.roleWorkspace, false);
  const entrance = await waitForWorkspaceWebRuntime(gameWindow.id);
  expect(entrance.web.contentUrl).toBe("rion-start://home/");
  await navigateVisibleElectronWorkspaceWebChrome(
    entrance.web.chromeShellUrl,
    await browser.getWindowHandle(),
    fixtureUrl(WEB_FIXTURE, MARKERS.web)
  );
  await waitSession(cursor, WEB_FIXTURE, MARKERS.web, false);
  await browser.waitUntil(async () => (await rendererCall("listLaunchWorkspaces"))
    .find(({ id }) => id === workspace.id)?.slots
    .some((slot) => slot.web?.lastUrl === fixtureUrl(WEB_FIXTURE, MARKERS.web)) ?? false,
  {
    interval: 100,
    timeout: 20_000,
    timeoutMsg: "Mixed recovery Web navigation was not durably committed"
  });
  const runtime = await rendererCall("getEmbeddedRuntimeState");
  const roleTabState = runtime.tabs.find(({ sourceId }) => sourceId === roleTab.id)!;
  const workspaceTab = runtime.tabs.find(({ sourceId }) => sourceId === workspace.id)!;
  const [roleTabNative, roleWorkspaceNative, web] = await Promise.all([
    electronDesktopE2eRoleSessionRuntime(roleTab.id),
    electronDesktopE2eRoleSessionRuntime(roleWorkspace.id),
    waitForWorkspaceWebRuntime(gameWindow.id)
  ]);
  const beforeMaximize = await findEntity(WINDOW_NAME, () => rendererCall("listGameWindows"));
  const mainWindowHandle = await browser.getWindowHandle();
  if (platform === "macos") {
    await focusVisibleMacosAppKitRuntime({ processId: (await electronDesktopE2eProbe()).processId,
      windowId: gameWindow.id });
  }
  await clickVisibleRuntimeWindowControl({ command: "maximize", platform, mainWindowHandle,
    windowId: gameWindow.id });
  let maximized: GameWindow | undefined;
  await browser.waitUntil(async () => {
    maximized = await findEntity(WINDOW_NAME, () => rendererCall("listGameWindows"));
    return maximized.placement.presentation === "maximized";
  }, { timeout: 30_000, timeoutMsg: "Visible mixed-window maximize did not persist" });
  expect(maximized!.placement.normalBounds).toEqual(beforeMaximize.placement.normalBounds);
  const lifecycle: MixedRecoveryLifecycle = {
    contractVersion: 1,
    platform,
    placement: maximized!.placement,
    roleTab: {
      chromiumPathSha256: roleTabNative.latestSessionEnsure.chromiumPathSha256,
      roleId: roleTab.id,
      tabId: roleTabState.id
    },
    roleWorkspace: {
      chromiumPathSha256: roleWorkspaceNative.latestSessionEnsure.chromiumPathSha256,
      roleId: roleWorkspace.id
    },
    web: { marker: MARKERS.web, slotId: web.web.slotId },
    windowId: gameWindow.id,
    workspace: { id: workspace.id, tabId: workspaceTab.id, slots: web.coreSlots }
  };
  await writeFile(lifecyclePath(), `${JSON.stringify(lifecycle, null, 2)}\n`);
  await writeRuntime(lifecycle);
}

async function forcePhase(input: Readonly<{
  platform: "macos" | "windows";
  processId: number;
}>): Promise<void> {
  const lifecycle = await readLifecycle(input.platform);
  expect((await rendererCall("getEmbeddedRuntimeState")).windows).toEqual([]);
  const cursor = await fixtureCursor();
  const restoreCursor = await runtimeEffectCursor();
  await showWindow(lifecycle.windowId);
  await waitForRestoreSavedGameWindowCompletion(lifecycle.windowId, restoreCursor);
  await waitForRestoreSessionTerminal(lifecycle.windowId, restoreCursor);
  await waitExactRuntime(lifecycle);
  await Promise.all([
    waitSession(cursor, ROLE_TAB_FIXTURE, MARKERS.roleTab, true),
    waitSession(cursor, ROLE_WORKSPACE_FIXTURE, MARKERS.roleWorkspace, true),
    waitSession(cursor, WEB_FIXTURE, MARKERS.web, true)
  ]);
  await writeRuntime(lifecycle);
  await writeFile(resolve(required("RION_STUDIO_E2E_ARTIFACT_DIR"), "forced-termination.json"),
    `${JSON.stringify({ pid: input.processId, requestedAt: new Date().toISOString() }, null, 2)}\n`);
  await forceTerminateProcessTree(input.processId);
}

async function restorePhase(input: Readonly<{
  platform: "macos" | "windows";
}>): Promise<void> {
  const lifecycle = await readLifecycle(input.platform);
  await navigate("/dashboard");
  const awaiting = await rendererCall("getEmbeddedRuntimeState");
  expect(awaiting.recovery).toEqual(expect.objectContaining({
    reason: "unclean-exit",
    tabCount: 2,
    windowCount: 1
  }));
  expect(awaiting.recovery?.interruptedWindowIds).toBeUndefined();
  expect(awaiting.savedWindows?.find(({ id }) => id === lifecycle.windowId)?.state)
    .toBe("awaiting-recovery");
  const cursor = await fixtureCursor();
  const restoreCursor = await runtimeEffectCursor();
  const launcherUrl = await browser.getUrl();
  const restore = await $("button=Restore session");
  await restore.waitForClickable({ timeout: 10_000 });
  await restore.click();
  await waitForSavedWindowRestoreCompletion(restoreCursor);
  await waitForRestoreSessionTerminal(lifecycle.windowId, restoreCursor);
  await waitExactRuntime(lifecycle);
  await Promise.all([
    waitSession(cursor, ROLE_TAB_FIXTURE, MARKERS.roleTab, true),
    waitSession(cursor, ROLE_WORKSPACE_FIXTURE, MARKERS.roleWorkspace, true),
    waitSession(cursor, WEB_FIXTURE, MARKERS.web, true)
  ]);
  await captureBackgroundRestore(lifecycle, launcherUrl);
  await browser.waitUntil(async () => (await rendererCall("getEmbeddedRuntimeState"))
    .recovery === undefined, { timeout: 45_000, timeoutMsg: "Mixed recovery did not terminalize" });
  await writeRuntime(lifecycle);
}

describe("mixed Chromium runtime recovery", () => {
  it("restores exact Role and Workspace-Web tabs through retained native chrome", async () => {
    const phase = required("RION_STUDIO_E2E_PHASE");
    const probe = await electronDesktopE2eProbe();
    expect(probe.runtimeTarget).toBe(required("RION_STUDIO_E2E_RUNTIME_TARGET"));
    await ensureEnglishUi();
    await acceptLegalAndSkipFirstRun();
    if (phase === "chromium-mixed-recovery-seed") await seedPhase(probe.platform);
    else if (phase === "chromium-mixed-recovery-force") {
      await forcePhase({ platform: probe.platform, processId: probe.processId });
    } else if (phase === "chromium-mixed-recovery-restore") {
      await restorePhase({ platform: probe.platform });
    } else throw new Error(`Unexpected mixed recovery phase ${phase}`);
  });
});
