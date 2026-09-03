import { $, browser, expect } from "@wdio/globals";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type {
  EmbeddedRuntimeState,
  Game,
  GameWindow,
  Role
} from "../../../src/shared/types";
import {
  electronDesktopE2eFullscreenToolbarRuntime,
  electronDesktopE2eGameWindowRuntime,
  electronDesktopE2eProbe
} from "../support/electron-driver";
import {
  clickVisibleElectronRolePageButton
} from "../support/electron-role-surface";
import {
  fixtureCursor,
  fixtureRequest,
  waitFixtureEvent
} from "../support/fixture";
import {
  dragMacosVisibleRuntimeTab,
  selectMacosVisibleRuntimeTabMenuAction
} from "../support/macos-appkit-ui";
import {
  clickVisibleRuntimeWindowControl,
  clickVisibleRuntimeTab,
  closeVisibleRuntimeTab,
  closeVisibleRuntimeWindow,
  dragVisibleWindowsRuntimeTab,
  installRuntimeTabShellErrorJournal,
  readVisibleWindowsRuntimeHostLayout,
  resizeVisibleWindowsRuntimeWindow,
  runtimeTabShellErrors,
  runtimeWindowIsMinimized,
  selectVisibleWindowsRuntimeTabMenuAction,
  visibleRuntimeTabPhase
} from "../support/native-runtime-tabs";
import { rendererCall } from "../support/renderer-bridge";
import {
  acceptLegalAndSkipFirstRun,
  clickEntityMenuAction,
  ensureEnglishUi,
  setEditorName,
  submitEditor,
  waitForRoute
} from "../support/ui";

// [journey:CHROMIUM-MACOS-APPKIT-TABS-VISIBLE-ACTIVATION-019]
// [journey:CHROMIUM-WINDOWS-TABS-VISIBLE-ACTIVATION-019]
// [journey:CHROMIUM-MACOS-APPKIT-GAME-WINDOWS-TABS-020]
// [journey:CHROMIUM-WINDOWS-GAME-WINDOWS-TABS-020]
// [journey:CHROMIUM-MACOS-APPKIT-RUNTIME-LAUNCH-DESTINATIONS-008]
// [journey:CHROMIUM-WINDOWS-RUNTIME-LAUNCH-DESTINATIONS-008]
// [journey:CHROMIUM-MACOS-APPKIT-RUNTIME-TAB-TOPOLOGY-009]
// [journey:CHROMIUM-WINDOWS-RUNTIME-TAB-TOPOLOGY-009]

const GAME_NAME = "Chromium Tabs Game";
const WINDOW_NAME = "Chromium Tabs Window";
const TARGET_WINDOW_NAME = "Chromium Tabs Target Window";
const ROLE_DEFINITIONS = [
  { fixtureId: "chromium-tabs-alpha", name: "Chromium Tabs Alpha" },
  { fixtureId: "chromium-tabs-beta", name: "Chromium Tabs Beta" },
  { fixtureId: "chromium-tabs-gamma", name: "Chromium Tabs Gamma" },
  { fixtureId: "chromium-tabs-delta", name: "Chromium Tabs Delta" }
] as const;
const SOURCE_ROLE_DEFINITIONS = ROLE_DEFINITIONS.slice(0, 3);

type Platform = "macos" | "windows";
const launchDiagnostics: unknown[] = [];
const topologyObservations: unknown[] = [];

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the Chromium tabs journey`);
  return value;
}

async function openSection(label: string, route: string): Promise<void> {
  const sidebar = await $(".app-main-sidebar");
  await sidebar.waitForDisplayed({ timeout: 20_000 });
  const button = await sidebar.$(`button*=${label}`);
  await button.waitForClickable({ timeout: 10_000 });
  await button.click();
  await waitForRoute(route);
}

async function findGame(): Promise<Game> {
  let game: Game | undefined;
  await browser.waitUntil(async () => {
    game = (await rendererCall("listGames"))
      .find((candidate) => candidate.name === GAME_NAME);
    return game !== undefined;
  }, { timeout: 15_000, timeoutMsg: `Did not find ${GAME_NAME}` });
  return game!;
}

async function findRoles(): Promise<Role[]> {
  let roles: Role[] = [];
  await browser.waitUntil(async () => {
    const current = await rendererCall("listRoles");
    roles = ROLE_DEFINITIONS.map((definition) =>
      current.find((candidate) => candidate.name === definition.name)
    ).filter((candidate): candidate is Role => candidate !== undefined);
    return roles.length === ROLE_DEFINITIONS.length;
  }, { timeout: 15_000, timeoutMsg: "Did not find the exact four Chromium tab Roles" });
  return roles;
}

async function findWindowByName(name: string): Promise<GameWindow> {
  let gameWindow: GameWindow | undefined;
  await browser.waitUntil(async () => {
    const matches = (await rendererCall("listGameWindows"))
      .filter((candidate) => candidate.name === name);
    gameWindow = matches[0];
    return matches.length === 1;
  }, { timeout: 15_000, timeoutMsg: `Did not find ${name}` });
  return gameWindow!;
}

async function findWindow(): Promise<GameWindow> {
  return findWindowByName(WINDOW_NAME);
}

function launchUrl(fixtureId: string): string {
  const url = new URL(`/role/${fixtureId}`, required("RION_STUDIO_E2E_FIXTURE_ORIGIN"));
  url.searchParams.set("mode", "observe");
  return url.href;
}

async function captureLaunchDiagnostic(
  stage: string,
  role: Role,
  gameWindow: GameWindow
): Promise<void> {
  const [runtime, statuses, probe, native, shellErrors, bodyText] = await Promise.all([
    rendererCall("getEmbeddedRuntimeState"),
    rendererCall("listRoleStatuses"),
    electronDesktopE2eProbe(),
    electronDesktopE2eGameWindowRuntime(gameWindow.id).catch((error: unknown) => ({
      error: error instanceof Error ? error.message : String(error)
    })),
    runtimeTabShellErrors(),
    $("body").getText()
  ]);
  launchDiagnostics.push({
    bodyText,
    native,
    probe,
    roleId: role.id,
    runtime,
    shellErrors,
    stage,
    statuses
  });
  await writeFile(
    resolve(required("RION_STUDIO_E2E_ARTIFACT_DIR"), "chromium-tabs-launch-diagnostics.json"),
    `${JSON.stringify(launchDiagnostics, null, 2)}\n`
  );
}

async function createGameWindowThroughVisibleUi(name: string): Promise<GameWindow> {
  await openSection("Windows", "/game-windows");
  const priorIds = new Set((await rendererCall("listGameWindows"))
    .map((candidate) => candidate.id));
  await $("button=New game window").click();
  let created: GameWindow | undefined;
  await browser.waitUntil(async () => {
    created = (await rendererCall("listGameWindows"))
      .find((candidate) => !priorIds.has(candidate.id));
    return created !== undefined;
  }, { timeout: 15_000, timeoutMsg: "Visible Game Window creation did not commit" });
  await clickEntityMenuAction(created!.id, "Game window actions", "Rename");
  const input = await $("#rename-game-window-name");
  await input.waitForDisplayed({ timeout: 10_000 });
  await input.clearValue();
  await input.setValue(name);
  const dialog = await $("dialog[open]");
  await dialog.waitForDisplayed({ timeout: 10_000 });
  const save = await dialog.$("button=Save");
  await save.waitForClickable({ timeout: 10_000 });
  await save.click();
  return findWindowByName(name);
}

async function createEntitiesThroughVisibleUi(): Promise<Readonly<{
  gameWindow: GameWindow;
  roles: readonly Role[];
  targetWindow: GameWindow;
}>> {
  await openSection("Games", "/games");
  await $("button=New game").click();
  await waitForRoute("/games/new");
  await setEditorName(GAME_NAME);
  await $("#game-launch-url").setValue(launchUrl(ROLE_DEFINITIONS[0].fixtureId));
  await submitEditor("/games");
  const game = await findGame();

  for (const definition of ROLE_DEFINITIONS) {
    await openSection("Games", "/games");
    await clickEntityMenuAction(game.id, "Game actions", "Add role");
    await waitForRoute(`/roles/new?gameId=${game.id}`);
    await setEditorName(definition.name);
    await $("#role-launch-url").setValue(launchUrl(definition.fixtureId));
    await submitEditor("/roles");
  }
  const roles = await findRoles();

  const gameWindow = await createGameWindowThroughVisibleUi(WINDOW_NAME);
  const targetWindow = await createGameWindowThroughVisibleUi(TARGET_WINDOW_NAME);
  return { gameWindow, roles, targetWindow };
}

function sameOrderedIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

async function showSavedWindow(input: Readonly<{
  activeTabId: string;
  gameWindow: GameWindow;
  orderedTabIds: readonly string[];
}>): Promise<void> {
  await openSection("Windows", "/game-windows");
  const row = await $(`[data-selection-id='${input.gameWindow.id}']`);
  await row.waitForDisplayed({ timeout: 10_000 });
  await row.scrollIntoView({ block: "center", inline: "center" });
  const show = await row.$("button[aria-label='Show']");
  await show.waitForClickable({ timeout: 10_000 });
  await show.click();
  try {
    await browser.waitUntil(async () => {
      try {
        const [owner, runtime, inspection] = await Promise.all([
          electronDesktopE2eGameWindowRuntime(input.gameWindow.id),
          rendererCall("getEmbeddedRuntimeState"),
          electronDesktopE2eFullscreenToolbarRuntime(input.gameWindow.id)
        ]);
        const current = owner.currentRuntime;
        const logical = runtime.windows.find(
          (window) => window.id === input.gameWindow.id
        );
        const liveTabIds = runtime.tabs
          .filter((tab) => tab.windowId === input.gameWindow.id)
          .map((tab) => tab.id);
        const visibleSurfaceTabIds = inspection.surfaces
          .filter((surface) => surface.visible)
          .map((surface) => surface.tabId);
        return current?.visible === true && current.focused &&
          sameOrderedIds(current.coreTabIds, input.orderedTabIds) &&
          sameOrderedIds(current.nativeTabIds, input.orderedTabIds) &&
          sameOrderedIds(liveTabIds, input.orderedTabIds) &&
          logical?.activeTabId === input.activeTabId &&
          sameOrderedIds(inspection.tabIds, input.orderedTabIds) &&
          sameOrderedIds(visibleSurfaceTabIds, [input.activeTabId]);
      } catch {
        return false;
      }
    }, {
      interval: 100,
      timeout: 55_000,
      timeoutMsg: `Saved Game Window ${input.gameWindow.id} did not restore its exact tab cohort`
    });
  } catch (error) {
    const diagnostics = await Promise.allSettled([
      electronDesktopE2eGameWindowRuntime(input.gameWindow.id),
      rendererCall("getEmbeddedRuntimeState"),
      rendererCall("listRoleStatuses"),
      runtimeTabShellErrors(),
      $("body").getText()
    ]);
    throw new Error(
      `Saved Game Window ${input.gameWindow.id} restore diagnostics: ${JSON.stringify(diagnostics)}`,
      { cause: error }
    );
  }
}

async function launchRoleIntoWindow(
  role: Role,
  gameWindow: GameWindow,
  loading?: Readonly<{ mainWindowHandle: string; platform: Platform }>
): Promise<string> {
  await openSection("Home", "/dashboard");
  await $("[data-testid='quick-access-trigger']").click();
  const palette = await $("[data-testid='quick-access-palette'][open]");
  await palette.waitForDisplayed({ timeout: 10_000 });
  await palette.$("input[role='combobox']").setValue(role.name);
  const option = await $(`#quick-access-option-role-${role.id}`);
  await option.waitForDisplayed({ timeout: 10_000 });
  const destination = await $(`[data-testid='quick-access-destination-role-${role.id}']`);
  await destination.waitForClickable({ timeout: 10_000 });
  await destination.click();
  const savedWindow = await $(
    `[data-testid='quick-access-destination-option-window-${gameWindow.id}']`
  );
  await savedWindow.waitForClickable({ timeout: 10_000 });
  await captureLaunchDiagnostic("before-visible-destination-click", role, gameWindow);
  const afterSequence = await fixtureCursor();
  const fixtureId = ROLE_DEFINITIONS.find(
    (definition) => definition.name === role.name
  )!.fixtureId;
  if (loading) await fixtureRequest("/api/gate", { roleId: fixtureId });
  await savedWindow.click();
  await captureLaunchDiagnostic("after-visible-destination-click", role, gameWindow);

  let tabId: string | undefined;
  if (loading) {
    try {
      await browser.waitUntil(async () => {
        const tab = (await rendererCall("getEmbeddedRuntimeState")).tabs.find(
          (candidate) => candidate.sourceId === role.id
        );
        tabId = tab?.id;
        return Boolean(tabId);
      }, { timeout: 30_000, timeoutMsg: `Role ${role.id} did not admit its loading tab` });
      const waiter = await fetch(
        `${required("RION_STUDIO_E2E_FIXTURE_ORIGIN")}/api/gates/${fixtureId}/waiting`,
        { signal: AbortSignal.timeout(45_000) }
      );
      expect(waiter.ok).toBe(true);
      expect(await visibleRuntimeTabPhase({
        ...loading,
        tabId: tabId!,
        tabName: role.name,
        windowId: gameWindow.id
      })).toBe("loading");
    } finally {
      await fixtureRequest("/api/release", { roleId: fixtureId });
    }
  }
  await browser.waitUntil(async () => {
    const runtime = await rendererCall("getEmbeddedRuntimeState");
    const tab = runtime.tabs.find((candidate) => candidate.sourceId === role.id);
    const status = (await rendererCall("listRoleStatuses"))
      .find((candidate) => candidate.roleId === role.id);
    tabId = tab?.id;
    return Boolean(tabId) && status?.state === "running";
  }, {
    interval: 100,
    timeout: 55_000,
    timeoutMsg: `Role ${role.id} did not reach a ready Chromium tab`
  });
  await waitFixtureEvent({
    afterSequence,
    kind: "session",
    roleId: fixtureId
  });
  if (loading) {
    expect(await visibleRuntimeTabPhase({
      ...loading,
      tabId: tabId!,
      tabName: role.name,
      windowId: gameWindow.id
    })).toBe("ready");
  }
  return tabId!;
}

async function currentRuntime(windowId: string): Promise<EmbeddedRuntimeState> {
  const runtime = await rendererCall("getEmbeddedRuntimeState");
  expect(runtime.windows.filter((window) => window.id === windowId)).toHaveLength(1);
  return runtime;
}

async function waitForExactWindowTopology(input: Readonly<{
  activeTabId: string;
  hiddenTabIds?: readonly string[];
  orderedTabIds: readonly string[];
  windowId: string;
}>): Promise<GameWindow> {
  let saved: GameWindow | undefined;
  await browser.waitUntil(async () => {
    try {
      const [runtime, windows, owner] = await Promise.all([
        rendererCall("getEmbeddedRuntimeState"),
        rendererCall("listGameWindows"),
        electronDesktopE2eGameWindowRuntime(input.windowId)
      ]);
      saved = windows.find((candidate) => candidate.id === input.windowId);
      const logical = runtime.windows.find((candidate) => candidate.id === input.windowId);
      const tabs = runtime.tabs.filter((candidate) => candidate.windowId === input.windowId);
      const hidden = new Set(input.hiddenTabIds ?? []);
      const current = owner.currentRuntime;
      return Boolean(saved && logical && current) &&
        sameOrderedIds(saved!.tabs.map((tab) => tab.id), input.orderedTabIds) &&
        sameOrderedIds(tabs.map((tab) => tab.id), input.orderedTabIds) &&
        sameOrderedIds(current!.coreTabIds, input.orderedTabIds) &&
        sameOrderedIds(current!.nativeTabIds, input.orderedTabIds) &&
        saved!.activeTabId === input.activeTabId &&
        logical!.activeTabId === input.activeTabId &&
        saved!.tabs.every((tab) => tab.hidden === hidden.has(tab.id)) &&
        tabs.every((tab) => tab.hidden === hidden.has(tab.id));
    } catch {
      return false;
    }
  }, {
    interval: 100,
    timeout: 55_000,
    timeoutMsg: `Window ${input.windowId} did not reach its exact fenced topology`
  });
  return saved!;
}

async function findWindowOwningTab(
  tabId: string,
  excludedWindowIds: readonly string[] = []
): Promise<GameWindow> {
  let owner: GameWindow | undefined;
  await browser.waitUntil(async () => {
    const matches = (await rendererCall("listGameWindows")).filter(
      (window) => window.tabs.some((tab) => tab.id === tabId)
    );
    owner = matches[0];
    return matches.length === 1 && !excludedWindowIds.includes(owner!.id);
  }, {
    interval: 100,
    timeout: 55_000,
    timeoutMsg: `No exact saved Game Window owns tab ${tabId}`
  });
  return owner!;
}

async function selectVisibleTabMenuAction(input: Readonly<{
  action: "hide" | "move" | "moveToNewWindow";
  mainWindowHandle: string;
  platform: Platform;
  tabId: string;
  tabName: string;
  targetWindow?: GameWindow;
}>): Promise<void> {
  if (input.platform === "macos") {
    await selectMacosVisibleRuntimeTabMenuAction({
      action: input.action,
      tabName: input.tabName,
      ...(input.targetWindow === undefined
        ? {}
        : { targetWindowName: input.targetWindow.name })
    });
    return;
  }
  await selectVisibleWindowsRuntimeTabMenuAction({
    action: input.action,
    mainWindowHandle: input.mainWindowHandle,
    tabId: input.tabId,
    ...(input.targetWindow === undefined
      ? {}
      : { targetWindowId: input.targetWindow.id })
  });
}

async function dragVisibleTabBefore(input: Readonly<{
  beforeTabId: string;
  beforeTabName: string;
  mainWindowHandle: string;
  platform: Platform;
  tabId: string;
  tabName: string;
  windowId: string;
}>): Promise<void> {
  if (input.platform === "macos") {
    await dragMacosVisibleRuntimeTab({
      placement: "before",
      sourceTabId: input.tabId,
      targetTabId: input.beforeTabId,
      windowId: input.windowId
    });
    return;
  }
  await dragVisibleWindowsRuntimeTab({
    beforeTabId: input.beforeTabId,
    mainWindowHandle: input.mainWindowHandle,
    tabId: input.tabId
  });
}

async function revealRoleThroughVisibleUi(role: Role, tabId: string): Promise<void> {
  await openSection("Roles", "/roles");
  const row = await $(`[data-selection-id='${role.id}']`);
  await row.waitForDisplayed({ timeout: 10_000 });
  const open = await row.$("button[aria-label='Open']");
  await open.waitForClickable({ timeout: 10_000 });
  await open.click();
  await browser.waitUntil(async () => (
    await rendererCall("getEmbeddedRuntimeState")
  ).tabs.some((tab) => tab.id === tabId && !tab.hidden), {
    interval: 100,
    timeout: 55_000,
    timeoutMsg: `Visible Role Open did not reveal tab ${tabId}`
  });
}

async function recordTopology(input: Readonly<{
  geometry?: unknown;
  platform: Platform;
  roles: readonly Role[];
  stage: string;
}>): Promise<void> {
  const [runtime, savedWindows, shellErrors] = await Promise.all([
    rendererCall("getEmbeddedRuntimeState"),
    rendererCall("listGameWindows"),
    runtimeTabShellErrors()
  ]);
  const roleIds = new Set(input.roles.map((role) => role.id));
  const tracked = savedWindows.filter((window) =>
    window.name === WINDOW_NAME || window.name === TARGET_WINDOW_NAME ||
    window.tabs.some((tab) => roleIds.has(tab.sourceId))
  );
  const windows = await Promise.all(tracked.map(async (window) => {
    const logical = runtime.windows.find((candidate) => candidate.id === window.id);
    const tabs = runtime.tabs.filter((candidate) => candidate.windowId === window.id);
    const owner = logical
      ? (await electronDesktopE2eGameWindowRuntime(window.id)).currentRuntime
      : null;
    const native = logical && tabs.length > 0
      ? await electronDesktopE2eFullscreenToolbarRuntime(window.id)
      : null;
    return {
      id: window.id,
      logical: logical ?? null,
      name: window.name,
      native,
      owner,
      persistedActiveTabId: window.activeTabId ?? null,
      persistedTabs: window.tabs.map((tab) => ({
        hidden: tab.hidden,
        id: tab.id,
        name: tab.name,
        sourceId: tab.sourceId
      })),
      runtimeTabs: tabs.map((tab) => ({
        active: tab.active,
        hidden: tab.hidden,
        id: tab.id,
        name: tab.name,
        sourceId: tab.sourceId
      }))
    };
  }));
  topologyObservations.push({
    ...(input.geometry === undefined ? {} : { geometry: input.geometry }),
    platform: input.platform,
    roleTabIds: Object.fromEntries(input.roles.map((role) => [
      role.name,
      tracked.flatMap((window) => window.tabs)
        .find((tab) => tab.sourceId === role.id)?.id ?? null
    ])),
    shellErrors,
    stage: input.stage,
    windows
  });
  await writeFile(
    resolve(
      required("RION_STUDIO_E2E_ARTIFACT_DIR"),
      "chromium-tabs-topology-observations.json"
    ),
    `${JSON.stringify(topologyObservations, null, 2)}\n`
  );
}

function expectWindowsViewportLayout(
  layout: Awaited<ReturnType<typeof readVisibleWindowsRuntimeHostLayout>>
): void {
  expect(layout.viewport).toEqual({
    height: layout.contentBounds.y + layout.contentBounds.height,
    width: layout.contentBounds.width
  });
  expect(layout.windowGeneration).toBeGreaterThan(0);
  expect(layout.topologyRevision).toBeGreaterThan(0);
  expect(layout.projectionRevision).toBeGreaterThan(0);
}

async function exerciseWindowsGeometry(input: Readonly<{
  mainWindowHandle: string;
  roles: readonly Role[];
  sourceActiveTabId: string;
  sourceTabId: string;
  sourceWindow: GameWindow;
  targetTabId: string;
  targetWindow: GameWindow;
}>): Promise<void> {
  const sourceBefore = await readVisibleWindowsRuntimeHostLayout({
    mainWindowHandle: input.mainWindowHandle,
    tabId: input.sourceTabId
  });
  const targetBefore = await readVisibleWindowsRuntimeHostLayout({
    mainWindowHandle: input.mainWindowHandle,
    tabId: input.targetTabId
  });
  await resizeVisibleWindowsRuntimeWindow({
    deltaHeight: 52,
    deltaWidth: 84,
    mainWindowHandle: input.mainWindowHandle,
    tabId: input.sourceTabId
  });
  await resizeVisibleWindowsRuntimeWindow({
    deltaHeight: 76,
    deltaWidth: -48,
    mainWindowHandle: input.mainWindowHandle,
    tabId: input.targetTabId
  });
  let sourceResized = sourceBefore;
  let targetResized = targetBefore;
  await browser.waitUntil(async () => {
    [sourceResized, targetResized] = await Promise.all([
      readVisibleWindowsRuntimeHostLayout({
        mainWindowHandle: input.mainWindowHandle,
        tabId: input.sourceTabId
      }),
      readVisibleWindowsRuntimeHostLayout({
        mainWindowHandle: input.mainWindowHandle,
        tabId: input.targetTabId
      })
    ]);
    return sourceResized.contentBounds.width !== sourceBefore.contentBounds.width &&
      sourceResized.contentBounds.height !== sourceBefore.contentBounds.height &&
      targetResized.contentBounds.width !== targetBefore.contentBounds.width &&
      targetResized.contentBounds.height !== targetBefore.contentBounds.height;
  }, {
    interval: 100,
    timeout: 45_000,
    timeoutMsg: "Visible Windows resize did not update both exact host roots"
  });
  expectWindowsViewportLayout(sourceResized);
  expectWindowsViewportLayout(targetResized);
  expect(sourceResized.windowId).toBe(input.sourceWindow.id);
  expect(targetResized.windowId).toBe(input.targetWindow.id);
  for (const [window, layout] of await Promise.all([
    electronDesktopE2eFullscreenToolbarRuntime(input.sourceWindow.id)
      .then((window) => [window, sourceResized] as const),
    electronDesktopE2eFullscreenToolbarRuntime(input.targetWindow.id)
      .then((window) => [window, targetResized] as const)
  ])) {
    expect(window.surfaces.length).toBeGreaterThan(0);
    expect(window.surfaces.every((surface) =>
      JSON.stringify(surface.bounds) === JSON.stringify(layout.contentBounds)
    )).toBe(true);
    expect(window.windowGeneration).toBe(layout.windowGeneration);
    expect(window.topologyRevision).toBe(layout.topologyRevision);
  }

  await clickVisibleRuntimeWindowControl({
    command: "minimize",
    mainWindowHandle: input.mainWindowHandle,
    platform: "windows",
    tabId: input.sourceTabId
  });
  await browser.waitUntil(() => runtimeWindowIsMinimized("windows"), {
    interval: 100,
    timeout: 30_000,
    timeoutMsg: "The exact visible Windows runtime host did not minimize"
  });
  const savedSource = (await rendererCall("listGameWindows")).find(
    (window) => window.id === input.sourceWindow.id
  )!;
  await showSavedWindow({
    activeTabId: input.sourceActiveTabId,
    gameWindow: savedSource,
    orderedTabIds: savedSource.tabs.map((tab) => tab.id)
  });
  const sourceRestored = await readVisibleWindowsRuntimeHostLayout({
    mainWindowHandle: input.mainWindowHandle,
    tabId: input.sourceTabId
  });
  expect(sourceRestored.contentBounds).toEqual(sourceResized.contentBounds);
  expect(sourceRestored.viewport).toEqual(sourceResized.viewport);
  expect(sourceRestored.resizeEventCount).toBe(sourceResized.resizeEventCount);
  expectWindowsViewportLayout(sourceRestored);
  await recordTopology({
    geometry: {
      source: { before: sourceBefore, resized: sourceResized, restored: sourceRestored },
      target: { before: targetBefore, resized: targetResized }
    },
    platform: "windows",
    roles: input.roles,
    stage: "windows-geometry"
  });
}

async function expectExactNativeTopology(input: Readonly<{
  activeTabId: string;
  gameWindow: GameWindow;
  orderedTabIds: readonly string[];
  platform: Platform;
}>): Promise<void> {
  const inspection = await electronDesktopE2eFullscreenToolbarRuntime(
    input.gameWindow.id
  );
  const windowOwner = await electronDesktopE2eGameWindowRuntime(input.gameWindow.id);
  const topology = await rendererCall("getDisplayTopology");
  const nativeDisplay = windowOwner.currentRuntime?.nativeDisplay;
  const display = topology.displays.find(
    (candidate) => candidate.id === nativeDisplay?.displayId
  );
  expect(inspection.tabIds).toEqual(input.orderedTabIds);
  expect(inspection.surfaces.filter((surface) => surface.visible)).toEqual([
    expect.objectContaining({ tabId: input.activeTabId, visible: true })
  ]);
  expect(windowOwner.currentRuntime).toEqual(expect.objectContaining({
    coreTabIds: input.orderedTabIds,
    focused: true,
    nativeTabIds: input.orderedTabIds,
    visible: true
  }));
  expect(display).toBeDefined();
  expect(nativeDisplay).toEqual(expect.objectContaining({
    displayId: display!.id,
    scaleFactor: display!.scaleFactor,
    workArea: display!.workArea
  }));
  if (input.platform === "macos") {
    expect(inspection.hostKind).toBe("appkit");
    expect(inspection.native.appKit).toEqual(expect.objectContaining({
      tabStripOnScreen: true
    }));
    expect(windowOwner.currentRuntime?.hostKind).toBe("appkit-chromium");
    expect(windowOwner.currentRuntime?.appKitIdentity?.logicalWindowId)
      .toBe(input.gameWindow.id);
  } else {
    expect(inspection.hostKind).toBe("windows");
    expect(inspection.native.appKit).toBeUndefined();
    expect(windowOwner.currentRuntime?.hostKind).toBe("bundled-chromium");
    expect(windowOwner.currentRuntime?.appKitIdentity).toBeNull();
  }
}

async function activateAndFocusEveryTab(input: Readonly<{
  gameWindow: GameWindow;
  mainWindowHandle: string;
  orderedTabIds: readonly string[];
  platform: Platform;
  roles: readonly Role[];
}>): Promise<void> {
  for (const [index, role] of input.roles.entries()) {
    const tabId = input.orderedTabIds[index]!;
    const fixtureId = ROLE_DEFINITIONS.find(
      (definition) => definition.name === role.name
    )!.fixtureId;
    const before = await currentRuntime(input.gameWindow.id);
    const alreadyActive = before.windows.find(
      (window) => window.id === input.gameWindow.id
    )?.activeTabId === tabId;
    const afterSequence = alreadyActive ? undefined : await fixtureCursor();
    await clickVisibleRuntimeTab({
      mainWindowHandle: input.mainWindowHandle,
      platform: input.platform,
      tabId,
      tabName: role.name
    });
    await browser.waitUntil(async () => {
      const runtime = await currentRuntime(input.gameWindow.id);
      return runtime.windows.find((window) => window.id === input.gameWindow.id)
        ?.activeTabId === tabId && runtime.tabs.some((tab) => tab.id === tabId);
    }, {
      interval: 100,
      timeout: 55_000,
      timeoutMsg: `Visible native tab ${tabId} did not become ready and active`
    });
    if (afterSequence !== undefined) {
      await waitFixtureEvent({
        afterSequence,
        kind: "visibility",
        roleId: fixtureId
      });
    }
    const clickCursor = await fixtureCursor();
    await clickVisibleElectronRolePageButton(role.launchUrl, input.mainWindowHandle);
    await waitFixtureEvent({ afterSequence: clickCursor, kind: "click", roleId: fixtureId });
    await expectExactNativeTopology({
      activeTabId: tabId,
      gameWindow: input.gameWindow,
      orderedTabIds: input.orderedTabIds,
      platform: input.platform
    });
  }
}

async function waitForDormantWindow(windowId: string): Promise<void> {
  await browser.waitUntil(async () => (
    await electronDesktopE2eGameWindowRuntime(windowId)
  ).currentRuntime === null, {
    interval: 100,
    timeout: 30_000,
    timeoutMsg: `Game Window ${windowId} did not become dormant`
  });
}

async function closeAndReopenSavedWindow(input: Readonly<{
  gameWindow: GameWindow;
  mainWindowHandle: string;
  orderedTabIds: readonly string[];
  platform: Platform;
  roles: readonly Role[];
}>): Promise<void> {
  const before = await electronDesktopE2eGameWindowRuntime(input.gameWindow.id);
  const generation = before.currentRuntime!.windowGeneration;
  await closeVisibleRuntimeWindow(input);
  await waitForDormantWindow(input.gameWindow.id);
  const saved = await findWindow();
  expect(saved.tabs.map((tab) => tab.id)).toEqual(input.orderedTabIds);
  expect(saved.activeTabId).toBe(input.orderedTabIds.at(-1));

  await showSavedWindow({
    activeTabId: input.orderedTabIds.at(-1)!,
    gameWindow: saved,
    orderedTabIds: input.orderedTabIds
  });
  const reopened = await electronDesktopE2eGameWindowRuntime(saved.id);
  expect(reopened.currentRuntime?.windowGeneration).toBeGreaterThan(generation);
  await expectExactNativeTopology({
    activeTabId: input.orderedTabIds.at(-1)!,
    gameWindow: saved,
    orderedTabIds: input.orderedTabIds,
    platform: input.platform
  });
  await activateAndFocusEveryTab({ ...input, gameWindow: saved });
}

async function seedPhase(input: Readonly<{
  mainWindowHandle: string;
  platform: Platform;
}>): Promise<void> {
  await fixtureRequest("/api/reset", {});
  const { gameWindow, roles, targetWindow } = await createEntitiesThroughVisibleUi();
  const sourceRoles = roles.slice(0, SOURCE_ROLE_DEFINITIONS.length);
  const tabIds: string[] = [];
  for (const [index, role] of sourceRoles.entries()) {
    tabIds.push(await launchRoleIntoWindow(
      role,
      gameWindow,
      index === 0 ? input : undefined
    ));
  }

  await activateAndFocusEveryTab({
    gameWindow,
    mainWindowHandle: input.mainWindowHandle,
    orderedTabIds: tabIds,
    platform: input.platform,
    roles: sourceRoles
  });

  await closeVisibleRuntimeTab({
    mainWindowHandle: input.mainWindowHandle,
    platform: input.platform,
    tabId: tabIds[2]!,
    tabName: roles[2]!.name,
    windowId: gameWindow.id
  });
  await browser.waitUntil(async () => {
    const runtime = await currentRuntime(gameWindow.id);
    return runtime.tabs.filter((tab) => tab.windowId === gameWindow.id).length === 2 &&
      !runtime.tabs.some((tab) => tab.id === tabIds[2]);
  }, { timeout: 45_000, timeoutMsg: "Visible native tab close did not commit" });
  expect((await findWindow()).tabs.map((tab) => tab.id)).toEqual(tabIds);

  const dormantTabId = tabIds[2]!;
  tabIds[2] = await launchRoleIntoWindow(roles[2]!, gameWindow);
  expect(tabIds[2]).toBe(dormantTabId);
  expect((await findWindow()).tabs.map((tab) => tab.id)).toEqual(tabIds);
  await closeAndReopenSavedWindow({
    gameWindow,
    mainWindowHandle: input.mainWindowHandle,
    orderedTabIds: tabIds,
    platform: input.platform,
    roles: sourceRoles
  });
  await recordTopology({
    platform: input.platform,
    roles,
    stage: "baseline"
  });

  const targetTabId = await launchRoleIntoWindow(roles[3]!, targetWindow);
  await waitForExactWindowTopology({
    activeTabId: targetTabId,
    orderedTabIds: [targetTabId],
    windowId: targetWindow.id
  });
  await dragVisibleTabBefore({
    beforeTabId: tabIds[0]!,
    beforeTabName: sourceRoles[0]!.name,
    mainWindowHandle: input.mainWindowHandle,
    platform: input.platform,
    tabId: tabIds[2]!,
    tabName: sourceRoles[2]!.name,
    windowId: gameWindow.id
  });
  const reorderedSource = [tabIds[2]!, tabIds[0]!, tabIds[1]!];
  await waitForExactWindowTopology({
    activeTabId: tabIds[2]!,
    orderedTabIds: reorderedSource,
    windowId: gameWindow.id
  });
  await recordTopology({
    platform: input.platform,
    roles,
    stage: "reordered"
  });

  await selectVisibleTabMenuAction({
    action: "move",
    mainWindowHandle: input.mainWindowHandle,
    platform: input.platform,
    tabId: tabIds[1]!,
    tabName: sourceRoles[1]!.name,
    targetWindow
  });
  await Promise.all([
    waitForExactWindowTopology({
      activeTabId: tabIds[2]!,
      orderedTabIds: [tabIds[2]!, tabIds[0]!],
      windowId: gameWindow.id
    }),
    waitForExactWindowTopology({
      activeTabId: tabIds[1]!,
      orderedTabIds: [targetTabId, tabIds[1]!],
      windowId: targetWindow.id
    })
  ]);
  await recordTopology({
    platform: input.platform,
    roles,
    stage: "moved-existing"
  });
  if (input.platform === "windows") {
    await exerciseWindowsGeometry({
      mainWindowHandle: input.mainWindowHandle,
      roles,
      sourceActiveTabId: tabIds[2]!,
      sourceTabId: tabIds[2]!,
      sourceWindow: gameWindow,
      targetTabId: tabIds[1]!,
      targetWindow
    });
  }

  await clickVisibleRuntimeTab({
    mainWindowHandle: input.mainWindowHandle,
    platform: input.platform,
    tabId: tabIds[2]!,
    tabName: sourceRoles[2]!.name
  });
  await selectVisibleTabMenuAction({
    action: "moveToNewWindow",
    mainWindowHandle: input.mainWindowHandle,
    platform: input.platform,
    tabId: tabIds[2]!,
    tabName: sourceRoles[2]!.name
  });
  const detachedWindow = await findWindowOwningTab(
    tabIds[2]!,
    [gameWindow.id, targetWindow.id]
  );
  expect(detachedWindow.id).not.toBe(gameWindow.id);
  expect(detachedWindow.id).not.toBe(targetWindow.id);
  await Promise.all([
    waitForExactWindowTopology({
      activeTabId: tabIds[0]!,
      orderedTabIds: [tabIds[0]!],
      windowId: gameWindow.id
    }),
    waitForExactWindowTopology({
      activeTabId: tabIds[2]!,
      orderedTabIds: [tabIds[2]!],
      windowId: detachedWindow.id
    })
  ]);
  await recordTopology({
    platform: input.platform,
    roles,
    stage: "detached-with-successor"
  });

  await selectVisibleTabMenuAction({
    action: "hide",
    mainWindowHandle: input.mainWindowHandle,
    platform: input.platform,
    tabId: tabIds[1]!,
    tabName: sourceRoles[1]!.name
  });
  await waitForExactWindowTopology({
    activeTabId: targetTabId,
    hiddenTabIds: [tabIds[1]!],
    orderedTabIds: [targetTabId, tabIds[1]!],
    windowId: targetWindow.id
  });
  await recordTopology({
    platform: input.platform,
    roles,
    stage: "hidden"
  });
  await revealRoleThroughVisibleUi(sourceRoles[1]!, tabIds[1]!);
  await waitForExactWindowTopology({
    activeTabId: tabIds[1]!,
    orderedTabIds: [targetTabId, tabIds[1]!],
    windowId: targetWindow.id
  });
  await recordTopology({
    platform: input.platform,
    roles,
    stage: "revealed"
  });
  expect(await runtimeTabShellErrors()).toEqual([]);

  for (const close of [
    { tabId: tabIds[0]!, tabName: sourceRoles[0]!.name, windowId: gameWindow.id },
    { tabId: tabIds[1]!, tabName: sourceRoles[1]!.name, windowId: targetWindow.id },
    { tabId: tabIds[2]!, tabName: sourceRoles[2]!.name, windowId: detachedWindow.id }
  ]) {
    await closeVisibleRuntimeWindow({
      ...input,
      tabId: close.tabId,
      tabName: close.tabName
    });
    await waitForDormantWindow(close.windowId);
  }
  await recordTopology({
    platform: input.platform,
    roles,
    stage: "seed-distributed-final"
  });
}

async function restartPhase(input: Readonly<{
  mainWindowHandle: string;
  platform: Platform;
}>): Promise<void> {
  await fixtureRequest("/api/reset", {});
  const [gameWindow, targetWindow, roles] = await Promise.all([
    findWindow(),
    findWindowByName(TARGET_WINDOW_NAME),
    findRoles()
  ]);
  const tabId = (name: string): string => {
    const matches = (gameWindow.tabs.concat(targetWindow.tabs)).filter(
      (tab) => tab.name === name
    );
    if (matches.length === 1) return matches[0]!.id;
    const all = topologyObservations;
    throw new Error(`Expected one persisted ${name} tab; observed ${all.length}`);
  };
  const alphaId = tabId(ROLE_DEFINITIONS[0].name);
  const betaId = tabId(ROLE_DEFINITIONS[1].name);
  const deltaId = tabId(ROLE_DEFINITIONS[3].name);
  const detachedWindow = (await rendererCall("listGameWindows")).find(
    (window) => window.tabs.some((tab) => tab.name === ROLE_DEFINITIONS[2].name)
  );
  if (!detachedWindow) throw new Error("The detached Chromium tab window did not persist");
  const gammaId = detachedWindow.tabs.find(
    (tab) => tab.name === ROLE_DEFINITIONS[2].name
  )!.id;
  for (const window of [gameWindow, targetWindow, detachedWindow]) {
    await showSavedWindow({
      activeTabId: window.activeTabId!,
      gameWindow: window,
      orderedTabIds: window.tabs.map((tab) => tab.id)
    });
  }
  await recordTopology({
    platform: input.platform,
    roles,
    stage: "restart-distributed"
  });

  await selectVisibleTabMenuAction({
    action: "move",
    mainWindowHandle: input.mainWindowHandle,
    platform: input.platform,
    tabId: gammaId,
    tabName: ROLE_DEFINITIONS[2].name,
    targetWindow: gameWindow
  });
  await waitForExactWindowTopology({
    activeTabId: gammaId,
    orderedTabIds: [alphaId, gammaId],
    windowId: gameWindow.id
  });
  await selectVisibleTabMenuAction({
    action: "move",
    mainWindowHandle: input.mainWindowHandle,
    platform: input.platform,
    tabId: betaId,
    tabName: ROLE_DEFINITIONS[1].name,
    targetWindow: gameWindow
  });
  await Promise.all([
    waitForExactWindowTopology({
      activeTabId: betaId,
      orderedTabIds: [alphaId, gammaId, betaId],
      windowId: gameWindow.id
    }),
    waitForExactWindowTopology({
      activeTabId: deltaId,
      orderedTabIds: [deltaId],
      windowId: targetWindow.id
    })
  ]);
  await dragVisibleTabBefore({
    beforeTabId: alphaId,
    beforeTabName: ROLE_DEFINITIONS[0].name,
    mainWindowHandle: input.mainWindowHandle,
    platform: input.platform,
    tabId: gammaId,
    tabName: ROLE_DEFINITIONS[2].name,
    windowId: gameWindow.id
  });
  const consolidatedIds = [gammaId, alphaId, betaId];
  const consolidatedRoles = [roles[2]!, roles[0]!, roles[1]!];
  await waitForExactWindowTopology({
    activeTabId: gammaId,
    orderedTabIds: consolidatedIds,
    windowId: gameWindow.id
  });
  await activateAndFocusEveryTab({
    gameWindow,
    mainWindowHandle: input.mainWindowHandle,
    orderedTabIds: consolidatedIds,
    platform: input.platform,
    roles: consolidatedRoles
  });
  await recordTopology({
    platform: input.platform,
    roles,
    stage: "restart-consolidated"
  });
  expect(await runtimeTabShellErrors()).toEqual([]);
  await closeVisibleRuntimeWindow({
    ...input,
    tabId: betaId,
    tabName: ROLE_DEFINITIONS[1].name
  });
  await waitForDormantWindow(gameWindow.id);
  await closeVisibleRuntimeWindow({
    ...input,
    tabId: deltaId,
    tabName: ROLE_DEFINITIONS[3].name
  });
  await waitForDormantWindow(targetWindow.id);
}

describe("Chromium native tab lifecycle parity", () => {
  it("keeps exact visible, dormant, ordered, and generation-fenced native tabs", async () => {
    const probe = await electronDesktopE2eProbe();
    expect(probe.runtimeTarget).toBe(required("RION_STUDIO_E2E_RUNTIME_TARGET"));
    await ensureEnglishUi();
    await acceptLegalAndSkipFirstRun();
    await installRuntimeTabShellErrorJournal();
    const mainWindowHandle = await browser.getWindowHandle();
    const phase = required("RION_STUDIO_E2E_PHASE");
    const input = { mainWindowHandle, platform: probe.platform };
    if (phase === "chromium-tabs-visible-seed") await seedPhase(input);
    else if (phase === "chromium-tabs-visible-restart") await restartPhase(input);
    else throw new Error(`Unexpected Chromium tabs phase ${phase}`);
  });
});
