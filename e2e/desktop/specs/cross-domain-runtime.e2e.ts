import { $, browser, expect } from "@wdio/globals";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type {
  EmbeddedRuntimeState,
  Game,
  GameWindow,
  LaunchWorkspace,
  Macro,
  Role
} from "../../../src/shared/types";
import {
  controlWindow,
  detachTerminatedApplicationSession,
  inputDiagnostics,
  probe,
  rendererCall,
  requireEnvironment,
  runtimeUiAction,
  runtimeUiActionAndWaitEvent,
  shutdown,
  submitWindowControl,
  waitEvent,
  windowSnapshot,
  type DesktopE2eEvent,
  type DesktopE2eWindowSnapshot
} from "../support/control";
import {
  fixtureCursor,
  fixtureRequest,
  fixtureState,
  waitFixtureEvent,
  type FixtureEvent
} from "../support/fixture";
import {
  requiresNativeDeminimizeFocusFence,
  requiresPrearmedNativeTabMenuSelection,
  requiresRendererTabChromeProjection
} from "../support/platform";
import { forceTerminateProcessTree } from "../support/process";
import {
  installRendererEventJournal,
  rendererEventCursor,
  waitForMacroProjection,
  waitForRoleProjection,
  waitForRuntimeProjection
} from "../support/renderer-events";
import { waitForTranscriptEvent } from "../support/transcript";
import { acceptLegalAndSkipFirstRun, ensureEnglishUi, navigate } from "../support/ui";

// [journey:RUNTIME-LAUNCH-DESTINATIONS-008]
// [journey:RUNTIME-TAB-TOPOLOGY-009]
// [journey:MACRO-OWNERSHIP-TRANSFER-010]
// [journey:RUNTIME-MIXED-RECOVERY-011]
// [state-combination:ROLE-WORKSPACE-DESTINATION-MATRIX-003]
// [state-combination:MIXED-TAB-MUTATION-MACRO-004]
// [state-combination:SHARED-ROLE-CLAIM-FAILURE-005]
// [state-combination:MIXED-TOPOLOGY-CRASH-RECOVERY-006]

const PREFIX = "E2E Cross Domain";
const WINDOW_A = "c0d00000-0000-4000-8000-00000000000a";
const WINDOW_B = "c0d00000-0000-4000-8000-00000000000b";
const FIXTURE_IDS = ["cross-a", "cross-shared", "cross-c", "cross-d"] as const;
const WEB_ONLY_FIXTURE_ID = "cross-web-only";
const WEB_ONLY_WORKSPACE_NAME = `${PREFIX} Web Only Workspace`;

interface Scenario {
  game: Game;
  macros: [Macro, Macro];
  roles: [Role, Role, Role, Role];
  windows: [GameWindow, GameWindow];
  workspaces: [LaunchWorkspace, LaunchWorkspace];
}

function requireNamed<T extends { name: string }>(items: T[], name: string): T {
  const item = items.find((candidate) => candidate.name === name);
  if (!item) throw new Error(`Cross-domain fixture ${name} is unavailable`);
  return item;
}

async function bootstrap(resetFixture: boolean): Promise<void> {
  await ensureEnglishUi();
  await acceptLegalAndSkipFirstRun();
  await installRendererEventJournal();
  if (resetFixture) await fixtureRequest("/api/reset", {});
  const preferences = await rendererCall("getRuntimeWindowPreferences");
  if (!preferences.restoreGameWindowsOnStartup) {
    await rendererCall("updateRuntimeWindowPreferences", {
      ...preferences,
      restoreGameWindowsOnStartup: true
    });
  }
}

async function createScenario(): Promise<Scenario> {
  const origin = requireEnvironment("RION_STUDIO_E2E_FIXTURE_ORIGIN");
  const displayTopology = await rendererCall("getDisplayTopology");
  const display = displayTopology.displays.find((candidate) => candidate.isPrimary)
    ?? displayTopology.displays[0];
  if (!display) throw new Error("Cross-domain E2E requires one physical display");
  const width = Math.max(500, Math.min(620, Math.floor((display.workArea.width - 80) / 2)));
  const height = Math.max(460, Math.min(620, display.workArea.height - 120));
  const boundsA = {
    height,
    width,
    x: display.workArea.x + 20,
    y: display.workArea.y + 45
  };
  const boundsB = {
    height,
    width,
    x: display.workArea.x + display.workArea.width - width - 20,
    y: display.workArea.y + 45
  };
  const game = await rendererCall("createGame", {
    defaultLaunchUrl: `${origin}/role/${FIXTURE_IDS[0]}`,
    name: `${PREFIX} Game`
  });
  const createdRoles = [] as Role[];
  for (const [index, fixtureId] of FIXTURE_IDS.entries()) {
    createdRoles.push(await rendererCall("createRole", {
      gameId: game.id,
      launchUrl: `${origin}/role/${fixtureId}?mode=seed&marker=${fixtureId}`,
      name: `${PREFIX} Role ${index + 1}`
    }));
  }
  const roles = createdRoles as Scenario["roles"];
  const workspaceA = await rendererCall("createLaunchWorkspace", {
    name: `${PREFIX} Workspace A`,
    slots: roles.slice(0, 3).map((role) => ({ roleId: role.id })),
    template: "three_columns"
  });
  const workspaceB = await rendererCall("createLaunchWorkspace", {
    name: `${PREFIX} Workspace B`,
    slots: roles.slice(1, 4).map((role) => ({ roleId: role.id })),
    template: "three_columns"
  });
  const singleMacro = await rendererCall("createMacro", {
    activationMode: "toggle",
    enabled: true,
    name: `${PREFIX} Macro Single`,
    repeat: { type: "once" },
    roleIds: [roles[0].id],
    steps: [{ action: "tap", code: "KeyS", id: "cross-single", type: "key" }]
  });
  const sharedMacro = await rendererCall("createMacro", {
    activationMode: "toggle",
    enabled: true,
    name: `${PREFIX} Macro Shared`,
    repeat: { intervalMs: 140, type: "loop" },
    roleIds: [roles[1].id, roles[2].id],
    steps: [{ action: "tap", code: "KeyX", id: "cross-shared", type: "key" }]
  });
  const windowA = await rendererCall("createGameWindow", {
    id: WINDOW_A,
    name: `${PREFIX} Window A`,
    placement: {
      normalBounds: boundsA,
      presentation: "normal",
      savedWorkArea: display.workArea
    },
    targetDisplay: { id: display.id }
  });
  const windowB = await rendererCall("createGameWindow", {
    id: WINDOW_B,
    name: `${PREFIX} Window B`,
    placement: {
      normalBounds: boundsB,
      presentation: "normal",
      savedWorkArea: display.workArea
    },
    targetDisplay: { id: display.id }
  });
  return {
    game,
    macros: [singleMacro, sharedMacro],
    roles,
    windows: [windowA, windowB],
    workspaces: [workspaceA, workspaceB]
  };
}

async function readScenario(): Promise<Scenario> {
  const roles = await rendererCall("listRoles");
  return {
    game: requireNamed(await rendererCall("listGames"), `${PREFIX} Game`),
    macros: [
      requireNamed(await rendererCall("listMacros"), `${PREFIX} Macro Single`),
      requireNamed(await rendererCall("listMacros"), `${PREFIX} Macro Shared`)
    ],
    roles: [1, 2, 3, 4].map((index) =>
      requireNamed(roles, `${PREFIX} Role ${index}`)) as Scenario["roles"],
    windows: [
      requireNamed(await rendererCall("listGameWindows"), `${PREFIX} Window A`),
      requireNamed(await rendererCall("listGameWindows"), `${PREFIX} Window B`)
    ],
    workspaces: [
      requireNamed(await rendererCall("listLaunchWorkspaces"), `${PREFIX} Workspace A`),
      requireNamed(await rendererCall("listLaunchWorkspaces"), `${PREFIX} Workspace B`)
    ]
  };
}

async function loadScenario(): Promise<Scenario> {
  return readScenario();
}

async function showSavedWindow(windowId: string): Promise<DesktopE2eWindowSnapshot> {
  const existing = await windowSnapshot(windowId).catch(() => undefined);
  if (existing) return existing;
  const runtime = await rendererCall("getEmbeddedRuntimeState");
  if (runtime.windows.some((candidate) => candidate.windowId === windowId)) {
    await waitEvent({
      afterSequence: 0,
      kind: "window-context-initialized",
      windowId
    });
    return windowSnapshot(windowId);
  }
  await navigate("/game-windows");
  const cursor = (await probe()).latestSequence;
  await $(`[data-selection-id='${windowId}'] button[aria-label='Show']`).click();
  const context = await waitEvent({
    afterSequence: cursor,
    kind: "window-context-initialized",
    windowId
  });
  if (requiresRendererTabChromeProjection(process.platform)) {
    await waitEvent({
      afterSequence: cursor,
      kind: "runtime-tab-chrome-projection-applied",
      minimumGeneration: context.generation,
      timeoutMs: 45_000,
      windowId
    });
  }
  return windowSnapshot(windowId);
}

async function visibleDestinationLaunch(input: {
  destinationTestId: string;
  id: string;
  sourceLabel: string;
  sourceType: "role" | "workspace";
}): Promise<EmbeddedRuntimeState> {
  await navigate("/dashboard");
  const control = await probe();
  const cursor = await rendererEventCursor();
  await $("[data-testid='quick-access-trigger']").click();
  const palette = await $("[data-testid='quick-access-palette'][open]");
  await palette.waitForExist({ timeout: 10_000 });
  await palette.$("input[role='combobox']").setValue(input.sourceLabel);
  const option = await $(`#quick-access-option-${input.sourceType}-${input.id}`);
  await option.waitForDisplayed({ timeout: 10_000 });
  const openIn = await $(
    `[data-testid='quick-access-destination-${input.sourceType}-${input.id}']`
  );
  await openIn.waitForClickable({ timeout: 10_000 });
  await openIn.click();
  const destination = await $(`[data-testid='${input.destinationTestId}']`);
  await destination.waitForClickable({ timeout: 10_000 });
  await destination.click();
  await waitForRuntimeLaunchTerminal(control, input.id, input.sourceType);
  return waitForRuntimeProjection({ afterSequence: cursor, sourceId: input.id });
}

async function waitForRuntimeLaunchTerminal(
  control: Awaited<ReturnType<typeof probe>>,
  sourceId: string,
  sourceType: "role" | "workspace"
): Promise<void> {
  const terminal = await waitEvent({
    afterSequence: control.latestSequence,
    kind: "runtime-launch-intent-terminal",
    timeoutMs: 55_000
  });
  expect(terminal.details).toMatchObject({
    sourceId,
    sourceType,
    status: "applied"
  });
}

async function shutdownAndWaitForFlush(): Promise<void> {
  const control = await probe();
  const requestedAfter = new Date().toISOString();
  await shutdown().catch(() => undefined);
  const terminal = await waitForTranscriptEvent(
    control.transcriptPath,
    (candidate) => candidate.kind === "application-shutdown-terminal"
      && candidate.timestamp >= requestedAfter
  );
  expect((terminal.details as { status?: string }).status).toBe("applied");
  const event = await waitForTranscriptEvent(
    control.transcriptPath,
    (candidate) => candidate.kind === "application-final-flush-complete"
      && candidate.timestamp >= requestedAfter
  );
  expect((event.details as { complete?: boolean }).complete).toBe(true);
  detachTerminatedApplicationSession();
}

async function waitForActiveTabsReady(): Promise<void> {
  const runtime = await rendererCall("getEmbeddedRuntimeState");
  for (const runtimeWindow of runtime.windows) {
    let snapshot = await windowSnapshot(runtimeWindow.windowId);
    const selectedTabId = snapshot.kernel?.selectedTabId;
    if (!selectedTabId) continue;
    const selected = snapshot.kernel?.tabs.find((tab) => tab.tabId === selectedTabId);
    if (selected?.launchPhase === "ready") continue;
    const cursor = (await probe()).latestSequence;
    snapshot = await windowSnapshot(runtimeWindow.windowId);
    if (snapshot.kernel?.tabs.find((tab) => tab.tabId === selectedTabId)?.launchPhase === "ready") {
      continue;
    }
    await waitEvent({
      afterSequence: cursor,
      kind: `tab-launch-phase:${selectedTabId}:ready`,
      windowId: runtimeWindow.windowId
    });
    snapshot = await windowSnapshot(runtimeWindow.windowId);
    expect(snapshot.kernel?.tabs.find((tab) => tab.tabId === selectedTabId)?.launchPhase)
      .toBe("ready");
  }
}

async function exerciseWebOnlyWorkspaceDestinations(
  liveWindow: GameWindow,
  dormantWindow: GameWindow
): Promise<void> {
  const origin = requireEnvironment("RION_STUDIO_E2E_FIXTURE_ORIGIN");
  const workspace = await rendererCall("createLaunchWorkspace", {
    name: WEB_ONLY_WORKSPACE_NAME,
    slots: [{
      web: {
        name: "Cross-domain Web App",
        startUrl: `${origin}/role/${WEB_ONLY_FIXTURE_ID}?mode=seed&marker=${WEB_ONLY_FIXTURE_ID}`
      }
    }],
    template: "single"
  });
  let currentTab: EmbeddedRuntimeState["tabs"][number] | undefined;

  const launchAndAssert = async (
    destinationTestId: string,
    expectedWindowId?: string
  ): Promise<EmbeddedRuntimeState["tabs"][number]> => {
    const controlCursor = (await probe()).latestSequence;
    const sessionCursor = await fixtureCursor();
    const launched = await visibleDestinationLaunch({
      destinationTestId,
      id: workspace.id,
      sourceLabel: workspace.name,
      sourceType: "workspace"
    });
    const tab = launched.tabs.find((candidate) => candidate.sourceId === workspace.id);
    if (!tab) throw new Error("The Web-only destination launch did not create a runtime tab");
    if (expectedWindowId) expect(tab.windowId).toBe(expectedWindowId);
    expect(tab.roleIds).toEqual([]);
    expect(tab.slots).toEqual([]);
    const firstSnapshot = await windowSnapshot(tab.windowId);
    if (firstSnapshot.kernel?.tabs.find((candidate) => candidate.tabId === tab.id)
      ?.launchPhase !== "ready") {
      await waitEvent({
        afterSequence: controlCursor,
        kind: `tab-launch-phase:${tab.id}:ready`,
        timeoutMs: 55_000,
        windowId: tab.windowId
      });
    }
    await waitFixtureEvent({
      afterSequence: sessionCursor,
      kind: "session",
      roleId: WEB_ONLY_FIXTURE_ID
    });
    const ready = await windowSnapshot(tab.windowId);
    const kernelTab = ready.kernel?.tabs.find((candidate) => candidate.tabId === tab.id);
    expect(kernelTab?.workspaceSlots.filter((slot) => slot.roleId !== undefined)).toEqual([]);
    expect(kernelTab?.workspaceSlots.filter((slot) => slot.web !== undefined)).toEqual([
      expect.objectContaining({ web: workspace.slots[0]?.web })
    ]);
    if (expectedWindowId) {
      const persistedTab = (await rendererCall("listGameWindows"))
        .find((candidate) => candidate.id === expectedWindowId)
        ?.tabs.find((candidate) => candidate.id === tab.id);
      expect(persistedTab?.roleSlots).toEqual([]);
      expect(persistedTab?.workspaceSlots).toEqual(workspace.slots);
    }
    const webview = ready.native.roleWebviews?.find(
      (surface) => surface.url?.includes(`/role/${WEB_ONLY_FIXTURE_ID}`)
    );
    const content = ready.native.roleSurfaces?.find(
      (surface) => surface.roleId === webview?.roleId
    );
    const chrome = ready.native.workspaceWebChromeSurfaces?.find(
      (surface) => surface.roleId === webview?.roleId
    );
    if (!webview || !content || !chrome) {
      throw new Error("The Web-only destination lost its content or chrome surface");
    }
    if (process.platform === "win32") {
      expect(content.controllerVisible).toBe(true);
      expect(content.parentWindowMatchesHost).toBe(true);
    }
    expect(chrome.visible).toBe(true);
    expect(Math.abs(chrome.bounds.width - content.hostBounds.width)).toBeLessThanOrEqual(1);
    expect((await rendererCall("listRoleStatuses"))
      .some((status) => status.roleId === webview.roleId)).toBe(false);
    return tab;
  };

  const closeCurrentTab = async (): Promise<void> => {
    if (!currentTab) return;
    const cursor = await rendererEventCursor();
    await rendererCall("stopGameWindowTab", currentTab.id);
    await waitForRuntimeProjection({
      absent: true,
      afterSequence: cursor,
      sourceId: workspace.id
    });
    currentTab = undefined;
  };

  try {
    currentTab = await launchAndAssert("quick-access-destination-option-new-window");
    expect([liveWindow.id, dormantWindow.id]).not.toContain(currentTab.windowId);
    await closeCurrentTab();

    currentTab = await launchAndAssert(
      `quick-access-destination-option-window-${liveWindow.id}`,
      liveWindow.id
    );
    await closeCurrentTab();

    const beforeDormantLaunch = await rendererCall("getEmbeddedRuntimeState");
    expect(beforeDormantLaunch.windows.some(
      (candidate) => candidate.windowId === dormantWindow.id
    )).toBe(false);
    expect((await rendererCall("listGameWindows")).find(
      (candidate) => candidate.id === dormantWindow.id
    )?.tabs).toEqual([]);
    currentTab = await launchAndAssert(
      `quick-access-destination-option-window-${dormantWindow.id}`,
      dormantWindow.id
    );

    const beforeDuplicate = await rendererCall("getEmbeddedRuntimeState");
    const duplicateControl = await probe();
    await navigate("/dashboard");
    await $("[data-testid='quick-access-trigger']").click();
    const duplicatePalette = await $("[data-testid='quick-access-palette'][open]");
    await duplicatePalette.$("input[role='combobox']").setValue(workspace.name);
    await $(`#quick-access-option-workspace-${workspace.id}`).click();
    await waitForRuntimeLaunchTerminal(duplicateControl, workspace.id, "workspace");
    const duplicate = await rendererCall("getEmbeddedRuntimeState");
    expect(duplicate.tabs.filter((candidate) => candidate.sourceId === workspace.id))
      .toEqual([expect.objectContaining({
        id: currentTab.id,
        windowId: dormantWindow.id
      })]);
    expect(duplicate.tabs).toHaveLength(beforeDuplicate.tabs.length);
    await closeCurrentTab();

    const afterClose = await rendererCall("getEmbeddedRuntimeState");
    if (afterClose.windows.some((candidate) => candidate.windowId === dormantWindow.id)) {
      const stopCursor = (await probe()).latestSequence;
      await rendererCall("stopGameWindow", dormantWindow.id);
      await waitEvent({
        afterSequence: stopCursor,
        kind: "window-destroyed",
        timeoutMs: 55_000,
        windowId: dormantWindow.id
      });
    }
  } finally {
    const stillRunning = (await rendererCall("getEmbeddedRuntimeState")).tabs
      .find((candidate) => candidate.sourceId === workspace.id);
    if (stillRunning) {
      const cursor = await rendererEventCursor();
      await rendererCall("stopGameWindowTab", stillRunning.id);
      await waitForRuntimeProjection({
        absent: true,
        afterSequence: cursor,
        sourceId: workspace.id
      });
    }
    await rendererCall("deleteLaunchWorkspace", workspace.id);
  }
}

async function seedPhase(): Promise<void> {
  await bootstrap(true);
  const scenario = await createScenario();
  await showSavedWindow(WINDOW_A);
  await visibleDestinationLaunch({
    destinationTestId: "quick-access-destination-option-new-window",
    id: scenario.roles[0].id,
    sourceLabel: scenario.roles[0].name,
    sourceType: "role"
  });
  await visibleDestinationLaunch({
    destinationTestId: `quick-access-destination-option-window-${scenario.windows[0].id}`,
    id: scenario.roles[1].id,
    sourceLabel: scenario.roles[1].name,
    sourceType: "role"
  });
  await exerciseWebOnlyWorkspaceDestinations(scenario.windows[0], scenario.windows[1]);
  await visibleDestinationLaunch({
    destinationTestId: `quick-access-destination-option-window-${scenario.windows[1].id}`,
    id: scenario.workspaces[0].id,
    sourceLabel: scenario.workspaces[0].name,
    sourceType: "workspace"
  });
  await visibleDestinationLaunch({
    destinationTestId: `quick-access-destination-option-window-${scenario.windows[0].id}`,
    id: scenario.workspaces[1].id,
    sourceLabel: scenario.workspaces[1].name,
    sourceType: "workspace"
  });

  const beforeDuplicate = await rendererCall("getEmbeddedRuntimeState");
  await navigate("/dashboard");
  const duplicateControl = await probe();
  const duplicateCursor = await rendererEventCursor();
  await $("[data-testid='quick-access-trigger']").click();
  const duplicatePalette = await $("[data-testid='quick-access-palette'][open]");
  await duplicatePalette.$("input[role='combobox']").setValue(scenario.roles[1].name);
  await $(`#quick-access-option-role-${scenario.roles[1].id}`).click();
  await waitForRuntimeLaunchTerminal(duplicateControl, scenario.roles[1].id, "role");
  const afterDuplicate = await waitForRuntimeProjection({
    afterSequence: duplicateCursor,
    sourceId: scenario.roles[1].id
  });
  expect(afterDuplicate.tabs.filter((tab) => tab.sourceId === scenario.roles[1].id)).toHaveLength(1);
  expect(afterDuplicate.tabs).toHaveLength(beforeDuplicate.tabs.length);
  const ownerIds = afterDuplicate.tabs.flatMap((tab) =>
    tab.slots.filter((slot) => slot.roleId === scenario.roles[1].id && slot.owner?.tabId === tab.id)
  );
  expect(ownerIds).toHaveLength(1);
  await waitForActiveTabsReady();
  await shutdownAndWaitForFlush();
}

async function startSharedMacro(macro: Macro): Promise<number> {
  await navigate("/macros");
  const cursor = await rendererEventCursor();
  const start = await $(`[data-selection-id='${macro.id}'] button[aria-label='Start']`);
  await start.waitForEnabled({ timeout: 20_000 });
  await start.click();
  await waitForMacroProjection({
    afterSequence: cursor,
    macroId: macro.id,
    minimumIteration: 1,
    roleIds: macro.roleIds,
    state: "running"
  });
  return cursor;
}

async function selectRuntimeTabForRoleSlot(
  tab: EmbeddedRuntimeState["tabs"][number],
  roleId: string
): Promise<DesktopE2eWindowSnapshot> {
  let targetWindow = await windowSnapshot(tab.windowId);
  if (targetWindow.kernel?.selectedTabId !== tab.id) {
    const activationCursor = (await probe()).latestSequence;
    await runtimeUiAction(tab.windowId, {
      action: "activateTab",
      tabId: tab.id,
      windowGeneration: targetWindow.windowGeneration
    });
    const terminal = await waitEvent({
      afterSequence: activationCursor,
      kind: "runtime-tab-activation-terminal",
      windowId: tab.windowId
    });
    expect(terminal.details).toMatchObject({ status: "completed", tabId: tab.id });
    targetWindow = await windowSnapshot(tab.windowId);
    expect(targetWindow.kernel?.selectedTabId).toBe(tab.id);
  }
  const control = await probe();
  await waitForTranscriptEvent(
    control.transcriptPath,
    (event) => event.kind === `role-placeholder-ready:${tab.id}:${roleId}`
      && event.windowId === tab.windowId
  );
  return targetWindow;
}

async function claimSharedRoleAndAssertMacroContinuity(
  scenario: Scenario,
  macroCursor: number
): Promise<void> {
  const sharedRole = scenario.roles[1];
  const runtime = await rendererCall("getEmbeddedRuntimeState");
  const selectedTabIds = new Set((await Promise.all(runtime.windows.map(async (runtimeWindow) =>
    (await windowSnapshot(runtimeWindow.windowId)).kernel?.selectedTabId
  ))).filter((tabId): tabId is string => Boolean(tabId)));
  const blockedOccurrences = runtime.tabs.filter((tab) =>
    tab.slots.some((slot) => slot.roleId === sharedRole.id && slot.state === "blocked")
  );
  const target = blockedOccurrences.find((tab) => selectedTabIds.has(tab.id))
    ?? blockedOccurrences[0];
  if (!target) throw new Error("A blocked shared-role occurrence is required for takeover");
  const targetWindow = await selectRuntimeTabForRoleSlot(target, sharedRole.id);
  const projectionCursor = await rendererEventCursor();
  const sessionCursor = await fixtureCursor();
  await runtimeUiAction(target.windowId, {
    action: "pressRoleSlot",
    roleId: sharedRole.id,
    tabId: target.id,
    windowGeneration: targetWindow.windowGeneration
  });
  const occurrences = runtime.tabs
    .filter((tab) => tab.slots.some((slot) => slot.roleId === sharedRole.id))
    .map((tab) => ({
      ownedByTargetTab: tab.id === target.id,
      ownerTabId: tab.id === target.id ? undefined : target.id,
      roleId: sharedRole.id,
      state: tab.id === target.id ? "running" as const : "blocked" as const,
      tabId: tab.id
    }));
  await Promise.all([
    waitForRuntimeProjection({ afterSequence: projectionCursor, roleSlots: occurrences }),
    waitFixtureEvent({
      afterSequence: sessionCursor,
      kind: "session",
      roleId: FIXTURE_IDS[1]
    })
  ]);

  const beforeInput = await fixtureState();
  const inputCursor = await fixtureCursor();
  await Promise.all(scenario.macros[1].roleIds.map((roleId) => {
    const fixtureRoleId = roleId === scenario.roles[1].id ? FIXTURE_IDS[1] : FIXTURE_IDS[2];
    return waitFixtureEvent({ afterSequence: inputCursor, kind: "keydown", roleId: fixtureRoleId });
  }));
  const afterInput = await fixtureState();
  for (const fixtureRoleId of [FIXTURE_IDS[0], FIXTURE_IDS[3]]) {
    expect(afterInput[fixtureRoleId]?.keydown ?? 0).toBe(beforeInput[fixtureRoleId]?.keydown ?? 0);
  }
  await waitForMacroProjection({
    afterSequence: macroCursor,
    macroId: scenario.macros[1].id,
    minimumIteration: 2,
    roleIds: scenario.macros[1].roleIds,
    state: "running"
  });
}

async function waitForMutationReceipt(
  afterSequence: number,
  tabId: string
): Promise<DesktopE2eEvent> {
  const terminal = await waitEvent({
    afterSequence,
    kind: "runtime-operation-terminal",
    timeoutMs: 55_000
  });
  expect(terminal.details).toMatchObject({ status: "applied", tabId });
  return terminal;
}

async function dragTab(
  source: DesktopE2eWindowSnapshot,
  tabId: string,
  target: DesktopE2eWindowSnapshot,
  beforeTabId: string
): Promise<void> {
  const cursor = (await probe()).latestSequence;
  const terminal = await runtimeUiActionAndWaitEvent(
    source.windowId,
    {
      action: "dragTab",
      beforeTabId,
      tabId,
      targetWindowGeneration: target.windowGeneration,
      targetWindowId: target.windowId,
      topologyRevision: source.kernel?.revision ?? 0,
      windowGeneration: source.windowGeneration
    },
    {
      afterSequence: cursor,
      kind: "runtime-operation-terminal",
      timeoutMs: 55_000
    }
  );
  expect(terminal.details).toMatchObject({ status: "applied", tabId });
}

async function tabMenuAction(input: {
  action: "hide" | "move" | "moveToNewWindow";
  snapshot: DesktopE2eWindowSnapshot;
  tabId: string;
  target?: DesktopE2eWindowSnapshot;
}): Promise<DesktopE2eEvent> {
  const target = input.target
    ? await windowSnapshot(input.target.windowId)
    : undefined;
  const openCursor = (await probe()).latestSequence;
  const source = await windowSnapshot(input.snapshot.windowId);
  const fencedTab = source.kernel?.tabs.find((tab) => tab.tabId === input.tabId && !tab.hidden);
  if (!fencedTab) throw new Error("The native tab menu target is no longer visible");
  const prearmSelection = requiresPrearmedNativeTabMenuSelection(process.platform);
  if (prearmSelection) {
    // Native popup menus own synchronous modal tracking loops. Arm the exact
    // platform menu-start observer first so real keyboard input is submitted
    // only after the menu is visible, without re-entering the blocked IPC lane.
    await runtimeUiAction(source.windowId, {
      action: "selectTabMenuItem",
      menuAction: input.action,
      tabId: input.tabId,
      targetWindowGeneration: target?.windowGeneration,
      targetWindowId: target?.windowId,
      topologyRevision: source.kernel?.revision ?? 0,
      windowGeneration: source.windowGeneration
    });
  }
  await runtimeUiAction(source.windowId, {
    action: "openTabMenu",
    tabId: input.tabId,
    topologyRevision: source.kernel?.revision ?? 0,
    windowGeneration: source.windowGeneration
  });
  await waitEvent({
    afterSequence: openCursor,
    kind: "runtime-tab-menu-opened",
    windowId: source.windowId
  });
  if (prearmSelection) {
    if (process.platform === "win32") {
      const inputTerminal = await waitEvent({
        afterSequence: openCursor,
        kind: "runtime-tab-menu-input-terminal",
        windowId: source.windowId
      });
      expect(inputTerminal.details).toMatchObject({ action: input.action, status: "applied" });
    }
    return waitForMutationReceipt(openCursor, input.tabId);
  }
  const receiptCursor = (await probe()).latestSequence;
  await runtimeUiAction(source.windowId, {
    action: "selectTabMenuItem",
    menuAction: input.action,
    tabId: input.tabId,
    targetWindowGeneration: target?.windowGeneration,
    targetWindowId: target?.windowId,
    topologyRevision: source.kernel?.revision ?? 0,
    windowGeneration: source.windowGeneration
  });
  return waitForMutationReceipt(receiptCursor, input.tabId);
}

async function showSourceFromVisibleUi(tab: EmbeddedRuntimeState["tabs"][number]): Promise<void> {
  await navigate(tab.type === "role" ? "/roles" : "/workspaces");
  const control = await probe();
  const beforeLaunch = await rendererCall("getEmbeddedRuntimeState");
  const hiddenBeforeLaunch = beforeLaunch.tabs.find((candidate) => candidate.id === tab.id)?.hidden
    === true;
  const projectionCursor = hiddenBeforeLaunch ? await rendererEventCursor() : undefined;
  const label = tab.type === "role" ? "Open" : "Open workspace";
  await $(`[data-selection-id='${tab.sourceId}'] button[aria-label='${label}']`).click();
  await waitForRuntimeLaunchTerminal(control, tab.sourceId, tab.type);
  const projected = projectionCursor === undefined
    ? await rendererCall("getEmbeddedRuntimeState")
    : await waitForRuntimeProjection({
        afterSequence: projectionCursor,
        hidden: false,
        tabId: tab.id
      });
  expect(projected.tabs.find((candidate) => candidate.id === tab.id)?.hidden).toBe(false);
}

async function forceTerminateCurrentProcess(): Promise<void> {
  const control = await probe();
  const markerPath = resolve(
    requireEnvironment("RION_STUDIO_E2E_ARTIFACT_DIR"),
    "forced-termination.json"
  );
  await writeFile(markerPath, `${JSON.stringify({
    pid: control.pid,
    requestedAt: new Date().toISOString(),
    sessionId: control.sessionId
  }, null, 2)}\n`);
  await forceTerminateProcessTree(control.pid);
  detachTerminatedApplicationSession();
}

async function topologyForcePhase(): Promise<void> {
  await bootstrap(true);
  const scenario = await loadScenario();
  await showSavedWindow(WINDOW_A);
  await showSavedWindow(WINDOW_B);
  await waitForActiveTabsReady();
  const macroCursor = await startSharedMacro(scenario.macros[1]);
  await claimSharedRoleAndAssertMacroContinuity(scenario, macroCursor);

  let liveA = await windowSnapshot(WINDOW_A);
  let liveB = await windowSnapshot(WINDOW_B);
  const visibleA = liveA.kernel?.tabs.filter((tab) => !tab.hidden) ?? [];
  const visibleB = liveB.kernel?.tabs.filter((tab) => !tab.hidden) ?? [];
  if (visibleA.length < 2 || visibleB.length < 1) {
    throw new Error("Cross-domain native mutation requires two source tabs and one target tab");
  }
  await dragTab(liveA, visibleA.at(-1)!.tabId, liveA, visibleA[0].tabId);
  await waitForActiveTabsReady();
  liveA = await windowSnapshot(WINDOW_A);
  liveB = await windowSnapshot(WINDOW_B);
  const moving = liveA.kernel?.tabs.find((tab) => !tab.hidden)?.tabId;
  const target = liveB.kernel?.tabs.find((tab) => !tab.hidden)?.tabId;
  if (!moving || !target) throw new Error("Cross-window move identities are unavailable");
  await tabMenuAction({ action: "move", snapshot: liveA, tabId: moving, target: liveB });

  await waitForActiveTabsReady();
  liveA = await windowSnapshot(WINDOW_A);
  const lastSourceTab = liveA.kernel?.tabs.find((tab) => !tab.hidden)?.tabId;
  if (!lastSourceTab) throw new Error("A final source tab is required for detach");
  const sourcePersistenceCursor = (await probe()).latestSequence;
  await tabMenuAction({
    action: "moveToNewWindow",
    snapshot: liveA,
    tabId: lastSourceTab
  });
  let sourcePersisted = await waitEvent({
    afterSequence: sourcePersistenceCursor,
    kind: "window-state-persisted",
    timeoutMs: 55_000,
    windowId: WINDOW_A
  });
  while ((sourcePersisted.details as { activeTabId?: string | null }).activeTabId !== null) {
    sourcePersisted = await waitEvent({
      afterSequence: sourcePersisted.sequence,
      kind: "window-state-persisted",
      timeoutMs: 55_000,
      windowId: WINDOW_A
    });
  }
  expect(sourcePersisted.details).toMatchObject({ activeTabId: null, status: "applied" });
  await waitForActiveTabsReady();
  const detached = (await rendererCall("getEmbeddedRuntimeState")).tabs.find((tab) =>
    tab.id === lastSourceTab && tab.windowId !== WINDOW_A
  );
  if (!detached) throw new Error("The last-tab detach destination is unavailable");
  const liveBBeforeMinimize = await windowSnapshot(WINDOW_B);
  const roleSurfacesBeforeMinimize = liveBBeforeMinimize.native.roleSurfaces;
  if (process.platform === "win32") {
    expect(roleSurfacesBeforeMinimize?.length ?? 0).toBeGreaterThan(0);
    expect(roleSurfacesBeforeMinimize?.every((surface) => surface.documentViewport)).toBe(true);
  }
  const detachedBeforeMove = await windowSnapshot(detached.windowId);
  const workArea = detachedBeforeMove.native.workArea;
  const detachedBounds = detachedBeforeMove.target.bounds;
  const movedDetached = await controlWindow(detached.windowId, {
    action: "moveResize",
    height: detachedBounds.height,
    scaleFactor: detachedBeforeMove.native.scaleFactor,
    width: detachedBounds.width,
    x: (workArea.x ?? 0) + 64,
    y: workArea.y ?? 0
  });
  if ("submitted" in movedDetached) {
    throw new Error("Detached window placement did not return native state");
  }
  const restoredAAtSavedPlacement = await showSavedWindow(WINDOW_A);
  const restoredA = await controlWindow(WINDOW_A, {
    action: "moveResize",
    height: restoredAAtSavedPlacement.target.bounds.height,
    scaleFactor: restoredAAtSavedPlacement.native.scaleFactor,
    width: restoredAAtSavedPlacement.target.bounds.width,
    x: (workArea.x ?? 0) + Math.max(0, workArea.width - restoredAAtSavedPlacement.target.bounds.width - 64),
    y: (workArea.y ?? 0) + Math.max(0, workArea.height - restoredAAtSavedPlacement.target.bounds.height - 64)
  });
  if ("submitted" in restoredA) throw new Error("Window A placement did not return native state");
  const sourceOuter = movedDetached.native.outerBounds;
  const destinationOuter = restoredA.native.outerBounds;
  const sourceLeft = sourceOuter.x ?? 0;
  const sourceTop = sourceOuter.y ?? 0;
  const destinationLeft = destinationOuter.x ?? 0;
  const destinationTop = destinationOuter.y ?? 0;
  const windowsAreDisjoint =
    sourceLeft >= destinationLeft + destinationOuter.width
      || destinationLeft >= sourceLeft + sourceOuter.width
      || sourceTop >= destinationTop + destinationOuter.height
      || destinationTop >= sourceTop + sourceOuter.height;
  const canSeparateAtRequestedAnchors =
    workArea.width >= sourceOuter.width + destinationOuter.width + 128
      || workArea.height >= sourceOuter.height + destinationOuter.height + 64;
  if (canSeparateAtRequestedAnchors) {
    expect(windowsAreDisjoint).toBe(true);
  } else {
    // Hosted macOS uses a 1024x677 work area, which cannot contain two runtime windows at their
    // native minimum size without overlap. Keep them on opposite horizontal anchors; the exact
    // foreground event fence below makes the source authoritative before the visible menu gesture.
    expect(destinationLeft).toBeGreaterThan(sourceLeft);
  }
  if (process.platform === "win32") {
    const focusCursor = (await probe()).latestSequence;
    await controlWindow(WINDOW_B, { action: "focus" });
    await waitEvent({
      afterSequence: focusCursor,
      kind: "window-focus-acknowledged",
      minimumGeneration: liveBBeforeMinimize.windowGeneration,
      windowId: WINDOW_B
    });
  }
  const minimizeSubmitted = await submitWindowControl(liveBBeforeMinimize, {
    action: process.platform === "win32" ? "clickVisibleMinimize" : "minimize"
  });
  if (process.platform === "win32") {
    const pointer = await waitEvent({
      afterSequence: minimizeSubmitted.sequence,
      kind: "visible-chrome-pointer-observed"
    });
    expect(pointer.details).toMatchObject({ targetId: "window-minimize" });
    await waitEvent({
      afterSequence: minimizeSubmitted.sequence,
      kind: "runtime-tab-window-control-received",
      windowId: WINDOW_B
    });
  }
  await waitEvent({
    afterSequence: minimizeSubmitted.sequence,
    kind: "window-minimized-observed",
    minimumGeneration: liveBBeforeMinimize.windowGeneration,
    timeoutMs: 45_000,
    windowId: WINDOW_B
  });
  const minimizedB = await windowSnapshot(WINDOW_B);
  expect(minimizedB.native.presentation).toBe("minimized");
  if (process.platform === "win32") {
    expect(minimizedB.native.roleSurfaces?.map((surface) => ({
      controllerBounds: surface.controllerBounds,
      hostBounds: surface.hostBounds,
      roleId: surface.roleId
    }))).toEqual(roleSurfacesBeforeMinimize?.map((surface) => ({
      controllerBounds: surface.controllerBounds,
      hostBounds: surface.hostBounds,
      roleId: surface.roleId
    })));
    expect(minimizedB.native.roleSurfaces?.every((surface) => !surface.documentViewport)).toBe(true);
  }
  const restoreCursor = (await probe()).latestSequence;
  await controlWindow(minimizedB.windowId, {
    action: "setPresentation",
    presentation: liveBBeforeMinimize.target.presentation
  });
  const restoreSubmitted = await waitEvent({
    afterSequence: restoreCursor,
    kind: "native-control-submitted",
    minimumGeneration: minimizedB.windowGeneration,
    windowId: WINDOW_B
  });
  if (process.platform === "win32") {
    const geometryReceipt = await waitEvent({
      afterSequence: restoreCursor,
      kind: "windows-geometry-receipt",
      minimumGeneration: minimizedB.windowGeneration,
      timeoutMs: 45_000,
      windowId: WINDOW_B
    });
    expect(geometryReceipt.details).toMatchObject({
      presentation: liveBBeforeMinimize.native.presentation === "maximized"
        ? "maximized"
        : "restored",
      status: "unchanged",
      terminal: true
    });
  }
  if (requiresNativeDeminimizeFocusFence(process.platform)) {
    await waitEvent({
      afterSequence: restoreSubmitted.sequence,
      kind: "window-focus-persisted",
      minimumGeneration: minimizedB.windowGeneration,
      windowId: WINDOW_B
    });
  }
  const restoredB = await windowSnapshot(WINDOW_B);
  expect(restoredB.native.presentation).toBe(liveBBeforeMinimize.native.presentation);
  if (process.platform === "win32") {
    expect(restoredB.native.roleSurfaces).toEqual(roleSurfacesBeforeMinimize);
  }
  const topologyMinimizeSubmitted = await submitWindowControl(restoredB, {
    action: "minimize"
  });
  await waitEvent({
    afterSequence: topologyMinimizeSubmitted.sequence,
    kind: "window-minimized-observed",
    minimumGeneration: restoredB.windowGeneration,
    windowId: WINDOW_B
  });
  const topologyMinimizedB = await windowSnapshot(WINDOW_B);
  expect(topologyMinimizedB.native.presentation).toBe("minimized");
  const dashboardX = (workArea.x ?? 0) + Math.max(0, workArea.width - 960);
  await browser.setWindowRect(Math.round(dashboardX), Math.round(workArea.y ?? 0), 960, 640);
  try {
    const focusCursor = (await probe()).latestSequence;
    await controlWindow(detached.windowId, { action: "focus" });
    await waitEvent({
      afterSequence: focusCursor,
      kind: "window-focus-acknowledged",
      minimumGeneration: movedDetached.windowGeneration,
      windowId: detached.windowId
    });
    // The WebDriver main-window rectangle and debug-only game-window geometry isolate the source
    // from the Dashboard and other game windows. The tab move remains a real native menu gesture
    // and still rejects obscured or stale tab identity at the point of input.
    const detachedWindow = await windowSnapshot(detached.windowId);
    await tabMenuAction({
      action: "move",
      snapshot: detachedWindow,
      tabId: lastSourceTab,
      target: restoredA
    });
    const topologyRestoreSubmitted = await submitWindowControl(topologyMinimizedB, {
      action: "setPresentation",
      presentation: liveBBeforeMinimize.target.presentation
    });
    if (requiresNativeDeminimizeFocusFence(process.platform)) {
      await waitEvent({
        afterSequence: topologyRestoreSubmitted.sequence,
        kind: "window-focus-persisted",
        minimumGeneration: topologyMinimizedB.windowGeneration,
        windowId: WINDOW_B
      });
    }
    const topologyRestoredB = await windowSnapshot(WINDOW_B);
    expect(topologyRestoredB.native.presentation).toBe(liveBBeforeMinimize.native.presentation);
    const positionedB = await controlWindow(WINDOW_B, {
      action: "moveResize",
      height: topologyRestoredB.target.bounds.height,
      scaleFactor: topologyRestoredB.native.scaleFactor,
      width: topologyRestoredB.target.bounds.width,
      x: (workArea.x ?? 0) + 64,
      y: workArea.y ?? 0
    });
    if ("submitted" in positionedB) throw new Error("Window B placement did not return native state");
  } finally {
    await browser.maximizeWindow();
  }
  await waitForActiveTabsReady();

  liveB = await windowSnapshot(WINDOW_B);
  const runtimeBeforeHide = await rendererCall("getEmbeddedRuntimeState");
  const hideTab = runtimeBeforeHide.tabs.find((tab) =>
    tab.windowId === WINDOW_B && !tab.hidden && tab.id !== target
  ) ?? runtimeBeforeHide.tabs.find((tab) => tab.windowId === WINDOW_B && !tab.hidden);
  if (!hideTab) throw new Error("A visible native tab is required for hide");
  await tabMenuAction({ action: "hide", snapshot: liveB, tabId: hideTab.id });
  expect((await windowSnapshot(WINDOW_B)).kernel?.tabs.find((tab) => tab.tabId === hideTab.id)?.hidden)
    .toBe(true);
  await showSourceFromVisibleUi(hideTab);

  liveB = await windowSnapshot(WINDOW_B);
  const finalHidden = (await rendererCall("getEmbeddedRuntimeState")).tabs.find((tab) =>
    tab.windowId === WINDOW_B && !tab.hidden && tab.id !== hideTab.id
  );
  if (!finalHidden) throw new Error("A second visible tab is required for durable hidden state");
  const persistenceCursor = (await probe()).latestSequence;
  const hideReceipt = await tabMenuAction({
    action: "hide",
    snapshot: liveB,
    tabId: finalHidden.id
  });
  if (hideReceipt.revision === undefined) {
    throw new Error("The final hidden-tab mutation did not report its committed revision");
  }
  await waitEvent({
    afterSequence: persistenceCursor,
    kind: "window-state-persisted",
    minimumRevision: hideReceipt.revision,
    timeoutMs: 55_000,
    windowId: WINDOW_B
  });

  const statuses = await waitForMacroProjection({
    afterSequence: macroCursor,
    macroId: scenario.macros[1].id,
    minimumIteration: 2,
    roleIds: scenario.macros[1].roleIds,
    state: "running"
  });
  expect(statuses.filter((status) => status.macroId === scenario.macros[1].id)).toHaveLength(2);
  expect((await rendererCall("listMacroStatuses")).filter((status) =>
    status.macroId === scenario.macros[1].id
  )).toEqual(expect.arrayContaining(scenario.macros[1].roleIds.map((roleId) =>
    expect.objectContaining({ roleId, state: "running" }))));
  const fixture = await fixtureCursor();
  await waitFixtureEvent({ afterSequence: fixture, kind: "keydown", roleId: FIXTURE_IDS[1] });
  const diagnostics = await inputDiagnostics();
  expect(diagnostics.roles.filter((role) => scenario.macros[1].roleIds.includes(role.roleId)))
    .toEqual(expect.arrayContaining(scenario.macros[1].roleIds.map((roleId) =>
      expect.objectContaining({ quiesced: false, roleId, stopping: false }))));
  await forceTerminateCurrentProcess();
}

async function fixturePost(path: string, body: unknown): Promise<void> {
  const response = await fetch(`${requireEnvironment("RION_STUDIO_E2E_FIXTURE_ORIGIN")}${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
  if (!response.ok) throw new Error(`Fixture ${path} failed with ${response.status}`);
}

async function waitFixturePath(path: string): Promise<void> {
  const response = await fetch(`${requireEnvironment("RION_STUDIO_E2E_FIXTURE_ORIGIN")}${path}`, {
    signal: AbortSignal.timeout(55_000)
  });
  if (!response.ok) throw new Error(`Fixture event ${path} failed with ${response.status}`);
}

async function waitForInputFenceEvent(
  afterSequence: number,
  expectedEvent: string
): Promise<DesktopE2eEvent> {
  let cursor = afterSequence;
  for (;;) {
    const observed = await waitEvent({
      afterSequence: cursor,
      kind: "input-fence-event",
      timeoutMs: 55_000
    });
    if ((observed.details as { event?: unknown }).event === expectedEvent) return observed;
    cursor = observed.sequence;
  }
}

function expectRestoredSession(event: FixtureEvent, marker: string): void {
  expect(event).toMatchObject({
    kind: "session",
    session: {
      after: { cookie: marker, localStorage: marker },
      before: { cookie: marker, localStorage: marker },
      marker,
      mode: "seed"
    }
  });
}

async function cleanupScenario(scenario: Scenario): Promise<void> {
  for (const macro of scenario.macros) await rendererCall("stopMacro", macro.id).catch(() => undefined);
  for (const workspace of scenario.workspaces) {
    await rendererCall("stopLaunchWorkspace", workspace.id).catch(() => undefined);
  }
  for (const role of scenario.roles) await rendererCall("stopRole", role.id).catch(() => undefined);
  for (const window of scenario.windows) {
    const stopCursor = (await probe()).latestSequence;
    const stopSucceeded = await rendererCall("stopGameWindow", window.id).then(
      () => true,
      () => false
    );
    if (stopSucceeded) {
      await waitEvent({
        afterSequence: stopCursor,
        kind: "window-destroyed",
        timeoutMs: 55_000,
        windowId: window.id
      });
    }
    await rendererCall("deleteGameWindow", window.id);
  }
  for (const macro of scenario.macros) await rendererCall("deleteMacro", macro.id);
  for (const workspace of scenario.workspaces) await rendererCall("deleteLaunchWorkspace", workspace.id);
  for (const role of scenario.roles) await rendererCall("deleteRole", role.id);
  await rendererCall("deleteGame", scenario.game.id);
}

async function recoveryPhase(): Promise<void> {
  await bootstrap(false);
  const scenario = await loadScenario();
  await navigate("/dashboard");
  const awaiting = await rendererCall("getEmbeddedRuntimeState");
  expect(awaiting.recovery?.windowCount).toBeGreaterThanOrEqual(2);
  expect(await rendererCall("listMacroStatuses")).toHaveLength(0);
  const cursor = await rendererEventCursor();
  const sessionCursor = await fixtureCursor();
  const restore = await $("button=Restore session");
  await restore.waitForDisplayed({ timeout: 10_000 });
  await restore.click();
  const restored = await waitForRuntimeProjection({
    afterSequence: cursor,
    recoveryAbsent: true,
    windowIds: [WINDOW_A, WINDOW_B]
  });
  expect(restored.tabs.some((tab) => tab.hidden)).toBe(true);
  expect(await rendererCall("listMacroStatuses")).toHaveLength(0);
  const persistedWindows = await rendererCall("listGameWindows");
  for (const windowId of [WINDOW_A, WINDOW_B]) {
    const persisted = persistedWindows.find((window) => window.id === windowId);
    const live = await windowSnapshot(windowId);
    expect(live.kernel?.tabs.map((tab) => tab.tabId)).toEqual(persisted?.tabs.map((tab) => tab.id));
    expect(live.kernel?.tabs.map((tab) => tab.hidden)).toEqual(
      persisted?.tabs.map((tab) => tab.hidden)
    );
    expect(live.kernel?.selectedTabId ?? null).toBe(persisted?.activeTabId ?? null);
  }
  for (const tab of restored.tabs) {
    await showSourceFromVisibleUi(tab);
    await waitForActiveTabsReady();
  }
  const restoredSessions = await Promise.all(FIXTURE_IDS.map((roleId) => waitFixtureEvent({
    afterSequence: sessionCursor,
    kind: "session",
    roleId
  })));
  restoredSessions.forEach((event, index) => expectRestoredSession(event, FIXTURE_IDS[index]!));

  const recoveryMacroCursor = await startSharedMacro(scenario.macros[1]);

  const sharedRole = scenario.roles[1];
  const beforeFailure = await rendererCall("getEmbeddedRuntimeState");
  const sharedTabs = beforeFailure.tabs.filter((tab) => tab.roleIds.includes(sharedRole.id));
  const blockedTab = sharedTabs.find((tab) =>
    tab.slots.some((slot) => slot.roleId === sharedRole.id && slot.state === "blocked")
  );
  if (!blockedTab) throw new Error("Shared-role failure injection requires a blocked occurrence");
  const target = await selectRuntimeTabForRoleSlot(blockedTab, sharedRole.id);
  await fixturePost("/api/navigation-failure", { enabled: true, roleId: FIXTURE_IDS[1] });
  const failureCursor = (await probe()).latestSequence;
  await runtimeUiAction(blockedTab.windowId, {
    action: "pressRoleSlot",
    roleId: sharedRole.id,
    tabId: blockedTab.id,
    windowGeneration: target.windowGeneration
  });
  const [, restartRequired] = await Promise.all([
    waitFixturePath(`/api/navigation-failures/${FIXTURE_IDS[1]}/attempted`),
    waitForInputFenceEvent(failureCursor, "restart-required"),
    waitForMacroProjection({
      absent: true,
      afterSequence: recoveryMacroCursor,
      macroId: scenario.macros[1].id
    })
  ]);
  expect(restartRequired.details).toMatchObject({
    event: "restart-required",
    roleId: sharedRole.id
  });
  expect([
    "navigation-page-ready-failed",
    "page-finish-deadline"
  ]).toContain((restartRequired.details as { reason?: string }).reason);
  expect((await inputDiagnostics()).roles).toEqual(expect.arrayContaining([
    expect.objectContaining({
      restartRequired: true,
      roleId: sharedRole.id
    })
  ]));
  expect(await rendererCall("listMacroStatuses")).toHaveLength(0);
  for (const role of scenario.roles.filter((candidate) => candidate.id !== sharedRole.id)) {
    await waitForRoleProjection({ roleId: role.id, state: "running" });
  }
  const terminalInput = await fixtureState();
  await fixturePost("/api/navigation-failure", { enabled: false, roleId: FIXTURE_IDS[1] });
  const afterRetryInput = await fixtureState();
  expect(afterRetryInput[FIXTURE_IDS[1]]?.keydown ?? 0)
    .toBe(terminalInput[FIXTURE_IDS[1]]?.keydown ?? 0);
  expect(await rendererCall("listMacroStatuses")).toHaveLength(0);
  await cleanupScenario(scenario);
  await shutdownAndWaitForFlush();
}

async function finalRestartPhase(): Promise<void> {
  await bootstrap(false);
  const snapshots = [
    ...(await rendererCall("listGames")),
    ...(await rendererCall("listGameWindows")),
    ...(await rendererCall("listMacros")),
    ...(await rendererCall("listRoles")),
    ...(await rendererCall("listLaunchWorkspaces"))
  ];
  expect(snapshots.some((entity) => entity.name.startsWith(PREFIX))).toBe(false);
  expect(await rendererCall("listMacroStatuses")).toHaveLength(0);
  const runtime = await rendererCall("getEmbeddedRuntimeState");
  expect(runtime.windows).toHaveLength(0);
  expect(runtime.tabs).toHaveLength(0);
  expect(runtime.recovery ?? null).toBeNull();
  const diagnostics = await inputDiagnostics();
  expect(diagnostics.roles.some((role) => role.stopping || role.quiesced)).toBe(false);
  await shutdownAndWaitForFlush();
}

describe("cross-domain Role, Workspace, Macro, and Game Window lifecycle", () => {
  it(`runs ${requireEnvironment("RION_STUDIO_E2E_PHASE")} with fenced native evidence`, async () => {
    const phase = requireEnvironment("RION_STUDIO_E2E_PHASE");
    if (phase === "p1-cross-domain-seed") await seedPhase();
    else if (phase === "p1-cross-domain-topology-force") await topologyForcePhase();
    else if (phase === "p1-cross-domain-recovery") await recoveryPhase();
    else if (phase === "p1-cross-domain-final-restart") await finalRestartPhase();
    else throw new Error(`Unknown cross-domain E2E phase: ${phase}`);
  });
});
