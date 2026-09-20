import { exerciseModifierReconciliation } from "./chromium-macro-modifier-reconciliation";
import { expect } from "@wdio/globals";
import { Key } from "webdriverio";
import { exerciseCompatibleAltShortcuts } from "./chromium-macro-compatible-alt";

import type { Macro } from "../../../src/shared/types";
import {
  electronDesktopE2eProbe,
  electronDesktopE2eRuntimeTabReload,
  electronDesktopE2eTrustedInputRuntime,
  type ElectronDesktopE2eTrustedInputObservation
} from "../support/electron-driver";
import {
  clickVisibleElectronPageElement,
  readVisibleElectronCanvasPoint,
  submitElectronRoleKeyPhases,
  submitElectronRoleKeySequenceWithPause,
  submitElectronRoleMiddleButtonPhase
} from "../support/electron-role-surface";
import { clickMacosVisibleRoleControl } from "../support/macos-appkit-ui";
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
import { pressVisibleMacosRoleKey, pressVisibleWindowsApplicationShortcut } from
  "../support/native-application-actions";
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

function exactCompatibleKey(event: FixtureEvent, code: string): void {
  expect(event).toEqual(expect.objectContaining({ code, isTrusted: false }));
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

type RapidShortcutOrder = "Digit2ThenDigit3" | "Digit3ThenDigit2";

async function exerciseRapidShiftShortcuts(input: Readonly<{
  collisionMacroId: string;
  launchUrl: string;
  mainWindowHandle: string;
  order: RapidShortcutOrder;
  platform: "macos" | "windows";
  reentryMacroId: string;
  roleId: string;
  roleName: string;
}>): Promise<void> {
  const collisionFixture = await fixtureCursor();
  const collisionProjection = await rendererEventCursor();
  let releaseNativeShift: (() => Promise<void>) | undefined;
  const [firstKey, secondKey] = input.order === "Digit2ThenDigit3"
    ? ["2", "3"] as const
    : ["3", "2"] as const;
  let collisionEvents: readonly FixtureEvent[] = [];
  try {
    if (input.platform === "macos") {
      const processId = (await electronDesktopE2eProbe()).processId;
      await clickMacosVisibleRoleControl(
        WINDOW_ID,
        input.roleId,
        await readVisibleElectronCanvasPoint(input.launchUrl, input.mainWindowHandle)
      );
      releaseNativeShift = () => pressVisibleMacosRoleKey({
        code: "ShiftUp",
        processId,
        runtimeTabName: input.roleName,
        runtimeWindowId: WINDOW_ID
      });
      await pressVisibleMacosRoleKey({
        code: input.order === "Digit2ThenDigit3"
          ? "Shift+Digit2ThenDigit3Hold"
          : "Shift+Digit3ThenDigit2Hold",
        processId,
        runtimeTabName: input.roleName,
        runtimeWindowId: WINDOW_ID
      });
    } else {
      const processId = (await electronDesktopE2eProbe()).processId;
      await submitElectronRoleKeyPhases(input.launchUrl, input.mainWindowHandle, [], { windowId: WINDOW_ID });
      releaseNativeShift = () => pressVisibleWindowsApplicationShortcut({
        command: "shiftUp", processId, targetMode: "focused-runtime"
      });
      await pressVisibleWindowsApplicationShortcut({
        command: input.order === "Digit2ThenDigit3" ? "shiftDigit2ThenDigit3Hold" : "shiftDigit3ThenDigit2Hold",
        processId, targetMode: "focused-runtime"
      });
    }
    await browser.waitUntil(async () => {
      collisionEvents = await fixtureEvents({
        afterSequence: collisionFixture,
        roleId: ROLE_A_FIXTURE
      });
      const exact = (kind: "keydown" | "keyup", code: string, key: string,
        shift: boolean): boolean => collisionEvents.some((event) =>
        event.kind === kind && event.code === code && event.key === key &&
        event.isTrusted === false && event.modifiers?.shift === shift);
      return exact("keydown", "Digit2", "@", true) &&
        exact("keyup", "Digit2", "@", true) &&
        exact("keydown", "Digit0", ")", true) &&
        exact("keyup", "Digit0", ")", true) &&
        exact("keydown", "Digit1", "!", true) &&
        exact("keyup", "Digit1", "!", true);
    }, {
      timeout: 20_000,
      timeoutMsg: `Rapid Shift+${firstKey} then Shift+${secondKey} left a macro key sequence incomplete`
    });
  } catch (error) {
    throw new Error(
      `Rapid shortcut diagnostics=${JSON.stringify({
        events: collisionEvents,
        observations: (await electronDesktopE2eTrustedInputRuntime(input.roleId)).slice(-24),
        order: input.order,
        statuses: (await rendererCall("listMacroStatuses")).filter((status) =>
          status.macroId === input.collisionMacroId || status.macroId === input.reentryMacroId)
      })}`,
      { cause: error }
    );
  } finally {
    await releaseNativeShift?.();
  }
  expect(collisionEvents.filter((event) =>
    (event.kind === "keydown" || event.kind === "keyup") &&
    event.code === "Digit0" && event.key === ")" &&
    event.modifiers?.shift === true
  ).map((event) => event.kind)).toEqual(["keydown", "keyup"]);
  await waitForMacroProjection({
    absent: true,
    afterSequence: collisionProjection,
    macroId: input.collisionMacroId
  });
  await waitForMacroProjection({
    absent: true,
    afterSequence: collisionProjection,
    macroId: input.reentryMacroId
  });
  await browser.waitUntil(async () => {
    const state = (await fixtureState())[ROLE_A_FIXTURE];
    return state?.pressedCodes.length === 0 &&
      state.consumerPressedCodes.length === 0;
  }, {
    timeout: 5_000,
    timeoutMsg: `Rapid ${input.order} physical and consumer keys did not become neutral`
  });
}

async function createKeyboardMacros(roleId: string): Promise<Readonly<{
  collision: Macro;
  continuity: Macro;
  middle: Macro;
  output: Macro;
  reentry: Macro;
}>> {
  const collision = await rendererCall("createMacro", {
    activationMode: "press",
    enabled: true,
    name: "Chromium Shortcut Collision",
    repeat: { type: "once" },
    roleIds: [roleId],
    shortcutSourceScope: { roleIds: [roleId], type: "selected_roles" },
    steps: [
      { action: "tap", code: "Digit2", id: "collision-two", type: "key" },
      { action: "tap", code: "Digit0", id: "collision-zero", type: "key" }
    ],
    trigger: { alt: false, code: "Digit2", ctrl: false, meta: false, shift: true }
  });
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
  return { collision, continuity, middle, output, reentry };
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

async function exerciseRepeatedShiftShortcut(input: Readonly<{
  launchUrl: string;
  mainWindowHandle: string;
  platform: "macos" | "windows";
  roleId: string;
  roleName: string;
}>): Promise<void> {
  const batches = process.env.RION_STUDIO_E2E_PROFILE?.includes("hardware") ? 50 : 1;
  for (let batch = 0; batch < batches; batch++) {
  const afterSequence = await fixtureCursor();
  if (input.platform === "macos") {
    await clickMacosVisibleRoleControl(
      WINDOW_ID,
      input.roleId,
      await readVisibleElectronCanvasPoint(input.launchUrl, input.mainWindowHandle)
    );
    await pressVisibleMacosRoleKey({
      code: "Shift+Digit3Twice",
      processId: (await electronDesktopE2eProbe()).processId,
      runtimeTabName: input.roleName,
      runtimeWindowId: WINDOW_ID
    });
  } else {
    await pressVisibleWindowsApplicationShortcut({ command: "shiftDigit3Twice",
      processId: (await electronDesktopE2eProbe()).processId, targetMode: "focused-runtime" });
  }
  let events: readonly FixtureEvent[] = [];
  await browser.waitUntil(async () => {
    events = await fixtureEvents({
      afterSequence,
      roleId: ROLE_A_FIXTURE
    });
    return events.filter((event) =>
      (event.kind === "keydown" || event.kind === "keyup") &&
      event.code === "Digit1"
    ).length >= 4;
  }, {
    timeout: 20_000,
    timeoutMsg: "Repeated Shift+3 did not finish two shifted Digit1 lifecycles"
  });
  expect(events.filter((event) =>
    (event.kind === "keydown" || event.kind === "keyup") &&
    event.code === "Digit1"
  ).map((event) => ({
    key: event.key,
    kind: event.kind,
    shift: event.modifiers?.shift
  }))).toEqual([
    { key: "!", kind: "keydown", shift: true },
    { key: "!", kind: "keyup", shift: true },
    { key: "!", kind: "keydown", shift: true },
    { key: "!", kind: "keyup", shift: true }
  ]);
    await browser.waitUntil(async () => {
      const state = (await fixtureState())[ROLE_A_FIXTURE];
      return state?.pressedCodes.length === 0 && state.consumerPressedCodes.length === 0;
    }, { timeout: 5000, timeoutMsg: "Released Shift+3/Shift+1 left the game consumer held" });
  }

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
  exactCompatibleKey(pressedOne, "Digit1");
  expect(pressedOne).toEqual(expect.objectContaining({
    key: "!",
    modifiers: { alt: false, control: false, meta: false, shift: true }
  }));
  const releasedOne = await waitExactKey({
    afterSequence: pressedOne.sequence,
    code: "Digit1",
    kind: "keyup",
    roleId: ROLE_A_FIXTURE
  });
  exactCompatibleKey(releasedOne, "Digit1");
  expect(releasedOne).toEqual(expect.objectContaining({
    key: "!",
    modifiers: { alt: false, control: false, meta: false, shift: true }
  }));
  const triggerUp = await waitExactKey({
    afterSequence: reentryFixture,
    code: "Digit3",
    kind: "keyup",
    roleId: ROLE_A_FIXTURE
  });
  exactCompatibleKey(triggerUp, "Digit3");
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
    intent: "cleanup",
    phase: "release",
    roleId: roleA.id
  });
  expect(triggerRelease.receipt.confirmedInputNeutrality).toBe(true);
  expect(reentryRelease.sequence).toBeLessThan(triggerRelease.sequence);
  await browser.waitUntil(async () => {
    const entries = (await rendererCall("queryLogs", {
      levels: ["debug"],
      limit: 100,
      search: "trusted_input_terminal"
    })).entries;
    const modifierTerminals = entries
      .filter((entry) => entry.event === "trusted_input_terminal" &&
        entry.context?.roleId === roleA.id && entry.context?.code === "ShiftLeft" &&
        entry.context?.applicationPath === "canvas-compatibility" &&
        entry.context?.cdpSubmissionCertainty === "not-invoked" && entry.context?.terminalCode === "APPLIED");
    return ["rawKeyDown", "keyUp"].every(phase => modifierTerminals.some(entry => entry.context?.phase === phase));
  }, {
    timeout: 10_000,
    timeoutMsg: "Shift+3 did not persist compatible modifier press and release terminal evidence"
  });

  await exerciseRepeatedShiftShortcut({
    launchUrl: roleA.launchUrl!,
    mainWindowHandle: context.mainWindowHandle,
    platform: context.platform,
    roleId: roleA.id,
    roleName: roleA.name
  });

  await exerciseCompatibleAltShortcuts({
    launchUrl: roleA.launchUrl!, mainWindowHandle: context.mainWindowHandle,
    platform: context.platform, roleId: roleA.id, roleName: roleA.name,
    fixtureRoleId: ROLE_A_FIXTURE, windowId: WINDOW_ID
  });
  await exerciseModifierReconciliation({
    platform: context.platform, roleId: roleA.id, roleName: roleA.name, fixtureRoleId: ROLE_A_FIXTURE,
    windowId: WINDOW_ID, launchUrl: roleA.launchUrl!
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
  if (context.platform === "macos") {
    // WebDriver's DOM-trusted events do not cross the native physical journal.
    // Exercise the real source for the fast down/up overlap under v37.
    await pressVisibleMacosRoleKey({ code: "Shift+Digit3",
      processId: (await electronDesktopE2eProbe()).processId,
      runtimeTabName: roleA.name, runtimeWindowId: WINDOW_ID });
  } else {
    await pressVisibleWindowsApplicationShortcut({ command: "shiftDigit3",
      processId: (await electronDesktopE2eProbe()).processId, targetMode: "focused-runtime" });
  }
  exactCompatibleKey(await waitExactKey({
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
  const processId = (await electronDesktopE2eProbe()).processId;
  const continuityKey = (release: boolean) => context.platform === "macos"
    ? pressVisibleMacosRoleKey({
      code: release ? "Shift+Digit5Release" : "Shift+Digit5Hold",
      processId, runtimeTabName: roleA.name, runtimeWindowId: WINDOW_ID
    })
    : pressVisibleWindowsApplicationShortcut({
      command: release ? "shiftDigit5Release" : "shiftDigit5Hold",
      processId, targetMode: "focused-runtime"
    });
  if (context.platform === "macos") {
    await clickMacosVisibleRoleControl(WINDOW_ID, roleA.id,
      await readVisibleElectronCanvasPoint(roleA.launchUrl!, context.mainWindowHandle));
  } else {
    await submitElectronRoleKeyPhases(roleA.launchUrl!, context.mainWindowHandle, [], { windowId: WINDOW_ID });
  }
  try {
    await continuityKey(false);
    await waitForMacroProjection({
      afterSequence: continuityProjection,
      macroId: macros.continuity.id,
      roleIds: [roleA.id],
      state: "running"
    });
    const continuityOneDown = await waitExactKey({
      afterSequence: continuityFixture,
      code: "Digit1",
      kind: "keydown",
      roleId: ROLE_A_FIXTURE
    });
    exactCompatibleKey(continuityOneDown, "Digit1");
    expect(continuityOneDown).toEqual(expect.objectContaining({
      key: "!",
      modifiers: { alt: false, control: false, meta: false, shift: true }
    }));
    const continuityOneUp = await waitExactKey({
      afterSequence: continuityOneDown.sequence,
      code: "Digit1",
      kind: "keyup",
      roleId: ROLE_A_FIXTURE
    });
    exactCompatibleKey(continuityOneUp, "Digit1");
    expect(continuityOneUp).toEqual(expect.objectContaining({
      key: "!",
      modifiers: { alt: false, control: false, meta: false, shift: true }
    }));
    await activateChromiumRoleVisible(context, tabB);
    await activateChromiumRoleVisible(context, tabA);
    if (context.platform === "macos") {
      await clickMacosVisibleRoleControl(
        WINDOW_ID,
        roleA.id,
        await readVisibleElectronCanvasPoint(roleA.launchUrl!, context.mainWindowHandle)
      );
      await pressVisibleMacosRoleKey({
        code: "Shift+Digit4",
        processId: (await electronDesktopE2eProbe()).processId,
        runtimeTabName: roleA.name,
        runtimeWindowId: WINDOW_ID
      });
    } else {
      await pressVisibleWindowsApplicationShortcut({ command: "shiftDigit4", processId, targetMode: "focused-runtime" });
    }
    const shiftedFour = await waitExactKey({
      afterSequence: continuityFixture,
      code: "Digit4",
      kind: "keydown",
      roleId: ROLE_A_FIXTURE
    });
    expect(shiftedFour).toEqual(expect.objectContaining({
      isTrusted: true,
      key: "$",
      modifiers: { alt: false, control: false, meta: false, shift: true }
    }));
  } finally {
    await continuityKey(true);
  }
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
    waitFixtureEvent({ afterSequence: outputFixture, kind: "game-click", roleId: ROLE_A_FIXTURE }),
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
    { button: 0, isTrusted: false },
    { button: 1, isTrusted: false },
    { button: 2, isTrusted: false }
  ]);
  await waitForMacroProjection({
    absent: true,
    afterSequence: outputCursor,
    macroId: macros.output.id
  });

  for (const order of ["Digit2ThenDigit3", "Digit3ThenDigit2"] as const) {
    await exerciseRapidShiftShortcuts({
      collisionMacroId: macros.collision.id,
      launchUrl: roleA.launchUrl!,
      mainWindowHandle: context.mainWindowHandle,
      order,
      platform: context.platform,
      reentryMacroId: macros.reentry.id,
      roleId: roleA.id,
      roleName: roleA.name
    });
  }

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
