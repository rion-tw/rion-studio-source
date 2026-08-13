import { $, expect } from "@wdio/globals";

import type { Game, GameWindow, Macro, Role } from "../../../src/shared/types";
import {
  detachTerminatedApplicationSession,
  inputDiagnostics,
  probe,
  rendererCall,
  requireEnvironment,
  runtimeUiAction,
  shutdown,
  waitEvent,
  windowSnapshot,
  type DesktopE2eWindowSnapshot
} from "../support/control";
import {
  fixtureCursor,
  fixtureRequest,
  fixtureState,
  waitFixtureEvent,
  type FixtureRoleState
} from "../support/fixture";
import {
  installRendererEventJournal,
  rendererEventCursor,
  waitForGameWindowProjection,
  waitForMacroProjection,
  waitForRoleProjection,
  waitForRuntimeProjection
} from "../support/renderer-events";
import { waitForTranscriptEvent } from "../support/transcript";
import {
  acceptLegalAndSkipFirstRun,
  clickConfirmation,
  clickEntityMenuAction,
  ensureEnglishUi,
  navigate
} from "../support/ui";

// [journey:MACRO-TERMINAL-CLEANUP-006]
// [journey:TABS-VISIBLE-ACTIVATION-003]

const CLEANUP_WINDOW_ID = "e2e00000-0000-4000-8000-000000000016";
const TABS_WINDOW_ID = "e2e00000-0000-4000-8000-000000000017";

async function bootstrap(): Promise<void> {
  await ensureEnglishUi();
  await acceptLegalAndSkipFirstRun();
  await installRendererEventJournal();
  await fixtureRequest("/api/reset", {});
}

async function createGame(name: string, fixtureId: string): Promise<Game> {
  return rendererCall("createGame", {
    defaultLaunchUrl: `${requireEnvironment("RION_STUDIO_E2E_FIXTURE_ORIGIN")}/role/${fixtureId}`,
    name
  });
}

async function createRole(game: Game, name: string, fixtureId: string): Promise<Role> {
  return rendererCall("createRole", {
    gameId: game.id,
    launchUrl: `${requireEnvironment("RION_STUDIO_E2E_FIXTURE_ORIGIN")}/role/${fixtureId}`,
    name
  });
}

async function createWindow(id: string, name: string): Promise<GameWindow> {
  const topology = await rendererCall("getDisplayTopology");
  const display = topology.displays.find((candidate) => candidate.isPrimary) ?? topology.displays[0];
  if (!display) throw new Error("Desktop E2E requires one native display");
  const work = display.workArea;
  return rendererCall("createGameWindow", {
    id,
    name,
    placement: {
      normalBounds: {
        height: Math.max(440, Math.min(620, work.height - 140)),
        width: Math.max(680, Math.min(940, work.width - 120)),
        x: work.x + 40,
        y: work.y + 50
      },
      presentation: "normal",
      savedWorkArea: work
    },
    targetDisplay: { id: display.id }
  });
}

async function showWindowFromUi(windowId: string, minimumGeneration = 1): Promise<DesktopE2eWindowSnapshot> {
  const cursor = (await probe()).latestSequence;
  await navigate("/game-windows");
  await $(`[data-selection-id='${windowId}'] button[aria-label='Show']`).click();
  await waitEvent({
    afterSequence: cursor,
    kind: "window-context-initialized",
    minimumGeneration,
    windowId
  });
  if (process.platform === "win32") {
    await waitEvent({
      afterSequence: cursor,
      kind: "runtime-tab-chrome-projection-applied",
      minimumGeneration,
      windowId
    });
  } else if (process.platform === "darwin") {
    const restoring = await windowSnapshot(windowId);
    const selectedTabId = restoring.kernel?.selectedTabId;
    if (selectedTabId) {
      // `window-context-initialized` precedes AppKit's restored tab reservation. Navigating is
      // published only after the selected tab's native control and role surfaces are attached.
      await waitEvent({
        afterSequence: cursor,
        kind: `tab-launch-phase:${selectedTabId}:navigating`,
        minimumGeneration,
        timeoutMs: 55_000,
        windowId
      });
    }
  }
  return windowSnapshot(windowId);
}

async function expectTeardownQuiesced(afterSequence: number, role: Role): Promise<void> {
  const stopping = await waitEvent({
    afterSequence,
    kind: `browser-status:${role.id}:stopping`
  });
  expect(stopping.details).toMatchObject({
    inputDiagnostic: { quiesced: true, roleId: role.id, stopping: true }
  });
}

async function stopWindowFromUi(windowId: string, role?: Role): Promise<void> {
  const cursor = (await probe()).latestSequence;
  await navigate("/game-windows");
  await clickEntityMenuAction(windowId, "Game window actions", "Stop and close window");
  await waitEvent({ afterSequence: cursor, kind: "window-destroyed", windowId });
  if (role) {
    const admission = await waitEvent({
      afterSequence: cursor,
      kind: "runtime-window-close-admitted",
      windowId
    });
    const details = admission.details as { inputDiagnostics?: unknown };
    expect(details.inputDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ quiesced: true, roleId: role.id, stopping: true })
    ]));
  }
  await expect($(`[data-selection-id='${windowId}']`))
    .toHaveText(expect.stringContaining("Not open"));
}

async function launchRole(role: Role, windowId: string) {
  const cursor = await rendererEventCursor();
  const fixtureAfter = await fixtureCursor();
  await rendererCall("launchRole", role.id, { kind: "game-window", windowId });
  await Promise.all([
    waitForRoleProjection({ afterSequence: cursor, roleId: role.id, state: "running" }),
    waitFixtureEvent({ afterSequence: fixtureAfter, kind: "session", roleId: fixtureId(role) })
  ]);
  const runtime = await waitForRuntimeProjection({ afterSequence: cursor, sourceId: role.id });
  const tab = runtime.tabs.find((candidate) => candidate.sourceId === role.id);
  if (!tab) throw new Error(`Runtime tab for ${role.name} is unavailable`);
  return tab;
}

function fixtureId(role: Role): string {
  const id = role.launchUrl?.split("/role/").at(-1)?.split("?")[0];
  if (!id) throw new Error(`Role ${role.name} has no fixture identity`);
  return id;
}

async function createLoopMacro(role: Role, name: string, code: string): Promise<Macro> {
  return rendererCall("createMacro", {
    activationMode: "toggle",
    enabled: true,
    name,
    repeat: { intervalMs: 100, type: "loop" },
    roleIds: [role.id],
    steps: [{ action: "tap", code, id: `${name}-key`, type: "key" }]
  });
}

async function startMacro(macro: Macro, role: Role): Promise<number> {
  await navigate("/macros");
  const cursor = await rendererEventCursor();
  const fixtureAfter = await fixtureCursor();
  const start = await $(`[data-selection-id='${macro.id}'] button[aria-label='Start']`);
  await start.waitForEnabled({ timeout: 20_000 });
  await start.click();
  await Promise.all([
    waitForMacroProjection({
      afterSequence: cursor,
      macroId: macro.id,
      minimumIteration: 1,
      roleIds: [role.id]
    }),
    waitFixtureEvent({ afterSequence: fixtureAfter, kind: "keydown", roleId: fixtureId(role) })
  ]);
  return cursor;
}

async function stopMacroFromUi(macro: Macro, afterSequence: number): Promise<void> {
  const stop = await $(`[data-selection-id='${macro.id}'] button[aria-label='Stop']`);
  await stop.waitForEnabled({ timeout: 20_000 });
  await stop.click();
  await waitForMacroProjection({ afterSequence, absent: true, macroId: macro.id });
}

async function activateTab(windowId: string, tabId: string): Promise<void> {
  const live = await windowSnapshot(windowId);
  const phase = live.kernel?.tabs.find((tab) => tab.tabId === tabId)?.launchPhase;
  const cursor = (await probe()).latestSequence;
  await runtimeUiAction(windowId, {
    action: "activateTab",
    tabId,
    windowGeneration: live.windowGeneration
  });
  const terminal = await waitEvent({
    afterSequence: cursor,
    kind: "runtime-tab-activation-terminal",
    windowId
  });
  expect(terminal.details).toMatchObject({ error: null, status: "completed", tabId });
  if (!phase || phase === "attaching" || phase === "navigating") {
    await waitEvent({
      afterSequence: cursor,
      kind: `tab-launch-phase:${tabId}:essentialReady`,
      timeoutMs: 55_000,
      windowId
    });
  }
  expect((await windowSnapshot(windowId)).kernel?.selectedTabId).toBe(tabId);
}

async function closeTab(windowId: string, tabId: string, role?: Role): Promise<void> {
  await activateTab(windowId, tabId);
  const live = await windowSnapshot(windowId);
  const closesLastTab = live.kernel?.tabs.length === 1;
  const cursor = (await probe()).latestSequence;
  await runtimeUiAction(windowId, {
    action: "closeTab",
    tabId,
    windowGeneration: live.windowGeneration
  });
  const terminal = await waitEvent({
    afterSequence: cursor,
    kind: "runtime-tab-close-terminal",
    timeoutMs: 55_000,
    windowId
  });
  expect(terminal.details).toMatchObject({ error: null, status: "completed", tabId });
  if (closesLastTab) {
    await waitEvent({ afterSequence: cursor, kind: "window-destroyed", windowId });
  }
  if (role) await expectTeardownQuiesced(cursor, role);
}

function inputCount(state: Record<string, FixtureRoleState>, roleId: string): number {
  const role = state[roleId];
  if (!role) return 0;
  return role.click + role.keydown + role.keyup;
}

async function shutdownAndWaitForFlush(): Promise<void> {
  const control = await probe();
  const requestedAfter = new Date().toISOString();
  await shutdown().catch(() => undefined);
  const event = await waitForTranscriptEvent(
    control.transcriptPath,
    (candidate) => candidate.kind === "application-final-flush-complete"
      && candidate.timestamp >= requestedAfter
  );
  expect(event.details).toMatchObject({ complete: true });
  detachTerminatedApplicationSession();
}

async function cleanupPhase(): Promise<void> {
  await bootstrap();
  const fixtureIds = ["cleanup-stop", "cleanup-tab", "cleanup-window", "cleanup-shutdown"];
  const game = await createGame("E2E Macro Cleanup Game", fixtureIds[0]);
  const roles = await Promise.all(fixtureIds.map((id, index) =>
    createRole(game, `E2E Cleanup Role ${index + 1}`, id)
  ));
  const macros = await Promise.all(roles.map((role, index) =>
    createLoopMacro(role, `E2E Cleanup Macro ${index + 1}`, `Key${index + 1}`)
  ));
  await createWindow(CLEANUP_WINDOW_ID, "E2E Macro Cleanup Window");
  await showWindowFromUi(CLEANUP_WINDOW_ID);

  const stopTab = await launchRole(roles[0], CLEANUP_WINDOW_ID);
  const stopCursor = await startMacro(macros[0], roles[0]);
  await stopMacroFromUi(macros[0], stopCursor);
  const stopTerminalCount = inputCount(await fixtureState(), fixtureIds[0]);
  const stopDiagnostic = (await inputDiagnostics()).roles.find((item) => item.roleId === roles[0].id);
  expect(stopDiagnostic).toMatchObject({ quiesced: false, stopping: false });
  await closeTab(CLEANUP_WINDOW_ID, stopTab.id);
  const reopenedEmpty = await showWindowFromUi(CLEANUP_WINDOW_ID);
  expect(reopenedEmpty.kernel?.tabs).toEqual([]);

  const runningTab = await launchRole(roles[1], CLEANUP_WINDOW_ID);
  const tabCursor = await startMacro(macros[1], roles[1]);
  await closeTab(CLEANUP_WINDOW_ID, runningTab.id, roles[1]);
  await waitForMacroProjection({ afterSequence: tabCursor, absent: true, macroId: macros[1].id });
  const tabTerminalCount = inputCount(await fixtureState(), fixtureIds[1]);
  expect((await inputDiagnostics()).roles.find((item) => item.roleId === roles[1].id))
    .toMatchObject({ quiesced: false, stopping: false });

  await launchRole(roles[2], CLEANUP_WINDOW_ID);
  expect((await windowSnapshot(CLEANUP_WINDOW_ID)).kernel?.tabs.map((tab) => tab.sourceId))
    .toEqual([roles[2].id]);
  const windowCursor = await startMacro(macros[2], roles[2]);
  await stopWindowFromUi(CLEANUP_WINDOW_ID, roles[2]);
  await waitForMacroProjection({ afterSequence: windowCursor, absent: true, macroId: macros[2].id });
  const windowTerminalCount = inputCount(await fixtureState(), fixtureIds[2]);
  expect((await inputDiagnostics()).roles.find((item) => item.roleId === roles[2].id))
    .toMatchObject({ quiesced: false, stopping: false });

  const shutdownCursor = await rendererEventCursor();
  const shutdownFixtureCursor = await fixtureCursor();
  const shutdownTab = await rendererCall("launchRole", roles[3].id, { kind: "new-window" });
  expect(shutdownTab.windowId).toBeTruthy();
  await Promise.all([
    waitForRoleProjection({ afterSequence: shutdownCursor, roleId: roles[3].id, state: "running" }),
    waitFixtureEvent({
      afterSequence: shutdownFixtureCursor,
      kind: "session",
      roleId: fixtureIds[3]
    })
  ]);
  await startMacro(macros[3], roles[3]);
  await shutdownAndWaitForFlush();

  const finalState = await fixtureState();
  expect(inputCount(finalState, fixtureIds[0])).toBe(stopTerminalCount);
  expect(inputCount(finalState, fixtureIds[1])).toBe(tabTerminalCount);
  expect(inputCount(finalState, fixtureIds[2])).toBe(windowTerminalCount);
  expect(finalState[fixtureIds[3]].keydown).toBe(finalState[fixtureIds[3]].keyup);
}

async function tabsPhase(): Promise<void> {
  await bootstrap();
  const ids = ["visible-tabs-a", "visible-tabs-b", "visible-tabs-c"];
  const game = await createGame("E2E Visible Tabs Game", ids[0]);
  const roles = await Promise.all(ids.map((id, index) =>
    createRole(game, `E2E Visible Tab Role ${index + 1}`, id)
  ));
  await createWindow(TABS_WINDOW_ID, "E2E Visible Tabs Window");
  await showWindowFromUi(TABS_WINDOW_ID);
  const tabs: Array<Awaited<ReturnType<typeof launchRole>>> = [];
  for (const [index, role] of roles.entries()) {
    const launchCursor = (await probe()).latestSequence;
    const fixtureAfter = await fixtureCursor();
    const tab = await launchRole(role, TABS_WINDOW_ID);
    tabs.push(tab);
    await waitEvent({
      afterSequence: launchCursor,
      kind: `tab-launch-phase:${tab.id}:ready`,
      timeoutMs: 55_000,
      windowId: TABS_WINDOW_ID
    });
    if (index === roles.length - 1) {
      await waitFixtureEvent({
        afterSequence: fixtureAfter,
        kind: "visibility",
        roleId: ids[index]
      });
    }
  }
  let previousIndex = 2;

  for (const [index, tab] of tabs.entries()) {
    const cursor = await fixtureCursor();
    await activateTab(TABS_WINDOW_ID, tab.id);
    await Promise.all([
      waitFixtureEvent({ afterSequence: cursor, kind: "hidden", roleId: ids[previousIndex] }),
      waitFixtureEvent({ afterSequence: cursor, kind: "visibility", roleId: ids[index] })
    ]);
    const focusCursor = await fixtureCursor();
    const live = await windowSnapshot(TABS_WINDOW_ID);
    await runtimeUiAction(TABS_WINDOW_ID, {
      action: "focusRole",
      roleId: roles[index].id,
      tabId: tab.id,
      windowGeneration: live.windowGeneration
    });
    await waitFixtureEvent({ afterSequence: focusCursor, kind: "click", roleId: ids[index] });
    previousIndex = index;
  }

  let live = await windowSnapshot(TABS_WINDOW_ID);
  expect(live.kernel?.tabs).toHaveLength(3);
  expect(new Set(live.kernel?.surfaceTabIds).size).toBe(live.kernel?.surfaceTabIds.length);
  await closeTab(TABS_WINDOW_ID, tabs[2].id);
  live = await windowSnapshot(TABS_WINDOW_ID);
  expect(live.kernel?.tabs).toHaveLength(2);
  expect(live.kernel?.surfaceTabIds).not.toContain(tabs[2].id);
  tabs[2] = await launchRole(roles[2], TABS_WINDOW_ID);
  live = await windowSnapshot(TABS_WINDOW_ID);
  expect(live.kernel?.tabs).toHaveLength(3);
  expect(new Set(live.kernel?.surfaceTabIds).size).toBe(live.kernel?.surfaceTabIds.length);

  const generation = live.windowGeneration;
  const reopenCursor = await fixtureCursor();
  await stopWindowFromUi(TABS_WINDOW_ID);
  await showWindowFromUi(TABS_WINDOW_ID, generation + 1);
  for (let index = 0; index < tabs.length; index += 1) {
    await activateTab(TABS_WINDOW_ID, tabs[index].id);
    await waitFixtureEvent({ afterSequence: reopenCursor, kind: "session", roleId: ids[index] });
  }
  live = await windowSnapshot(TABS_WINDOW_ID);
  expect(live.kernel?.tabs).toHaveLength(3);
  expect(new Set(live.kernel?.surfaceTabIds).size).toBe(live.kernel?.surfaceTabIds.length);
  const state = await fixtureState();
  expect(ids.every((id) => state[id].focus > 0 && state[id].visibility > 0)).toBe(true);

  await stopWindowFromUi(TABS_WINDOW_ID);
  const deleteCursor = await rendererEventCursor();
  await clickEntityMenuAction(TABS_WINDOW_ID, "Game window actions", "Delete window");
  await clickConfirmation("Delete");
  await waitForGameWindowProjection({
    absent: true,
    afterSequence: deleteCursor,
    windowId: TABS_WINDOW_ID
  });
  for (const role of roles) await rendererCall("deleteRole", role.id);
  await rendererCall("deleteGame", game.id);
  await shutdownAndWaitForFlush();
}

describe("visible tab activation and macro teardown journeys", () => {
  it(`runs ${requireEnvironment("RION_STUDIO_E2E_PHASE")} with native terminal evidence`, async () => {
    const phase = requireEnvironment("RION_STUDIO_E2E_PHASE");
    if (phase === "p0-macro-terminal-cleanup") await cleanupPhase();
    else if (phase === "p0-tabs-visible-activation") await tabsPhase();
    else throw new Error(`Unknown tab and cleanup phase: ${phase}`);
  });
});
