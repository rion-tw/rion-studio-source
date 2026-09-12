import { expect } from "@wdio/globals";
import { Key } from "webdriverio";

import type { Macro } from "../../../src/shared/types";
import {
  electronDesktopE2eRuntimeTabReload,
  electronDesktopE2eTrustedInputRuntime,
  type ElectronDesktopE2eTrustedInputObservation
} from "../support/electron-driver";
import {
  clickVisibleElectronPageElement,
  submitElectronRoleKeyPhases,
  submitElectronRoleKeySequenceWithPause,
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
  installRuntimeTabShellErrorJournal,
  runtimeTabShellErrors
} from "../support/native-runtime-tabs";
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

function popupOauthCallbackUrl(): string {
  const url = new URL(macroFixtureUrl("e2e-oauth-callback"));
  url.searchParams.set("parentRoleId", ROLE_A_FIXTURE);
  return url.href;
}

function popupOauthProviderUrl(): string {
  const url = new URL(
    "/role/e2e-oauth-provider",
    "https://rion-drm.fixture.test"
  );
  url.searchParams.set("callback", popupOauthCallbackUrl());
  url.searchParams.set("parentRoleId", ROLE_A_FIXTURE);
  return url.href;
}

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

async function waitAppliedKeyObservation(input: Readonly<{
  afterSequence: number;
  code: string;
  intent: "cleanup" | "normal";
  phase: "hold" | "release" | "tap";
  roleId: string;
}>): Promise<ElectronDesktopE2eTrustedInputObservation> {
  let observation: ElectronDesktopE2eTrustedInputObservation | undefined;
  let observations: readonly ElectronDesktopE2eTrustedInputObservation[] = [];
  try {
    await browser.waitUntil(async () => {
      observations = await electronDesktopE2eTrustedInputRuntime(input.roleId);
      observation = [...observations].reverse().find((entry) =>
        entry.sequence > input.afterSequence &&
        entry.request.intent === input.intent &&
        entry.request.action.type === "key" &&
        entry.request.action.code === input.code &&
        entry.request.action.phase === input.phase &&
        entry.receipt.status === "applied");
      return observation !== undefined;
    }, {
      timeout: 20_000,
      timeoutMsg: `Missing applied ${input.code} ${input.intent} ${input.phase} receipt`
    });
  } catch (error) {
    const diagnostic = observations.filter((entry) => entry.sequence > input.afterSequence)
      .slice(-24)
      .map((entry) => ({
        action: entry.request.action,
        intent: entry.request.intent,
        receipt: entry.receipt,
        sequence: entry.sequence
      }));
    throw new Error(
      `Missing applied ${input.code} ${input.intent} ${input.phase} receipt; ` +
      `observations=${JSON.stringify(diagnostic)}`,
      { cause: error }
    );
  }
  return observation!;
}

async function createKeyboardMacros(roleId: string): Promise<Readonly<{
  continuity: Macro;
  middle: Macro;
  output: Macro;
  reentry: Macro;
}>> {
  const reentry = await rendererCall("createMacro", {
    activationMode: "press",
    enabled: true,
    name: "Chromium Shortcut Reentry",
    repeat: { type: "once" },
    roleIds: [roleId],
    shortcutSourceScope: { roleIds: [roleId], type: "selected_roles" },
    steps: [{
      action: "tap",
      code: "Digit1",
      id: "reentry-one",
      modifiers: ["shift"],
      type: "key"
    }],
    trigger: { alt: false, code: "Digit3", ctrl: false, meta: false, shift: true }
  });
  const continuity = await rendererCall("createMacro", {
    activationMode: "hold",
    enabled: true,
    name: "Chromium Modifier Continuity",
    repeat: { intervalMs: 0, type: "loop" },
    roleIds: [roleId],
    shortcutSourceScope: { roleIds: [roleId], type: "selected_roles" },
    steps: [
      { action: "tap", code: "Digit1", id: "continuity-one", type: "key" },
      { id: "continuity-stable-gap", ms: 30_000, type: "delay" }
    ],
    trigger: { alt: false, code: "Digit5", ctrl: false, meta: false, shift: true }
  });
  const middle = await rendererCall("createMacro", {
    activationMode: "press",
    enabled: true,
    name: "Chromium Middle Press",
    repeat: { intervalMs: 250, type: "loop" },
    roleIds: [roleId],
    shortcutSourceScope: { roleIds: [roleId], type: "selected_roles" },
    steps: [{ id: "middle-delay", ms: 250, type: "delay" }],
    trigger: { alt: false, button: "middle", ctrl: false, meta: false, shift: false }
  });
  const output = await rendererCall("createMacro", {
    activationMode: "press",
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
    activationMode: "hold",
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
  await installRuntimeTabShellErrorJournal();
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
  const reentryInputSequence = (await electronDesktopE2eTrustedInputRuntime(roleA.id))
    .at(-1)?.sequence ?? 0;
  await submitElectronRoleKeySequenceWithPause(
    roleA.launchUrl!,
    context.mainWindowHandle,
    [
      { key: Key.Shift, phase: "keyDown" },
      { key: "3", phase: "keyDown" }
    ],
    1_000,
    [
      { key: "3", phase: "keyUp" },
      { key: Key.Shift, phase: "keyUp" }
    ],
    { windowId: WINDOW_ID }
  );
  const pressedOne = await waitExactKey({
    afterSequence: reentryFixture,
    code: "Digit1",
    kind: "keydown",
    roleId: ROLE_A_FIXTURE
  });
  exactTrustedKey(pressedOne, "Digit1");
  expect(pressedOne.modifiers).toEqual(expect.objectContaining({ shift: true }));
  const triggerUp = await waitExactKey({
    afterSequence: reentryFixture,
    code: "Digit3",
    kind: "keyup",
    roleId: ROLE_A_FIXTURE
  });
  exactTrustedKey(triggerUp, "Digit3");
  expect(pressedOne.sequence).toBeLessThan(triggerUp.sequence);
  const firstChordEvents = await fixtureEvents({
    afterSequence: reentryFixture,
    roleId: ROLE_A_FIXTURE
  });
  expect(firstChordEvents.filter((event) =>
    event.kind === "keydown" && event.code === "Digit1"
  )).toHaveLength(1);
  const reentryRelease = await waitAppliedKeyObservation({
    afterSequence: reentryInputSequence,
    code: "Digit1",
    intent: "cleanup",
    phase: "release",
    roleId: roleA.id
  });
  expect(reentryRelease.receipt.confirmedInputNeutrality).toBe(false);
  const triggerRelease = await waitAppliedKeyObservation({
    afterSequence: reentryInputSequence,
    code: "Digit3",
    intent: "normal",
    phase: "release",
    roleId: roleA.id
  });
  expect(triggerRelease.receipt.confirmedInputNeutrality).toBe(true);
  expect(reentryRelease.sequence).toBeLessThan(triggerRelease.sequence);
  let modifierApplicationPaths: unknown[] = [];
  await browser.waitUntil(async () => {
    const entries = (await rendererCall("queryLogs", {
      levels: ["debug"],
      limit: 100,
      search: "trusted_input_terminal"
    })).entries;
    modifierApplicationPaths = entries
      .filter((entry) => entry.event === "trusted_input_terminal" &&
        entry.context?.roleId === roleA.id)
      .map((entry) => entry.context?.applicationPath);
    return modifierApplicationPaths.includes("physical-modifier-adoption") &&
      modifierApplicationPaths.includes("modifier-ownership-release");
  }, {
    timeout: 10_000,
    timeoutMsg: "Shift+3 did not persist modifier adoption and release terminal evidence"
  });

  const popupFenceFixture = await fixtureCursor();
  const trustedInputBeforePopup = await electronDesktopE2eTrustedInputRuntime(roleA.id);
  const trustedSurfaceGeneration = trustedInputBeforePopup.at(-1)?.receipt.surfaceGeneration;
  expect(trustedSurfaceGeneration).toBe(nativeBinding.surfaceGeneration);
  await clickVisibleElectronPageElement(
    roleA.launchUrl!,
    context.mainWindowHandle,
    "#named-oauth-popup"
  );
  expect(await waitFixtureEvent({
    afterSequence: popupFenceFixture,
    kind: "oauth-popup-requested",
    roleId: ROLE_A_FIXTURE
  })).toEqual(expect.objectContaining({
    isTrusted: true,
    oauth: expect.objectContaining({ windowProxyNonNull: true })
  }));
  await waitFixtureEvent({
    afterSequence: popupFenceFixture,
    kind: "oauth-provider-ready",
    roleId: "e2e-oauth-provider"
  });
  let focusedPopup: Awaited<ReturnType<
    typeof electronDesktopE2eRuntimeTabReload
  >>["popups"][number] | undefined;
  let popupNativeParentId: number | undefined;
  await browser.waitUntil(async () => {
    const inspection = await electronDesktopE2eRuntimeTabReload(WINDOW_ID);
    const popup = inspection.popups[0];
    if (!popup?.visible || popup.currentUrl !== popupOauthProviderUrl()) return false;
    focusedPopup = popup;
    popupNativeParentId = inspection.nativeWindow.parentNativeHostId;
    return true;
  }, {
    interval: 100,
    timeout: 20_000,
    timeoutMsg: "The shortcut-fence OAuth popup did not become visible"
  });
  expect(focusedPopup).toEqual(expect.objectContaining({
    appKitIdentity: null,
    hostKind: "electronBrowserWindow",
    nativeParentId: popupNativeParentId,
    openerPolicy: "connectedOpener",
    sessionMatchesOwner: true,
    title: "Rion Popup — rion-drm.fixture.test"
  }));

  await submitElectronRoleKeyPhases(
    popupOauthProviderUrl(),
    context.mainWindowHandle,
    [
      { key: Key.Shift, phase: "keyDown" },
      { key: "3", phase: "keyDown" },
      { key: "3", phase: "keyUp" },
      { key: Key.Shift, phase: "keyUp" }
    ],
    { focusCanvas: false, windowId: focusedPopup!.logicalWindowId }
  );
  expect(await waitExactKey({
    afterSequence: popupFenceFixture,
    code: "Digit3",
    kind: "keyup",
    roleId: "e2e-oauth-provider"
  })).toEqual(expect.objectContaining({
    code: "Digit3",
    isTrusted: true,
    roleId: "e2e-oauth-provider"
  }));
  expect((await fixtureEvents({
    afterSequence: popupFenceFixture,
    roleId: ROLE_A_FIXTURE
  })).filter((event) => event.kind === "keydown" && event.code === "Digit1"))
    .toEqual([]);
  expect(await electronDesktopE2eTrustedInputRuntime(roleA.id))
    .toEqual(trustedInputBeforePopup);

  await clickVisibleElectronPageElement(
    popupOauthProviderUrl(),
    context.mainWindowHandle,
    "#oauth-provider-continue"
  );
  await waitFixtureEvent({
    afterSequence: popupFenceFixture,
    kind: "oauth-login-complete",
    roleId: ROLE_A_FIXTURE
  });
  await browser.waitUntil(async () =>
    (await electronDesktopE2eRuntimeTabReload(WINDOW_ID)).popups.length === 0, {
    interval: 100,
    timeout: 20_000,
    timeoutMsg: "The shortcut-fence OAuth popup did not close"
  });
  expect(await expectChromiumNativeRoleBinding(context, tabA)).toEqual(nativeBinding);

  const releasedReentryFixture = await fixtureCursor();
  await submitElectronRoleKeyPhases(roleA.launchUrl!, context.mainWindowHandle, [
    { key: Key.Shift, phase: "keyDown" },
    { key: "3", phase: "keyDown" },
    { key: "3", phase: "keyUp" },
    { key: Key.Shift, phase: "keyUp" }
  ], { windowId: WINDOW_ID });
  exactTrustedKey(await waitExactKey({
    afterSequence: releasedReentryFixture,
    code: "Digit1",
    kind: "keydown",
    roleId: ROLE_A_FIXTURE
  }), "Digit1");
  const trustedInputAfterPopup = await electronDesktopE2eTrustedInputRuntime(roleA.id);
  expect(trustedInputAfterPopup.length).toBeGreaterThan(trustedInputBeforePopup.length);
  expect(trustedInputAfterPopup.at(-1)?.receipt).toEqual(expect.objectContaining({
    roleId: roleA.id,
    status: "applied",
    surfaceGeneration: trustedSurfaceGeneration
  }));

  const continuityFixture = await fixtureCursor();
  const continuityProjection = await rendererEventCursor();
  await submitElectronRoleKeyPhases(roleA.launchUrl!, context.mainWindowHandle, [
    { key: Key.Shift, phase: "keyDown" },
    { key: "5", phase: "keyDown" }
  ], { windowId: WINDOW_ID });
  await waitForMacroProjection({
    afterSequence: continuityProjection,
    macroId: macros.continuity.id,
    roleIds: [roleA.id],
    state: "running"
  });
  exactTrustedKey(await waitExactKey({
    afterSequence: continuityFixture,
    code: "Digit1",
    kind: "keyup",
    roleId: ROLE_A_FIXTURE
  }), "Digit1");
  await activateChromiumRoleVisible(context, tabB);
  await activateChromiumRoleVisible(context, tabA);
  await submitElectronRoleKeyPhases(roleA.launchUrl!, context.mainWindowHandle, [
    { key: "4", phase: "keyDown" },
    { key: "4", phase: "keyUp" },
    { key: "5", phase: "keyUp" },
    { key: Key.Shift, phase: "keyUp" }
  ], { windowId: WINDOW_ID, focusCanvas: false });
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
  ], { windowId: WINDOW_ID });
  expect(await waitExactKey({
    afterSequence: blurFixture,
    code: "KeyQ",
    kind: "keydown",
    roleId: ROLE_A_FIXTURE
  })).toEqual(expect.objectContaining({
    isTrusted: true,
    targetId: "game-input-canvas"
  }));
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
  ], { windowId: WINDOW_ID, focusCanvas: false });
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
  expect(await runtimeTabShellErrors()).toEqual([]);
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
