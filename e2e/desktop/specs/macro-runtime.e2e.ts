import { $, expect } from "@wdio/globals";

import type { Game, LaunchWorkspace, Macro, MacroRepeat, MacroStep, Role } from "../../../src/shared/types";
import {
  inputDiagnostics,
  probe,
  rendererCall,
  requireEnvironment,
  runtimeUiAction,
  shutdown,
  waitEvent,
  windowSnapshot
} from "../support/control";
import {
  fixtureCursor,
  fixtureRequest,
  fixtureState,
  waitFixtureEvent
} from "../support/fixture";
import {
  installRendererEventJournal,
  rendererEventCursor,
  waitForMacroProjection,
  waitForRoleProjection,
  waitForRuntimeProjection
} from "../support/renderer-events";
import { waitForTranscriptEvent } from "../support/transcript";
import { acceptLegalAndSkipFirstRun, ensureEnglishUi, navigate } from "../support/ui";

// [journey:MACRO-NATIVE-EFFECT-003]
// [journey:MACRO-BACKGROUND-TAB-004]
// [journey:MACRO-MULTIROLE-005]

interface Scenario {
  game: Game;
  macro: Macro;
  roles: Role[];
  workspace?: LaunchWorkspace;
}

async function bootstrap(): Promise<void> {
  await ensureEnglishUi();
  await acceptLegalAndSkipFirstRun();
  await installRendererEventJournal();
  await fixtureRequest("/api/reset", {});
}

async function createScenario(input: {
  fixtureRoleIds: string[];
  macroRoleIndexes?: number[];
  name: string;
  repeat: MacroRepeat;
  steps: MacroStep[];
  workspace?: boolean;
}): Promise<Scenario> {
  const origin = requireEnvironment("RION_STUDIO_E2E_FIXTURE_ORIGIN");
  const game = await rendererCall("createGame", {
    defaultLaunchUrl: `${origin}/role/${input.fixtureRoleIds[0]}`,
    name: `${input.name} Game`
  });
  const roles = await Promise.all(input.fixtureRoleIds.map((fixtureRoleId, index) =>
    rendererCall("createRole", {
      gameId: game.id,
      launchUrl: `${origin}/role/${fixtureRoleId}`,
      name: `${input.name} Role ${index + 1}`
    })
  ));
  const macro = await rendererCall("createMacro", {
    activationMode: "toggle",
    enabled: true,
    name: `${input.name} Macro`,
    repeat: input.repeat,
    roleIds: (input.macroRoleIndexes ?? roles.map((_role, index) => index))
      .map((index) => roles[index].id),
    steps: input.steps
  });
  const workspace = input.workspace
    ? await rendererCall("createLaunchWorkspace", {
        name: `${input.name} Workspace`,
        slots: roles.map((role) => ({ roleId: role.id })),
        template: "two_columns"
      })
    : undefined;
  return { game, macro, roles, workspace };
}

function fixtureRoleId(role: Role): string {
  const roleId = role.launchUrl?.split("/").at(-1);
  if (!roleId) throw new Error(`Role ${role.name} has no fixture URL`);
  return roleId;
}

async function launchRole(role: Role, destination: "new-window" | { windowId: string }) {
  const cursor = await rendererEventCursor();
  const sessionCursor = await fixtureCursor();
  await rendererCall(
    "launchRole",
    role.id,
    destination === "new-window"
      ? { kind: "new-window" }
      : { kind: "game-window", windowId: destination.windowId }
  );
  await Promise.all([
    waitForRoleProjection({
      afterSequence: cursor,
      roleId: role.id,
      state: "running"
    }),
    waitFixtureEvent({ afterSequence: sessionCursor, kind: "session", roleId: fixtureRoleId(role) })
  ]);
  const runtime = await waitForRuntimeProjection({ afterSequence: cursor, sourceId: role.id });
  const tab = runtime.tabs.find((candidate) => candidate.sourceId === role.id);
  if (!tab) throw new Error(`Runtime tab for ${role.name} is unavailable`);
  return tab;
}

async function launchWorkspace(workspace: LaunchWorkspace, roles: Role[]) {
  const cursor = await rendererEventCursor();
  const sessionCursor = await fixtureCursor();
  await rendererCall("launchWorkspace", workspace.id, { kind: "new-window" });
  await Promise.all(roles.map((role) => waitForRoleProjection({
    afterSequence: cursor,
    roleId: role.id,
    state: "running"
  })));
  await Promise.all(roles.map((role) => waitFixtureEvent({
    afterSequence: sessionCursor,
    kind: "session",
    roleId: fixtureRoleId(role)
  })));
  const runtime = await waitForRuntimeProjection({
    afterSequence: cursor,
    roleIds: roles.map((role) => role.id),
    sourceId: workspace.id
  });
  const tab = runtime.tabs.find((candidate) => candidate.sourceId === workspace.id);
  if (!tab) throw new Error(`Runtime tab for ${workspace.name} is unavailable`);
  return tab;
}

async function startMacro(macro: Macro, roleIds: string[]): Promise<number> {
  await navigate("/macros");
  const cursor = await rendererEventCursor();
  const start = await $(`[data-selection-id='${macro.id}'] button[aria-label='Start']`);
  await start.waitForEnabled({ timeout: 20_000 });
  await start.click();
  await waitForMacroProjection({
    afterSequence: cursor,
    macroId: macro.id,
    roleIds,
    state: "running"
  });
  return cursor;
}

async function stopMacro(macro: Macro, cursor = 0): Promise<void> {
  const stopCursor = Math.max(cursor, await rendererEventCursor());
  const stop = await $(`[data-selection-id='${macro.id}'] button[aria-label='Stop']`);
  await stop.waitForEnabled({ timeout: 20_000 });
  await stop.click();
  await waitForMacroProjection({ afterSequence: stopCursor, absent: true, macroId: macro.id });
}

async function cleanup(scenario: Scenario): Promise<void> {
  if (scenario.workspace) {
    await rendererCall("stopLaunchWorkspace", scenario.workspace.id).catch(() => undefined);
  }
  await Promise.all(scenario.roles.map((role) =>
    rendererCall("stopRole", role.id).catch(() => undefined)
  ));
  await rendererCall("deleteMacro", scenario.macro.id);
  if (scenario.workspace) await rendererCall("deleteLaunchWorkspace", scenario.workspace.id);
  for (const role of scenario.roles) await rendererCall("deleteRole", role.id);
  await rendererCall("deleteGame", scenario.game.id);
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
  expect((event.details as { complete?: boolean }).complete).toBe(true);
}

async function activateVisibleRuntimeTab(input: {
  tabId: string;
  windowGeneration: number;
  windowId: string;
}): Promise<void> {
  const controlCursor = (await probe()).latestSequence;
  await runtimeUiAction(input.windowId, {
    action: "activateTab",
    tabId: input.tabId,
    windowGeneration: input.windowGeneration
  });
  const terminal = await waitEvent({
    afterSequence: controlCursor,
    kind: "runtime-tab-activation-terminal",
    windowId: input.windowId
  });
  const details = terminal.details as { error?: string; status?: string; tabId?: string };
  expect(details).toMatchObject({ status: "completed", tabId: input.tabId });
  expect(details.error ?? null).toBeNull();
  expect((await windowSnapshot(input.windowId)).kernel?.selectedTabId).toBe(input.tabId);
}

async function nativeEffectPhase(): Promise<void> {
  await bootstrap();
  const scenario = await createScenario({
    fixtureRoleIds: ["macro-native-effect"],
    name: "E2E Native Effect",
    repeat: { type: "once" },
    steps: [
      { action: "tap", code: "KeyA", id: "native-key", type: "key" },
      { id: "native-click", type: "click", xPercent: 50, yPercent: 50 }
    ]
  });
  await launchRole(scenario.roles[0], "new-window");
  const fixtureAfter = await fixtureCursor();
  const macroCursor = await startMacro(scenario.macro, [scenario.roles[0].id]);
  const [keydown, keyup, click, statuses] = await Promise.all([
    waitFixtureEvent({ afterSequence: fixtureAfter, kind: "keydown", roleId: "macro-native-effect" }),
    waitFixtureEvent({ afterSequence: fixtureAfter, kind: "keyup", roleId: "macro-native-effect" }),
    waitFixtureEvent({ afterSequence: fixtureAfter, kind: "click", roleId: "macro-native-effect" }),
    waitForMacroProjection({
      afterSequence: macroCursor,
      macroId: scenario.macro.id,
      minimumIteration: 1,
      roleIds: [scenario.roles[0].id]
    })
  ]);
  expect(keydown.code).toBe("KeyA");
  expect(keyup.code).toBe("KeyA");
  expect(click.targetId).toBe("qa-target");
  const status = statuses.find((candidate) => candidate.macroId === scenario.macro.id);
  expect(status?.iteration).toBe(1);
  expect(status?.lastClick?.stepId).toBe("native-click");
  await waitForMacroProjection({ afterSequence: macroCursor, absent: true, macroId: scenario.macro.id });
  await cleanup(scenario);
  await shutdownAndWaitForFlush();
}

async function backgroundTabPhase(): Promise<void> {
  await bootstrap();
  const scenario = await createScenario({
    fixtureRoleIds: ["macro-background-a", "macro-background-b"],
    macroRoleIndexes: [0],
    name: "E2E Background Tab",
    repeat: { intervalMs: 120, type: "loop" },
    steps: [{ action: "tap", code: "KeyB", id: "background-key", type: "key" }]
  });
  const tabA = await launchRole(scenario.roles[0], "new-window");
  const tabB = await launchRole(scenario.roles[1], { windowId: tabA.windowId });
  const live = await windowSnapshot(tabA.windowId);
  await activateVisibleRuntimeTab({
    tabId: tabA.id,
    windowGeneration: live.windowGeneration,
    windowId: tabA.windowId
  });
  const macroCursor = await startMacro(scenario.macro, [scenario.roles[0].id]);
  await waitForMacroProjection({
    afterSequence: macroCursor,
    macroId: scenario.macro.id,
    minimumIteration: 2,
    roleIds: [scenario.roles[0].id]
  });
  await activateVisibleRuntimeTab({
    tabId: tabB.id,
    windowGeneration: live.windowGeneration,
    windowId: tabA.windowId
  });
  const backgroundCursor = await fixtureCursor();
  await waitFixtureEvent({
    afterSequence: backgroundCursor,
    kind: "keydown",
    roleId: "macro-background-a"
  });
  const state = await fixtureState();
  expect(state["macro-background-a"].keydown).toBeGreaterThan(0);
  expect(state["macro-background-b"].keydown).toBe(0);
  expect((await windowSnapshot(tabA.windowId)).kernel?.selectedTabId).toBe(tabB.id);
  await stopMacro(scenario.macro, macroCursor);
  const diagnostics = await inputDiagnostics();
  expect(diagnostics.roles.filter((role) => role.roleId === scenario.roles[0].id))
    .toEqual(expect.arrayContaining([expect.objectContaining({
      quiesced: false,
      roleId: scenario.roles[0].id,
      stopping: false
    })]));
  await cleanup(scenario);
  await shutdownAndWaitForFlush();
}

async function multiRolePhase(): Promise<void> {
  await bootstrap();
  const scenario = await createScenario({
    fixtureRoleIds: ["macro-multirole-a", "macro-multirole-b"],
    name: "E2E Multi Role",
    repeat: { intervalMs: 120, type: "loop" },
    steps: [{ action: "tap", code: "KeyM", id: "multirole-key", type: "key" }],
    workspace: true
  });
  const tab = await launchWorkspace(scenario.workspace!, scenario.roles);
  const live = await windowSnapshot(tab.windowId);
  const macroCursor = await startMacro(scenario.macro, scenario.roles.map((role) => role.id));
  const firstCursor = await fixtureCursor();
  await Promise.all([
    waitFixtureEvent({ afterSequence: firstCursor, kind: "keydown", roleId: "macro-multirole-a" }),
    waitFixtureEvent({ afterSequence: firstCursor, kind: "keydown", roleId: "macro-multirole-b" })
  ]);
  const focusCursor = await fixtureCursor();
  await runtimeUiAction(tab.windowId, {
    action: "focusRole",
    roleId: scenario.roles[1].id,
    tabId: tab.id,
    windowGeneration: live.windowGeneration
  });
  await waitFixtureEvent({ afterSequence: focusCursor, kind: "click", roleId: "macro-multirole-b" });
  const afterFocusCursor = await fixtureCursor();
  await Promise.all([
    waitFixtureEvent({ afterSequence: afterFocusCursor, kind: "keydown", roleId: "macro-multirole-a" }),
    waitFixtureEvent({ afterSequence: afterFocusCursor, kind: "keydown", roleId: "macro-multirole-b" })
  ]);
  const statuses = await waitForMacroProjection({
    afterSequence: macroCursor,
    macroId: scenario.macro.id,
    minimumIteration: 2,
    roleIds: scenario.roles.map((role) => role.id)
  });
  const iterations = statuses
    .filter((status) => status.macroId === scenario.macro.id)
    .map((status) => status.iteration ?? 0);
  expect(Math.max(...iterations) - Math.min(...iterations)).toBeLessThanOrEqual(1);
  await stopMacro(scenario.macro, macroCursor);
  await cleanup(scenario);
  await shutdownAndWaitForFlush();
}

describe("native macro runtime journeys", () => {
  it(`runs ${requireEnvironment("RION_STUDIO_E2E_PHASE")} with event-bound native evidence`, async () => {
    const phase = requireEnvironment("RION_STUDIO_E2E_PHASE");
    if (phase === "p0-macro-native-effect") await nativeEffectPhase();
    else if (phase === "p0-macro-background-tab") await backgroundTabPhase();
    else if (phase === "p1-macro-multirole") await multiRolePhase();
    else throw new Error(`Unknown native macro phase: ${phase}`);
  });
});
