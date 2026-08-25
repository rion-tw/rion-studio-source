import { browser, expect } from "@wdio/globals";

import type { Macro } from "../../../src/shared/types";
import {
  keyboardInput,
  probe,
  runtimeUiAction,
  windowSnapshot,
  waitEvent
} from "../support/control";
import {
  fixtureCursor,
  fixtureEvents,
  fixtureState,
  waitFixtureEvent
} from "../support/fixture";
import {
  rendererEventCursor,
  waitForMacroProjection
} from "../support/renderer-events";

interface RuntimeTabRef {
  id: string;
  sourceId: string;
  windowId: string;
}

export async function activateVisibleRuntimeTab(input: {
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

export async function verifyTrustedNeutralState(input: {
  afterSequence: number;
  codes: string[];
  fixtureRoleId: string;
}): Promise<void> {
  const state = (await fixtureState())[input.fixtureRoleId];
  expect(state.pressedCodes).toEqual([]);
  expect(state.trustedPressedCodes).toEqual([]);
  expect(state.consumerPressedCodes).toEqual([]);
  const events = await fixtureEvents({
    afterSequence: input.afterSequence,
    roleId: input.fixtureRoleId
  });
  for (const code of input.codes) {
    expect(events.filter((event) =>
      event.kind === "keyup" && event.code === code && event.isTrusted === true
    )).toHaveLength(1);
  }
}

export async function verifyRuntimeTabModifierHandoff(input: {
  press(code: string): Promise<void>;
  release(code: string): Promise<void>;
  tabA: RuntimeTabRef;
  tabB: RuntimeTabRef;
  windowGeneration: number;
}): Promise<void> {
  const forwardCursor = await fixtureCursor();
  await input.press("ControlLeft");
  await input.press("Tab");
  await browser.waitUntil(async () =>
    (await windowSnapshot(input.tabA.windowId)).kernel?.selectedTabId === input.tabB.id,
  { timeout: 20_000, timeoutMsg: "Ctrl+Tab did not select the next runtime tab" });
  await input.release("Tab");
  await input.release("ControlLeft");
  const forwardUp = await waitFixtureCode({
    afterSequence: forwardCursor,
    code: "ControlLeft",
    kind: "keyup",
    roleId: "macro-keyboard-a"
  });
  expect(forwardUp.isTrusted).toBe(true);
  expect((await fixtureEvents({
    afterSequence: forwardCursor,
    roleId: "macro-keyboard-a"
  })).filter((event) => event.code === "ControlLeft" && event.kind === "keyup"))
    .toHaveLength(1);
  await runtimeUiAction(input.tabB.windowId, {
    action: "focusRole",
    roleId: input.tabB.sourceId,
    tabId: input.tabB.id,
    windowGeneration: input.windowGeneration
  });

  const reverseCursor = await fixtureCursor();
  await input.press("ControlRight");
  await input.press("ShiftRight");
  await input.press("Tab");
  await browser.waitUntil(async () =>
    (await windowSnapshot(input.tabA.windowId)).kernel?.selectedTabId === input.tabA.id,
  { timeout: 20_000, timeoutMsg: "Ctrl+Shift+Tab did not select the previous runtime tab" });
  await input.release("Tab");
  await input.release("ShiftRight");
  await input.release("ControlRight");
  const shiftUp = await waitFixtureCode({
    afterSequence: reverseCursor,
    code: "ShiftRight",
    kind: "keyup",
    roleId: "macro-keyboard-b"
  });
  const controlUp = await waitFixtureCode({
    afterSequence: shiftUp.sequence,
    code: "ControlRight",
    kind: "keyup",
    roleId: "macro-keyboard-b"
  });
  expect(shiftUp.isTrusted).toBe(true);
  expect(controlUp.isTrusted).toBe(true);
  const events = await fixtureEvents({
    afterSequence: reverseCursor,
    roleId: "macro-keyboard-b"
  });
  expect(events.filter((event) =>
    event.kind === "keyup" && event.code === "ShiftRight"
  )).toHaveLength(1);
  expect(events.filter((event) =>
    event.kind === "keyup" && event.code === "ControlRight"
  )).toHaveLength(1);
  await runtimeUiAction(input.tabA.windowId, {
    action: "focusRole",
    roleId: input.tabA.sourceId,
    tabId: input.tabA.id,
    windowGeneration: input.windowGeneration
  });
}

export async function verifyManagedHeldTabDeparture(input: {
  fixtureRoleId: string;
  macro: Pick<Macro, "id">;
  press(code: string): Promise<void>;
  release(code: string): Promise<void>;
  roleId: string;
  tabA: RuntimeTabRef;
  tabB: RuntimeTabRef;
  windowGeneration: number;
}): Promise<void> {
  const fixtureAfter = await fixtureCursor();
  const nativeAfter = (await probe()).latestSequence;
  const macroAfter = await rendererEventCursor();
  await input.press("ShiftLeft");
  await input.press("Digit5");
  await waitManagedShortcutReceipt({
    afterSequence: nativeAfter,
    code: "Digit5",
    macroId: input.macro.id,
    phase: "keyDown",
    roleId: input.roleId
  });
  await waitForMacroProjection({
    afterSequence: macroAfter,
    macroId: input.macro.id,
    roleIds: [input.roleId],
    state: "running"
  });
  await activateVisibleRuntimeTab({
    tabId: input.tabB.id,
    windowGeneration: input.windowGeneration,
    windowId: input.tabA.windowId
  });
  await waitManagedShortcutReceipt({
    afterSequence: nativeAfter,
    code: "Digit5",
    macroId: input.macro.id,
    phase: "keyUp",
    roleId: input.roleId
  });
  const mainUp = await waitFixtureCode({
    afterSequence: fixtureAfter,
    code: "Digit5",
    kind: "keyup",
    roleId: input.fixtureRoleId
  });
  await waitFixtureCode({
    afterSequence: mainUp.sequence,
    code: "ShiftLeft",
    kind: "keyup",
    roleId: input.fixtureRoleId
  });
  expect((await windowSnapshot(input.tabA.windowId)).kernel?.selectedTabId).toBe(input.tabB.id);
  const state = (await fixtureState())[input.fixtureRoleId];
  expect(state.pressedCodes).toEqual([]);
  expect(state.trustedPressedCodes).toEqual([]);
  expect(state.consumerPressedCodes).toEqual([]);
  await input.release("Digit5");
  await input.release("ShiftLeft");
  await waitForMacroProjection({ absent: true, afterSequence: macroAfter, macroId: input.macro.id });
  await activateVisibleRuntimeTab({
    tabId: input.tabA.id,
    windowGeneration: input.windowGeneration,
    windowId: input.tabA.windowId
  });
  await runtimeUiAction(input.tabA.windowId, {
    action: "focusRole",
    roleId: input.roleId,
    tabId: input.tabA.id,
    windowGeneration: input.windowGeneration
  });
}

export async function verifyWorkspaceRoleFocusDeparture(input: {
  sourceFixtureRoleId: string;
  sourceRoleId: string;
  tab: RuntimeTabRef;
  targetFixtureRoleId: string;
  targetRoleId: string;
  windowGeneration: number;
}): Promise<void> {
  const sourceFocusAfter = await fixtureCursor();
  await runtimeUiAction(input.tab.windowId, {
    action: "clickRoleContent",
    roleId: input.sourceRoleId,
    tabId: input.tab.id,
    windowGeneration: input.windowGeneration
  });
  await waitFixtureEvent({
    afterSequence: sourceFocusAfter,
    kind: "click",
    roleId: input.sourceFixtureRoleId
  });
  const departureAfter = await fixtureCursor();
  await keyboardInput("ShiftLeft", "keyDown");
  await keyboardInput("KeyB", "keyDown");
  try {
    await waitFixtureCode({
      afterSequence: departureAfter,
      code: "KeyB",
      kind: "keydown",
      roleId: input.sourceFixtureRoleId
    });
    const targetFocusAfter = await fixtureCursor();
    await runtimeUiAction(input.tab.windowId, {
      action: "clickRoleContent",
      roleId: input.targetRoleId,
      tabId: input.tab.id,
      windowGeneration: input.windowGeneration
    });
    await waitFixtureEvent({
      afterSequence: targetFocusAfter,
      kind: "click",
      roleId: input.targetFixtureRoleId
    });
    const keyUp = await waitFixtureCode({
      afterSequence: departureAfter,
      code: "KeyB",
      kind: "keyup",
      roleId: input.sourceFixtureRoleId
    });
    await waitFixtureCode({
      afterSequence: keyUp.sequence,
      code: "ShiftLeft",
      kind: "keyup",
      roleId: input.sourceFixtureRoleId
    });
    const state = (await fixtureState())[input.sourceFixtureRoleId];
    expect(state.pressedCodes).toEqual([]);
    expect(state.trustedPressedCodes).toEqual([]);
    expect(state.consumerPressedCodes).toEqual([]);
    const events = await fixtureEvents({
      afterSequence: departureAfter,
      roleId: input.sourceFixtureRoleId
    });
    expect(events.filter((event) =>
      event.kind === "keyup" && event.code === "KeyB" && event.isTrusted === true
    )).toHaveLength(1);
    expect(events.filter((event) =>
      event.kind === "keyup" && event.code === "ShiftLeft" && event.isTrusted === true
    )).toHaveLength(1);
  } finally {
    await keyboardInput("KeyB", "keyUp").catch(() => undefined);
    await keyboardInput("ShiftLeft", "keyUp").catch(() => undefined);
  }
}

export async function waitFixtureCode(input: {
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

export async function waitMacroKeyReceipt(input: {
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

export async function waitShortcutLifecycle(input: {
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

export async function waitManagedShortcutReceipt(input: {
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
