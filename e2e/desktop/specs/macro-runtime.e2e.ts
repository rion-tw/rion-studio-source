import { $, browser, expect } from "@wdio/globals";

import type { Game, LaunchWorkspace, Macro, MacroRepeat, MacroStep, Role } from "../../../src/shared/types";
import {
  detachTerminatedApplicationSession,
  focusMainApplicationWindow,
  inputDiagnostics,
  keyboardInput,
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
  fixtureEvents,
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
// [journey:MACRO-SHORTCUT-REENTRY-007]
// [journey:MACRO-MODIFIER-CONTINUITY-008]
// [journey:ROLE-KEY-BLUR-004]

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
  shortcutSourceScope?: Macro["shortcutSourceScope"];
  steps: MacroStep[];
  trigger?: Macro["trigger"];
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
    shortcutSourceScope: input.shortcutSourceScope,
    trigger: input.trigger,
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
  for (const role of scenario.roles) await rendererCall("stopRole", role.id);
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
  detachTerminatedApplicationSession();
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

async function waitFixtureCode(input: {
  afterSequence: number;
  code: string;
  kind: "consumer-keydown" | "consumer-keyup" | "keydown" | "keyup";
  roleId: string;
}) {
  let cursor = input.afterSequence;
  for (;;) {
    const event = await waitFixtureEvent({
      afterSequence: cursor,
      kind: input.kind,
      roleId: input.roleId
    });
    if (event.code === input.code) return event;
    cursor = event.sequence;
  }
}

async function waitMacroKeyReceipt(input: {
  afterSequence: number;
  code: string;
  kind: "macro-key-dom-observed" | "macro-key-native-acknowledged";
  phase: "keydown" | "keyup";
  roleId: string;
}) {
  let cursor = input.afterSequence;
  for (;;) {
    const event = await waitEvent({ afterSequence: cursor, kind: input.kind });
    const details = event.details as {
      code?: string;
      dispatchId?: string;
      phase?: string;
      roleId?: string;
    };
    if (
      details.code === input.code
      && details.phase === input.phase
      && details.roleId === input.roleId
    ) {
      expect(details.dispatchId).toEqual(expect.any(String));
      return event;
    }
    cursor = event.sequence;
  }
}

async function waitShortcutLifecycle(input: {
  afterSequence: number;
  code: string;
  macroId: string;
  phase:
    | "physical-keydown-managed"
    | "chord-released"
    | "managed-replay-acknowledged"
    | "managed-keydown-acknowledged"
    | "managed-keyup-acknowledged"
    | "macro-dispatched";
  roleId: string;
}) {
  let cursor = input.afterSequence;
  for (;;) {
    const event = await waitEvent({ afterSequence: cursor, kind: "macro-shortcut-lifecycle" });
    const details = event.details as {
      code?: string;
      macroId?: string;
      phase?: string;
      roleId?: string;
    };
    if (
      details.code === input.code
      && details.macroId === input.macroId
      && details.phase === input.phase
      && details.roleId === input.roleId
    ) {
      return event;
    }
    cursor = event.sequence;
  }
}

async function waitManagedShortcutReceipt(input: {
  afterSequence: number;
  code: string;
  macroId: string;
  phase: "replay" | "keyDown" | "keyUp";
  roleId: string;
}) {
  let cursor = input.afterSequence;
  for (;;) {
    const event = await waitEvent({
      afterSequence: cursor,
      kind: "managed-shortcut-key-acknowledged"
    });
    const details = event.details as {
      code?: string;
      macroId?: string;
      phase?: string;
      pressId?: string;
      roleId?: string;
    };
    if (
      details.code === input.code
      && details.macroId === input.macroId
      && details.phase === input.phase
      && details.roleId === input.roleId
    ) {
      expect(details.pressId).toEqual(expect.any(String));
      return event;
    }
    cursor = event.sequence;
  }
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
  const backgroundKeydown = await waitFixtureEvent({
    afterSequence: backgroundCursor,
    kind: "keydown",
    roleId: "macro-background-a"
  });
  await waitFixtureEvent({
    afterSequence: backgroundKeydown.sequence,
    kind: "keyup",
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

async function keyboardLifecyclePhase(): Promise<void> {
  await bootstrap();
  const scenario = await createScenario({
    fixtureRoleIds: ["macro-keyboard-a", "macro-keyboard-b"],
    macroRoleIndexes: [0],
    name: "E2E Keyboard Lifecycle Child",
    repeat: { type: "once" },
    steps: [
      { action: "tap", code: "Digit1", id: "nested-one", type: "key" },
      { action: "tap", code: "Digit0", id: "nested-zero", type: "key" }
    ]
  });
  const firstMacro = await rendererCall("createMacro", {
    activationMode: "toggle",
    enabled: true,
    name: "E2E Keyboard Lifecycle Shift 2 Macro",
    repeat: { type: "once" },
    roleIds: [scenario.roles[0].id],
    shortcutSourceScope: { type: "selected_roles", roleIds: [scenario.roles[0].id] },
    steps: [
      {
        callMode: "trigger",
        id: "nested-after-two",
        macroId: scenario.macro.id,
        type: "macro"
      }
    ],
    trigger: { alt: false, code: "Digit2", ctrl: false, meta: false, shift: true }
  });
  const secondMacro = await rendererCall("createMacro", {
    activationMode: "toggle",
    enabled: true,
    name: "E2E Keyboard Lifecycle Shift 3 Macro",
    repeat: { type: "once" },
    roleIds: [scenario.roles[0].id],
    shortcutSourceScope: { type: "selected_roles", roleIds: [scenario.roles[0].id] },
    steps: [
      { action: "tap", code: "Digit1", id: "marker-three", modifiers: ["shift"], type: "key" }
    ],
    trigger: { alt: false, code: "Digit3", ctrl: false, meta: false, shift: true }
  });
  const compatibilityMacro = await rendererCall("createMacro", {
    activationMode: "toggle",
    enabled: true,
    name: "E2E Keyboard Lifecycle Same Trigger Compatibility Macro",
    repeat: { type: "once" },
    roleIds: [scenario.roles[0].id],
    shortcutSourceScope: { type: "selected_roles", roleIds: [scenario.roles[0].id] },
    steps: [
      { action: "tap", code: "Digit6", id: "same-trigger-six", modifiers: ["shift"], type: "key" }
    ],
    trigger: { alt: false, code: "Digit6", ctrl: false, meta: false, shift: true }
  });
  const continuityMacro = await rendererCall("createMacro", {
    activationMode: "while_held",
    enabled: true,
    name: "E2E Keyboard Lifecycle Modifier Continuity Macro",
    repeat: { type: "once" },
    roleIds: [scenario.roles[0].id],
    shortcutSourceScope: { type: "selected_roles", roleIds: [scenario.roles[0].id] },
    steps: [
      { action: "tap", code: "Digit1", id: "continuity-one", modifiers: ["shift"], type: "key" }
    ],
    trigger: { alt: false, code: "Digit5", ctrl: false, meta: false, shift: true }
  });
  const heldCodes: string[] = [];
  const press = async (code: string): Promise<void> => {
    const receipt = await keyboardInput(code, "keyDown");
    heldCodes.push(code);
    expect(receipt).toMatchObject({ code, phase: "keyDown", status: "submitted" });
  };
  const release = async (code: string): Promise<void> => {
    const receipt = await keyboardInput(code, "keyUp");
    const index = heldCodes.lastIndexOf(code);
    if (index !== -1) heldCodes.splice(index, 1);
    expect(receipt).toMatchObject({ code, phase: "keyUp", status: "submitted" });
  };
  try {
    const tabA = await launchRole(scenario.roles[0], "new-window");
    const tabB = await launchRole(scenario.roles[1], { windowId: tabA.windowId });
    const live = await windowSnapshot(tabA.windowId);
    const focusCursor = await fixtureCursor();
    await activateVisibleRuntimeTab({
      tabId: tabA.id,
      windowGeneration: live.windowGeneration,
      windowId: tabA.windowId
    });
    await runtimeUiAction(tabA.windowId, {
      action: "focusRole",
      roleId: scenario.roles[0].id,
      tabId: tabA.id,
      windowGeneration: live.windowGeneration
    });
    await waitFixtureEvent({
      afterSequence: focusCursor,
      kind: "focus",
      roleId: "macro-keyboard-a"
    });

    const shortcutFixtureCursor = await fixtureCursor();
    const firstDiagnosticCursor = (await probe()).latestSequence;
    const firstMacroCursor = await rendererEventCursor();
    await press("ShiftLeft");
    const firstShiftDown = await waitFixtureCode({
      afterSequence: shortcutFixtureCursor,
      code: "ShiftLeft",
      kind: "keydown",
      roleId: "macro-keyboard-a"
    });
    await press("Digit2");
    await release("Digit2");
    await release("ShiftLeft");
    await waitFixtureCode({
      afterSequence: firstShiftDown.sequence,
      code: "ShiftLeft",
      kind: "keyup",
      roleId: "macro-keyboard-a"
    });
    await waitForMacroProjection({
      afterSequence: firstMacroCursor,
      macroId: firstMacro.id,
      roleIds: [scenario.roles[0].id],
      state: "running"
    });
    const nestedOneDown = await waitFixtureCode({
      afterSequence: shortcutFixtureCursor,
      code: "Digit1",
      kind: "keydown",
      roleId: "macro-keyboard-a"
    });
    const nestedOneUp = await waitFixtureCode({
      afterSequence: nestedOneDown.sequence,
      code: "Digit1",
      kind: "keyup",
      roleId: "macro-keyboard-a"
    });
    const nestedZeroDown = await waitFixtureCode({
      afterSequence: nestedOneUp.sequence,
      code: "Digit0",
      kind: "keydown",
      roleId: "macro-keyboard-a"
    });
    await Promise.all([
      waitFixtureCode({
        afterSequence: nestedZeroDown.sequence,
        code: "Digit0",
        kind: "keyup",
        roleId: "macro-keyboard-a"
      }),
      waitForMacroProjection({
        afterSequence: firstMacroCursor,
        macroId: firstMacro.id,
        minimumIteration: 1,
        roleIds: [scenario.roles[0].id]
      }),
      waitForMacroProjection({
        afterSequence: firstMacroCursor,
        macroId: scenario.macro.id,
        minimumIteration: 1,
        roleIds: [scenario.roles[0].id]
      }),
      waitShortcutLifecycle({
        afterSequence: firstDiagnosticCursor,
        code: "Digit2",
        macroId: firstMacro.id,
        phase: "physical-keydown-managed",
        roleId: scenario.roles[0].id
      }),
      waitShortcutLifecycle({
        afterSequence: firstDiagnosticCursor,
        code: "Digit2",
        macroId: firstMacro.id,
        phase: "chord-released",
        roleId: scenario.roles[0].id
      }),
      waitShortcutLifecycle({
        afterSequence: firstDiagnosticCursor,
        code: "Digit2",
        macroId: firstMacro.id,
        phase: "managed-replay-acknowledged",
        roleId: scenario.roles[0].id
      }),
      waitManagedShortcutReceipt({
        afterSequence: firstDiagnosticCursor,
        code: "Digit2",
        macroId: firstMacro.id,
        phase: "replay",
        roleId: scenario.roles[0].id
      }),
      waitShortcutLifecycle({
        afterSequence: firstDiagnosticCursor,
        code: "Digit2",
        macroId: firstMacro.id,
        phase: "macro-dispatched",
        roleId: scenario.roles[0].id
      })
    ]);
    await waitFixtureCode({
      afterSequence: nestedZeroDown.sequence,
      code: "Digit0",
      kind: "consumer-keyup",
      roleId: "macro-keyboard-a"
    });
    await waitForMacroProjection({
      absent: true,
      afterSequence: firstMacroCursor,
      macroId: firstMacro.id
    });
    await waitForMacroProjection({
      absent: true,
      afterSequence: firstMacroCursor,
      macroId: scenario.macro.id
    });

    // Reproduce the user's real cadence without using the interval as success
    // evidence: the first macro has already reached its authoritative terminal.
    await browser.pause(2_000);

    const firstShortcutEvents = await fixtureEvents({
      afterSequence: shortcutFixtureCursor,
      roleId: "macro-keyboard-a"
    });
    const firstShiftEvents = firstShortcutEvents.filter((event) => event.code === "ShiftLeft");
    expect(firstShiftEvents[0]?.kind).toBe("keydown");
    expect(firstShiftEvents.at(-1)?.kind).toBe("keyup");
    expect(firstShiftEvents.filter((event) => event.kind === "keydown")).toHaveLength(
      firstShiftEvents.filter((event) => event.kind === "keyup").length
    );
    expect(firstShortcutEvents.filter((event) => event.code === "Digit2").map(
      (event) => event.kind
    )).toEqual(["keydown", "keyup"]);
    expect(firstShortcutEvents.filter((event) =>
      event.kind === "keydown" && event.code === "Digit2" && event.modifiers?.shift === true
    )).toHaveLength(1);
    expect(firstShortcutEvents.find((event) =>
      event.kind === "keydown" && event.code === "Digit2"
    )?.targetId).toBe("game-input-canvas");
    expect(firstShortcutEvents.filter((event) =>
      event.kind === "keydown" && event.code === "Digit1" && event.modifiers?.shift === false
    )).toHaveLength(1);
    expect(firstShortcutEvents.filter((event) =>
      event.kind === "keydown" && event.code === "Digit0" && event.modifiers?.shift === false
    )).toHaveLength(1);
    expect(firstShortcutEvents.filter((event) =>
      event.kind === "keydown" && event.code === "Digit3"
    )).toHaveLength(0);
    expect(firstShortcutEvents.every((event) =>
      (event.kind !== "keydown" && event.kind !== "keyup") || event.isTrusted === true
    )).toBe(true);
    const firstState = (await fixtureState())["macro-keyboard-a"];
    expect(firstState.pressedCodes).toEqual([]);
    expect(firstState.trustedPressedCodes).toEqual([]);
    expect(firstState.consumerPressedCodes).toEqual([]);
    expect(firstState.consumerChordActivations).toEqual(["Shift+Digit2"]);

    // The game-like consumer re-evaluates held digits on Shift keydown. If the
    // first managed lifecycle left Digit2 behind, this Shift-only canary would
    // deterministically add a second Shift+Digit2 activation.
    const canaryCursor = await fixtureCursor();
    await press("ShiftLeft");
    const canaryShiftDown = await waitFixtureCode({
      afterSequence: canaryCursor,
      code: "ShiftLeft",
      kind: "keydown",
      roleId: "macro-keyboard-a"
    });
    await release("ShiftLeft");
    await waitFixtureCode({
      afterSequence: canaryShiftDown.sequence,
      code: "ShiftLeft",
      kind: "keyup",
      roleId: "macro-keyboard-a"
    });
    await waitFixtureCode({
      afterSequence: canaryShiftDown.sequence,
      code: "ShiftLeft",
      kind: "consumer-keyup",
      roleId: "macro-keyboard-a"
    });
    const canaryState = (await fixtureState())["macro-keyboard-a"];
    expect(canaryState.consumerPressedCodes).toEqual([]);
    expect(canaryState.consumerChordActivations).toEqual(["Shift+Digit2"]);

    const secondShortcutCursor = await fixtureCursor();
    const secondDiagnosticCursor = (await probe()).latestSequence;
    const secondMacroCursor = await rendererEventCursor();
    await press("ShiftLeft");
    const secondShiftDown = await waitFixtureCode({
      afterSequence: secondShortcutCursor,
      code: "ShiftLeft",
      kind: "keydown",
      roleId: "macro-keyboard-a"
    });
    await press("Digit3");
    await release("ShiftLeft");
    await waitFixtureCode({
      afterSequence: secondShiftDown.sequence,
      code: "ShiftLeft",
      kind: "keyup",
      roleId: "macro-keyboard-a"
    });
    await release("Digit3");
    await waitForMacroProjection({
      afterSequence: secondMacroCursor,
      macroId: secondMacro.id,
      roleIds: [scenario.roles[0].id],
      state: "running"
    });

    await Promise.all([
      waitFixtureCode({
        afterSequence: secondShortcutCursor,
        code: "Digit1",
        kind: "keydown",
        roleId: "macro-keyboard-a"
      }),
      waitForMacroProjection({
        afterSequence: secondMacroCursor,
        macroId: secondMacro.id,
        minimumIteration: 1,
        roleIds: [scenario.roles[0].id]
      }),
      waitShortcutLifecycle({
        afterSequence: secondDiagnosticCursor,
        code: "Digit3",
        macroId: secondMacro.id,
        phase: "physical-keydown-managed",
        roleId: scenario.roles[0].id
      }),
      waitShortcutLifecycle({
        afterSequence: secondDiagnosticCursor,
        code: "Digit3",
        macroId: secondMacro.id,
        phase: "chord-released",
        roleId: scenario.roles[0].id
      }),
      waitShortcutLifecycle({
        afterSequence: secondDiagnosticCursor,
        code: "Digit3",
        macroId: secondMacro.id,
        phase: "managed-replay-acknowledged",
        roleId: scenario.roles[0].id
      }),
      waitManagedShortcutReceipt({
        afterSequence: secondDiagnosticCursor,
        code: "Digit3",
        macroId: secondMacro.id,
        phase: "replay",
        roleId: scenario.roles[0].id
      }),
      waitShortcutLifecycle({
        afterSequence: secondDiagnosticCursor,
        code: "Digit3",
        macroId: secondMacro.id,
        phase: "macro-dispatched",
        roleId: scenario.roles[0].id
      })
    ]);
    await waitForMacroProjection({
      absent: true,
      afterSequence: secondMacroCursor,
      macroId: secondMacro.id
    });
    await waitFixtureCode({
      afterSequence: secondShortcutCursor,
      code: "Digit1",
      kind: "consumer-keyup",
      roleId: "macro-keyboard-a"
    });

    const secondShortcutEvents = await fixtureEvents({
      afterSequence: secondShortcutCursor,
      roleId: "macro-keyboard-a"
    });
    const secondShiftEvents = secondShortcutEvents.filter((event) => event.code === "ShiftLeft");
    expect(secondShiftEvents[0]?.kind).toBe("keydown");
    expect(secondShiftEvents.at(-1)?.kind).toBe("keyup");
    expect(secondShiftEvents.filter((event) => event.kind === "keydown")).toHaveLength(
      secondShiftEvents.filter((event) => event.kind === "keyup").length
    );
    expect(secondShortcutEvents.filter((event) => event.code === "Digit3").map(
      (event) => event.kind
    )).toEqual(["keydown", "keyup"]);
    expect(secondShortcutEvents.filter((event) =>
      event.code === "Digit2" || event.code === "Digit0"
    )).toHaveLength(0);
    expect(secondShortcutEvents.filter((event) =>
      event.kind === "keydown" && event.code === "Digit3" && event.modifiers?.shift === true
    )).toHaveLength(1);
    expect(secondShortcutEvents.find((event) =>
      event.kind === "keydown" && event.code === "Digit3"
    )?.targetId).toBe("game-input-canvas");
    expect(secondShortcutEvents.filter((event) =>
      event.kind === "keydown" && event.code === "Digit1" && event.modifiers?.shift === true
    )).toHaveLength(1);
    const secondState = (await fixtureState())["macro-keyboard-a"];
    expect(secondState.pressedCodes).toEqual([]);
    expect(secondState.trustedPressedCodes).toEqual([]);
    expect(secondState.consumerPressedCodes).toEqual([]);
    expect(secondState.consumerChordActivations).toEqual([
      "Shift+Digit2",
      "Shift+Digit3",
      "Shift+Digit1"
    ]);
    const shortcutEvents = await fixtureEvents({
      afterSequence: shortcutFixtureCursor,
      roleId: "macro-keyboard-a"
    });
    expect(shortcutEvents.filter((event) =>
      event.kind === "keydown" && event.code === "Digit2" && event.modifiers?.shift === true
    )).toHaveLength(1);
    expect(shortcutEvents.filter((event) =>
      event.kind === "keydown" && event.code === "Digit0"
    )).toHaveLength(1);
    expect(shortcutEvents.filter((event) =>
      event.kind === "keydown" && event.code === "Digit3" && event.modifiers?.shift === true
    )).toHaveLength(1);
    expect(shortcutEvents.filter((event) =>
      event.kind === "keydown" && event.code === "Digit1" && event.modifiers?.shift === true
    )).toHaveLength(1);

    const compatibilityFixtureCursor = await fixtureCursor();
    const compatibilityNativeCursor = (await probe()).latestSequence;
    const compatibilityMacroCursor = await rendererEventCursor();
    await press("ShiftLeft");
    await waitFixtureCode({
      afterSequence: compatibilityFixtureCursor,
      code: "ShiftLeft",
      kind: "keydown",
      roleId: "macro-keyboard-a"
    });
    await press("Digit6");
    await release("Digit6");
    await release("ShiftLeft");
    await waitFixtureCode({
      afterSequence: compatibilityFixtureCursor,
      code: "ShiftLeft",
      kind: "keyup",
      roleId: "macro-keyboard-a"
    });
    await waitForMacroProjection({
      afterSequence: compatibilityMacroCursor,
      macroId: compatibilityMacro.id,
      roleIds: [scenario.roles[0].id],
      state: "running"
    });
    await Promise.all([
      waitMacroKeyReceipt({
        afterSequence: compatibilityNativeCursor,
        code: "Digit6",
        kind: "macro-key-native-acknowledged",
        phase: "keyup",
        roleId: scenario.roles[0].id
      }),
      waitMacroKeyReceipt({
        afterSequence: compatibilityNativeCursor,
        code: "Digit6",
        kind: "macro-key-dom-observed",
        phase: "keyup",
        roleId: scenario.roles[0].id
      }),
      waitForMacroProjection({
        afterSequence: compatibilityMacroCursor,
        macroId: compatibilityMacro.id,
        minimumIteration: 1,
        roleIds: [scenario.roles[0].id]
      })
    ]);
    await waitForMacroProjection({
      absent: true,
      afterSequence: compatibilityMacroCursor,
      macroId: compatibilityMacro.id
    });
    await waitFixtureCode({
      afterSequence: compatibilityFixtureCursor,
      code: "Digit6",
      kind: "consumer-keyup",
      roleId: "macro-keyboard-a"
    });
    const compatibilityEvents = await fixtureEvents({
      afterSequence: compatibilityFixtureCursor,
      roleId: "macro-keyboard-a"
    });
    expect(compatibilityEvents.filter((event) => event.code === "Digit6").map(
      (event) => event.kind
    )).toEqual(["keydown", "keyup", "keydown", "keyup"]);
    expect(compatibilityEvents.filter((event) =>
      event.kind === "keydown" && event.code === "Digit6" && event.modifiers?.shift === true
    )).toHaveLength(2);
    expect(compatibilityEvents.filter((event) =>
      (event.kind === "keydown" || event.kind === "keyup") && event.isTrusted !== true
    )).toHaveLength(0);
    expect((await fixtureState())["macro-keyboard-a"].trustedPressedCodes).toEqual([]);

    const continuityFixtureCursor = await fixtureCursor();
    const continuityMacroCursor = await rendererEventCursor();
    await press("ShiftLeft");
    await waitFixtureCode({
      afterSequence: continuityFixtureCursor,
      code: "ShiftLeft",
      kind: "keydown",
      roleId: "macro-keyboard-a"
    });
    await press("Digit5");
    const continuityTriggerDown = await waitFixtureCode({
      afterSequence: continuityFixtureCursor,
      code: "Digit5",
      kind: "keydown",
      roleId: "macro-keyboard-a"
    });
    await waitForMacroProjection({
      afterSequence: continuityMacroCursor,
      macroId: continuityMacro.id,
      roleIds: [scenario.roles[0].id],
      state: "running"
    });
    await release("Digit5");
    await waitFixtureCode({
      afterSequence: continuityTriggerDown.sequence,
      code: "Digit5",
      kind: "keyup",
      roleId: "macro-keyboard-a"
    });
    const continuityDigitOneDown = await waitFixtureCode({
      afterSequence: continuityFixtureCursor,
      code: "Digit1",
      kind: "keydown",
      roleId: "macro-keyboard-a"
    });
    await waitFixtureCode({
      afterSequence: continuityDigitOneDown.sequence,
      code: "Digit1",
      kind: "keyup",
      roleId: "macro-keyboard-a"
    });

    const digitFourCursor = await fixtureCursor();
    await press("Digit4");
    const digitFourDown = await waitFixtureCode({
      afterSequence: digitFourCursor,
      code: "Digit4",
      kind: "keydown",
      roleId: "macro-keyboard-a"
    });
    expect(digitFourDown.modifiers?.shift).toBe(true);
    await release("Digit4");
    await waitFixtureCode({
      afterSequence: digitFourDown.sequence,
      code: "Digit4",
      kind: "keyup",
      roleId: "macro-keyboard-a"
    });
    const shiftReleaseCursor = await fixtureCursor();
    await release("ShiftLeft");
    await waitFixtureCode({
      afterSequence: shiftReleaseCursor,
      code: "ShiftLeft",
      kind: "keyup",
      roleId: "macro-keyboard-a"
    });
    await waitForMacroProjection({
      afterSequence: continuityMacroCursor,
      macroId: continuityMacro.id,
      minimumIteration: 1,
      roleIds: [scenario.roles[0].id]
    });
    await waitForMacroProjection({
      absent: true,
      afterSequence: continuityMacroCursor,
      macroId: continuityMacro.id
    });

    const continuityEvents = await fixtureEvents({
      afterSequence: continuityFixtureCursor,
      roleId: "macro-keyboard-a"
    });
    expect(continuityEvents.filter((event) => event.code === "ShiftLeft").map(
      (event) => event.kind
    )).toEqual(["keydown", "keyup"]);
    expect(continuityEvents.filter((event) =>
      event.kind === "keydown" && event.code === "Digit1" && event.modifiers?.shift === true
    )).toHaveLength(1);
    expect((await fixtureState())["macro-keyboard-a"].pressedCodes).toEqual([]);

    const firstHoldCursor = await fixtureCursor();
    await press("Digit1");
    const firstDigitOneDown = await waitFixtureCode({
      afterSequence: firstHoldCursor,
      code: "Digit1",
      kind: "keydown",
      roleId: "macro-keyboard-a"
    });
    await activateVisibleRuntimeTab({
      tabId: tabB.id,
      windowGeneration: live.windowGeneration,
      windowId: tabA.windowId
    });
    await waitFixtureCode({
      afterSequence: firstDigitOneDown.sequence,
      code: "Digit1",
      kind: "keyup",
      roleId: "macro-keyboard-a"
    });
    expect((await fixtureState())["macro-keyboard-a"].pressedCodes).toEqual([]);
    expect((await fixtureEvents({
      afterSequence: firstDigitOneDown.sequence,
      roleId: "macro-keyboard-a"
    })).filter((event) => event.kind === "keyup" && event.code === "Digit1")).toHaveLength(1);
    await release("Digit1");

    const refocusCursor = await fixtureCursor();
    await activateVisibleRuntimeTab({
      tabId: tabA.id,
      windowGeneration: live.windowGeneration,
      windowId: tabA.windowId
    });
    await runtimeUiAction(tabA.windowId, {
      action: "focusRole",
      roleId: scenario.roles[0].id,
      tabId: tabA.id,
      windowGeneration: live.windowGeneration
    });
    await waitFixtureEvent({
      afterSequence: refocusCursor,
      kind: "focus",
      roleId: "macro-keyboard-a"
    });
    const secondHoldCursor = await fixtureCursor();
    await press("Digit1");
    const secondDigitOneDown = await waitFixtureCode({
      afterSequence: secondHoldCursor,
      code: "Digit1",
      kind: "keydown",
      roleId: "macro-keyboard-a"
    });
    const sidebar = await $(".app-main-sidebar");
    await sidebar.$("button*=Macros").click();
    await focusMainApplicationWindow();
    await waitFixtureCode({
      afterSequence: secondDigitOneDown.sequence,
      code: "Digit1",
      kind: "keyup",
      roleId: "macro-keyboard-a"
    });
    expect((await fixtureState())["macro-keyboard-a"].pressedCodes).toEqual([]);
    expect((await fixtureEvents({
      afterSequence: secondDigitOneDown.sequence,
      roleId: "macro-keyboard-a"
    })).filter((event) => event.kind === "keyup" && event.code === "Digit1")).toHaveLength(1);
    await release("Digit1");
  } finally {
    for (const code of [...heldCodes].reverse()) {
      await keyboardInput(code, "keyUp").catch(() => undefined);
    }
    await rendererCall("deleteMacro", continuityMacro.id).catch(() => undefined);
    await rendererCall("deleteMacro", compatibilityMacro.id).catch(() => undefined);
    await rendererCall("deleteMacro", secondMacro.id).catch(() => undefined);
    await rendererCall("deleteMacro", firstMacro.id).catch(() => undefined);
    await cleanup(scenario).catch(() => undefined);
  }
  await shutdownAndWaitForFlush();
}

describe("native macro runtime journeys", () => {
  it(`runs ${requireEnvironment("RION_STUDIO_E2E_PHASE")} with event-bound native evidence`, async () => {
    const phase = requireEnvironment("RION_STUDIO_E2E_PHASE");
    if (phase === "p0-macro-native-effect") await nativeEffectPhase();
    else if (phase === "p0-macro-keyboard-lifecycle") await keyboardLifecyclePhase();
    else if (phase === "p0-macro-background-tab") await backgroundTabPhase();
    else if (phase === "p1-macro-multirole") await multiRolePhase();
    else throw new Error(`Unknown native macro phase: ${phase}`);
  });
});
