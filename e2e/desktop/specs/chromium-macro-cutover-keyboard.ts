import { expect } from "@wdio/globals";
import { Key } from "webdriverio";

import type { Macro } from "../../../src/shared/types";
import {
  electronDesktopE2eTrustedInputRuntime
} from "../support/electron-driver";
import {
  submitElectronRoleKeyPhases,
  submitElectronRoleMiddleButtonPhase
} from "../support/electron-role-surface";
import {
  fixtureCursor,
  fixtureEvents,
  fixtureState,
  waitFixtureEvent,
  type FixtureEvent
} from "../support/fixture";
import { rendererCall } from "../support/renderer-bridge";
import {
  rendererEventCursor,
  waitForMacroProjection
} from "../support/renderer-events";
import {
  activateChromiumRoleVisible,
  bootstrapChromiumMacroCutover,
  createChromiumMacroWindow,
  expectChromiumNativeRoleBinding,
  launchChromiumRoleVisible,
  macroFixtureUrl,
  showChromiumMacroWindow,
  startChromiumMacroVisible,
  writeChromiumMacroEvidence
} from "./chromium-macro-cutover-support";

const WINDOW_ID = "c8e00000-0000-4000-8000-000000000021";
const ROLE_A_FIXTURE = "macro-keyboard-a";
const ROLE_B_FIXTURE = "macro-keyboard-b";
const ROLE_A_CONTEXT_QUERY = "resetConsumerInputOnContextLoss=1";

async function waitExactKey(input: Readonly<{
  afterSequence: number;
  code: string;
  kind: "keydown" | "keyup";
  roleId: string;
}>): Promise<FixtureEvent> {
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

function exactTrustedKey(event: FixtureEvent, code: string): void {
  expect(event).toEqual(expect.objectContaining({ code, isTrusted: true }));
}

async function createKeyboardMacros(roleId: string): Promise<Readonly<{
  continuity: Macro;
  middle: Macro;
  output: Macro;
  reentry: Macro;
}>> {
  const reentry = await rendererCall("createMacro", {
    activationMode: "toggle",
    enabled: true,
    name: "Chromium Shortcut Reentry",
    repeat: { type: "once" },
    roleIds: [roleId],
    shortcutSourceScope: { roleIds: [roleId], type: "selected_roles" },
    steps: [{ action: "tap", code: "Digit1", id: "reentry-one", type: "key" }],
    trigger: { alt: false, code: "Digit2", ctrl: false, meta: false, shift: true }
  });
  const continuity = await rendererCall("createMacro", {
    activationMode: "while_held",
    enabled: true,
    name: "Chromium Modifier Continuity",
    repeat: { intervalMs: 250, type: "loop" },
    roleIds: [roleId],
    shortcutSourceScope: { roleIds: [roleId], type: "selected_roles" },
    steps: [{ action: "tap", code: "Digit1", id: "continuity-one", type: "key" }],
    trigger: { alt: false, code: "Digit5", ctrl: false, meta: false, shift: true }
  });
  const middle = await rendererCall("createMacro", {
    activationMode: "toggle",
    enabled: true,
    name: "Chromium Middle Toggle",
    repeat: { intervalMs: 250, type: "loop" },
    roleIds: [roleId],
    shortcutSourceScope: { roleIds: [roleId], type: "selected_roles" },
    steps: [{ id: "middle-delay", ms: 250, type: "delay" }],
    trigger: { alt: false, button: "middle", ctrl: false, meta: false, shift: false }
  });
  const output = await rendererCall("createMacro", {
    activationMode: "toggle",
    enabled: true,
    name: "Chromium Three Button Output",
    repeat: { type: "once" },
    roleIds: [roleId],
    steps: [
      { button: "left", id: "left", type: "click", xPercent: 50, yPercent: 50 },
      { button: "middle", id: "middle", type: "click", xPercent: 50, yPercent: 50 },
      { button: "right", id: "right", type: "click", xPercent: 50, yPercent: 50 }
    ]
  });
  return { continuity, middle, output, reentry };
}

async function createMiddleHeldMacro(roleId: string): Promise<Macro> {
  return rendererCall("createMacro", {
    activationMode: "while_held",
    enabled: true,
    name: "Chromium Middle Held",
    repeat: { intervalMs: 250, type: "loop" },
    roleIds: [roleId],
    shortcutSourceScope: { roleIds: [roleId], type: "selected_roles" },
    steps: [{ id: "middle-held-delay", ms: 250, type: "delay" }],
    trigger: { alt: false, button: "middle", ctrl: false, meta: false, shift: false }
  });
}

export async function runChromiumMacroKeyboardCutover(): Promise<void> {
  const context = await bootstrapChromiumMacroCutover();
  const game = await rendererCall("createGame", {
    defaultLaunchUrl: macroFixtureUrl(ROLE_A_FIXTURE, ROLE_A_CONTEXT_QUERY),
    name: "Chromium Macro Keyboard Game"
  });
  const roleA = await rendererCall("createRole", {
    gameId: game.id,
    launchUrl: macroFixtureUrl(ROLE_A_FIXTURE, ROLE_A_CONTEXT_QUERY),
    name: "Chromium Macro Keyboard Role A"
  });
  const roleB = await rendererCall("createRole", {
    gameId: game.id,
    launchUrl: macroFixtureUrl(ROLE_B_FIXTURE),
    name: "Chromium Macro Keyboard Role B"
  });
  const macros = await createKeyboardMacros(roleA.id);
  const middleHeld = await createMiddleHeldMacro(roleB.id);
  const window = await createChromiumMacroWindow(WINDOW_ID, "Chromium Macro Keyboard");
  await showChromiumMacroWindow(window);
  const tabA = await launchChromiumRoleVisible(roleA, ROLE_A_FIXTURE, window);
  const tabB = await launchChromiumRoleVisible(roleB, ROLE_B_FIXTURE, window);
  await activateChromiumRoleVisible(context, tabA);
  const nativeBinding = await expectChromiumNativeRoleBinding(context, tabA);

  const reentryFixture = await fixtureCursor();
  await submitElectronRoleKeyPhases(roleA.launchUrl!, context.mainWindowHandle, [
    { key: Key.Shift, phase: "keyDown" },
    { key: "2", phase: "keyDown" }
  ]);
  await submitElectronRoleKeyPhases(roleA.launchUrl!, context.mainWindowHandle, [
    { key: "2", phase: "keyUp" },
    { key: Key.Shift, phase: "keyUp" }
  ], { focusCanvas: false });
  const replayedOne = await waitExactKey({
    afterSequence: reentryFixture,
    code: "Digit1",
    kind: "keydown",
    roleId: ROLE_A_FIXTURE
  });
  exactTrustedKey(replayedOne, "Digit1");
  const firstChordEvents = await fixtureEvents({
    afterSequence: reentryFixture,
    roleId: ROLE_A_FIXTURE
  });
  expect(firstChordEvents.filter((event) =>
    event.kind === "keydown" && event.code === "Digit1"
  )).toHaveLength(1);

  const releasedReentryFixture = await fixtureCursor();
  await submitElectronRoleKeyPhases(roleA.launchUrl!, context.mainWindowHandle, [
    { key: Key.Shift, phase: "keyDown" },
    { key: "2", phase: "keyDown" },
    { key: "2", phase: "keyUp" },
    { key: Key.Shift, phase: "keyUp" }
  ]);
  exactTrustedKey(await waitExactKey({
    afterSequence: releasedReentryFixture,
    code: "Digit1",
    kind: "keydown",
    roleId: ROLE_A_FIXTURE
  }), "Digit1");

  const continuityFixture = await fixtureCursor();
  const continuityProjection = await rendererEventCursor();
  await submitElectronRoleKeyPhases(roleA.launchUrl!, context.mainWindowHandle, [
    { key: Key.Shift, phase: "keyDown" },
    { key: "5", phase: "keyDown" }
  ]);
  await waitForMacroProjection({
    afterSequence: continuityProjection,
    macroId: macros.continuity.id,
    roleIds: [roleA.id],
    state: "running"
  });
  await activateChromiumRoleVisible(context, tabB);
  await activateChromiumRoleVisible(context, tabA);
  await submitElectronRoleKeyPhases(roleA.launchUrl!, context.mainWindowHandle, [
    { key: "4", phase: "keyDown" },
    { key: "4", phase: "keyUp" },
    { key: "5", phase: "keyUp" },
    { key: Key.Shift, phase: "keyUp" }
  ], { focusCanvas: false });
  const shiftedFour = await waitExactKey({
    afterSequence: continuityFixture,
    code: "Digit4",
    kind: "keydown",
    roleId: ROLE_A_FIXTURE
  });
  expect(shiftedFour).toEqual(expect.objectContaining({
    isTrusted: true,
    modifiers: expect.objectContaining({ shift: true })
  }));
  await waitForMacroProjection({
    absent: true,
    afterSequence: continuityProjection,
    macroId: macros.continuity.id
  });

  const blurFixture = await fixtureCursor();
  await submitElectronRoleKeyPhases(roleA.launchUrl!, context.mainWindowHandle, [
    { key: "q", phase: "keyDown" }
  ]);
  await activateChromiumRoleVisible(context, tabB);
  const blurRelease = await waitExactKey({
    afterSequence: blurFixture,
    code: "KeyQ",
    kind: "keyup",
    roleId: ROLE_A_FIXTURE
  });
  expect(blurRelease).toEqual(expect.objectContaining({
    code: "KeyQ",
    isTrusted: false,
    targetId: "game-input-canvas"
  }));
  await submitElectronRoleKeyPhases(roleB.launchUrl!, context.mainWindowHandle, [
    { key: "q", phase: "keyUp" }
  ], { focusCanvas: false });
  await activateChromiumRoleVisible(context, tabA);

  const middleFixture = await fixtureCursor();
  const middleProjection = await rendererEventCursor();
  await submitElectronRoleMiddleButtonPhase(
    roleA.launchUrl!, context.mainWindowHandle, "mouseDown"
  );
  await submitElectronRoleMiddleButtonPhase(
    roleA.launchUrl!, context.mainWindowHandle, "mouseUp"
  );
  await waitForMacroProjection({
    afterSequence: middleProjection,
    macroId: macros.middle.id,
    roleIds: [roleA.id],
    state: "running"
  });
  await submitElectronRoleMiddleButtonPhase(
    roleA.launchUrl!, context.mainWindowHandle, "mouseDown"
  );
  await submitElectronRoleMiddleButtonPhase(
    roleA.launchUrl!, context.mainWindowHandle, "mouseUp"
  );
  await waitForMacroProjection({
    absent: true,
    afterSequence: middleProjection,
    macroId: macros.middle.id
  });
  expect((await fixtureEvents({
    afterSequence: middleFixture,
    roleId: ROLE_A_FIXTURE
  })).filter((event) => ["mousedown", "mouseup", "auxclick"].includes(event.kind)))
    .toHaveLength(0);

  await rendererCall("deleteMacro", macros.middle.id);
  await activateChromiumRoleVisible(context, tabB);
  const heldFixture = await fixtureCursor();
  const heldProjection = await rendererEventCursor();
  await submitElectronRoleMiddleButtonPhase(
    roleB.launchUrl!, context.mainWindowHandle, "mouseDown"
  );
  await waitForMacroProjection({
    afterSequence: heldProjection,
    macroId: middleHeld.id,
    roleIds: [roleB.id],
    state: "running"
  });
  await submitElectronRoleMiddleButtonPhase(
    roleB.launchUrl!, context.mainWindowHandle, "mouseUp"
  );
  await waitForMacroProjection({
    absent: true,
    afterSequence: heldProjection,
    macroId: middleHeld.id
  });
  expect((await fixtureEvents({
    afterSequence: heldFixture,
    roleId: ROLE_B_FIXTURE
  })).filter((event) => ["mousedown", "mouseup", "auxclick"].includes(event.kind)))
    .toHaveLength(0);
  await activateChromiumRoleVisible(context, tabA);

  const outputFixture = await fixtureCursor();
  const outputCursor = await startChromiumMacroVisible(macros.output, [roleA.id]);
  const [left, middle, right] = await Promise.all([
    waitFixtureEvent({ afterSequence: outputFixture, kind: "click", roleId: ROLE_A_FIXTURE }),
    waitFixtureEvent({ afterSequence: outputFixture, kind: "auxclick", roleId: ROLE_A_FIXTURE }),
    waitFixtureEvent({
      afterSequence: outputFixture,
      kind: "contextmenu",
      roleId: ROLE_A_FIXTURE
    })
  ]);
  expect([left, middle, right].map((event) => ({
    button: event.button,
    isTrusted: event.isTrusted
  }))).toEqual([
    { button: 0, isTrusted: true },
    { button: 1, isTrusted: true },
    { button: 2, isTrusted: true }
  ]);
  await waitForMacroProjection({
    absent: true,
    afterSequence: outputCursor,
    macroId: macros.output.id
  });

  const finalState = (await fixtureState())[ROLE_A_FIXTURE];
  expect(finalState?.pressedCodes).toEqual([]);
  expect(finalState?.consumerPressedCodes).toEqual([]);
  const trustedInput = await electronDesktopE2eTrustedInputRuntime(roleA.id);
  expect(trustedInput.every((entry) => entry.receipt.status === "applied")).toBe(true);
  await writeChromiumMacroEvidence("chromium-macro-keyboard-cutover-evidence.json", {
    nativeBinding,
    platform: context.platform,
    roleAId: roleA.id,
    roleBId: roleB.id,
    tabA: tabA.tabId,
    tabB: tabB.tabId,
    trustedInput
  });
}
