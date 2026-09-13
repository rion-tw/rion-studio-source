import { expect } from "@wdio/globals";
import { Key } from "webdriverio";

import {
  electronDesktopE2eFullscreenToolbarRuntime,
  electronDesktopE2eProbe,
  electronDesktopE2eRoleSessionRuntime,
  electronDesktopE2eTrustedInputRuntime
} from "../support/electron-driver";
import {
  clickVisibleElectronCanvasWithPointer,
  clickVisibleElectronPageElement,
  clickVisibleElectronPageElementWithPointer,
  completeVisibleElectronRoleVerification,
  readVisibleElectronCanvasPoint,
  readVisibleElectronPageElementPoint,
  readVisibleElectronRoleVerificationPoint,
  submitElectronRoleKeyPhases
} from "../support/electron-role-surface";
import {
  fixtureCursor,
  fixtureEvents,
  fixtureRequest,
  fixtureState,
  waitFixtureEvent
} from "../support/fixture";
import { clickMacosVisibleRoleControl } from "../support/macos-appkit-ui";
import { rendererCall } from "../support/renderer-bridge";
import {
  rendererEventCursor,
  waitForMacroProjection
} from "../support/renderer-events";
import {
  installRuntimeTabShellErrorJournal,
  runtimeTabShellErrors
} from "../support/native-runtime-tabs";
import { pressVisibleMacosRoleKey } from
  "../support/native-application-actions";
import {
  activateChromiumRoleVisible,
  bootstrapChromiumMacroCutover,
  createChromiumMacroWindow,
  expectChromiumNativeRoleBinding,
  launchChromiumRoleVisible,
  macroFixtureUrl,
  showChromiumMacroWindow,
  startChromiumMacroVisible,
  stopChromiumMacroVisible,
  writeChromiumMacroEvidence
} from "./chromium-macro-cutover-support";

const FIXTURE_ID = "macro-input-recovery";
const WINDOW_ID = "c8e00000-0000-4000-8000-000000000022";

async function waitExactTrustedCanvasMouseUp(afterSequence: number): Promise<void> {
  let cursor = afterSequence;
  while (true) {
    const event = await waitFixtureEvent({
      afterSequence: cursor,
      kind: "mouseup",
      roleId: FIXTURE_ID
    });
    if (event.isTrusted === true && event.targetId === "game-input-canvas") return;
    cursor = event.sequence;
  }
}

async function exerciseConcurrentPhysicalInput(input: Readonly<{
  mainWindowHandle: string;
  macroId: string;
  macroStatusCursor: number;
  platform: "macos" | "windows";
  processId: number;
  roleId: string;
  roleName: string;
  roleUrl: string;
}>): Promise<Readonly<{ automaticKeyCount: number; physicalEventCount: number }>> {
  if (input.platform === "macos") {
    await clickMacosVisibleRoleControl(
      WINDOW_ID,
      input.roleId,
      await readVisibleElectronCanvasPoint(input.roleUrl, input.mainWindowHandle)
    );
  }
  const afterSequence = await fixtureCursor();
  const presentationBefore = (
    await electronDesktopE2eFullscreenToolbarRuntime(WINDOW_ID)
  ).presentation;
  const trustedInputBefore = await electronDesktopE2eTrustedInputRuntime(input.roleId);
  const pressY = () => input.platform === "macos"
    ? pressVisibleMacosRoleKey({
      code: "KeyY",
      processId: input.processId,
      runtimeTabName: input.roleName,
      runtimeWindowId: WINDOW_ID
    })
    : submitElectronRoleKeyPhases(input.roleUrl, input.mainWindowHandle, [
      { key: "y", phase: "keyDown" },
      { key: "y", phase: "keyUp" }
    ], { windowId: WINDOW_ID, focusCanvas: false });
  await pressY();
  expect((await electronDesktopE2eFullscreenToolbarRuntime(WINDOW_ID)).presentation)
    .toBe(presentationBefore);
  await waitForMacroProjection({
    afterSequence: input.macroStatusCursor,
    macroId: input.macroId,
    roleIds: [input.roleId],
    state: "running"
  });
  await waitExactKey({
    afterSequence,
    code: "KeyJ",
    kind: "keyup",
    roleId: FIXTURE_ID
  });

  await submitElectronRoleKeyPhases(input.roleUrl, input.mainWindowHandle, [
    { key: "w", phase: "keyDown" },
    { key: "w", phase: "keyUp" },
    { key: Key.Shift, phase: "keyDown" }
  ], { windowId: WINDOW_ID, focusCanvas: false });
  if (input.platform === "macos") {
    await clickMacosVisibleRoleControl(
      WINDOW_ID,
      input.roleId,
      await readVisibleElectronCanvasPoint(
        input.roleUrl,
        input.mainWindowHandle
      )
    );
  } else {
    await clickVisibleElectronCanvasWithPointer(
      input.roleUrl,
      input.mainWindowHandle
    );
  }
  await submitElectronRoleKeyPhases(input.roleUrl, input.mainWindowHandle, [
    { key: Key.Shift, phase: "keyUp" },
    { key: Key.Alt, phase: "keyDown" },
    { key: Key.Alt, phase: "keyUp" }
  ], { windowId: WINDOW_ID, focusCanvas: false });

  let automaticKeyCount = 0;
  let physicalEventCount = 0;
  await browser.waitUntil(async () => {
    const events = await fixtureEvents({ afterSequence, roleId: FIXTURE_ID });
    automaticKeyCount = events.filter((event) =>
      event.code === "KeyJ" && (event.kind === "keydown" || event.kind === "keyup")
    ).length;
    physicalEventCount = events.filter((event) =>
      event.code === "KeyW" || event.code === "ShiftLeft" ||
      event.code === "AltLeft" ||
      ((event.kind === "mousedown" || event.kind === "mouseup" || event.kind === "click") &&
        event.targetId === "game-input-canvas")
    ).length;
    return automaticKeyCount >= 4 && physicalEventCount >= 8;
  }, {
    interval: 50,
    timeout: 20_000,
    timeoutMsg: "Concurrent physical input did not remain live during the KeyJ loop"
  });
  expect((await rendererCall("listMacroStatuses")).some((status) =>
    status.macroId === input.macroId && status.state === "running"
  )).toBe(true);
  const afterInput = await electronDesktopE2eTrustedInputRuntime(input.roleId);
  expect(afterInput.slice(trustedInputBefore.length).every((entry) =>
    entry.receipt.status === "applied"
  )).toBe(true);

  const stopProjectionCursor = await rendererEventCursor();
  const stopInputCursor = await fixtureCursor();
  await pressY();
  expect((await electronDesktopE2eFullscreenToolbarRuntime(WINDOW_ID)).presentation)
    .toBe(presentationBefore);
  await waitExactKey({
    afterSequence: stopInputCursor,
    code: "KeyY",
    kind: "consumer-keyup",
    roleId: FIXTURE_ID
  });
  await waitForMacroProjection({
    absent: true,
    afterSequence: stopProjectionCursor,
    macroId: input.macroId
  });
  const state = (await fixtureState())[FIXTURE_ID];
  expect(state?.pressedCodes).toEqual([]);
  expect(state?.consumerPressedCodes).toEqual([]);
  expect(await runtimeTabShellErrors()).toEqual([]);
  return { automaticKeyCount, physicalEventCount };
}

async function waitExactKey(input: Readonly<{
  afterSequence: number;
  code: string;
  kind: "consumer-keyup" | "keydown" | "keyup";
  roleId: string;
}>) {
  let cursor = input.afterSequence;
  for (;;) {
    const event = await waitFixtureEvent({
      afterSequence: cursor,
      kind: input.kind,
      roleId: input.roleId
    });
    if (event.code === input.code && event.isTrusted === true) return event;
    cursor = event.sequence;
  }
}

export async function runChromiumMacroInputRecoveryCutover(): Promise<void> {
  const context = await bootstrapChromiumMacroCutover();
  const processId = (await electronDesktopE2eProbe()).processId;
  await installRuntimeTabShellErrorJournal();
  const roleUrl = macroFixtureUrl(FIXTURE_ID, "activeNavigationFailure=1");
  const game = await rendererCall("createGame", {
    defaultLaunchUrl: roleUrl,
    name: "Chromium Macro Input Recovery Game"
  });
  const role = await rendererCall("createRole", {
    gameId: game.id,
    launchUrl: roleUrl,
    name: "Chromium Macro Input Recovery Role"
  });
  const macro = await rendererCall("createMacro", {
    activationMode: "press",
    enabled: true,
    name: "Chromium Macro Input Recovery",
    repeat: { intervalMs: 0, type: "loop" },
    roleIds: [role.id],
    steps: [
      { id: "recovery-click", type: "click", xPercent: 5, yPercent: 5 },
      { id: "recovery-event-gap", ms: 5_000, type: "delay" }
    ]
  });
  const interleaveMacro = await rendererCall("createMacro", {
    activationMode: "press",
    enabled: true,
    name: "Chromium Concurrent Physical Input",
    repeat: { intervalMs: 250, type: "loop" },
    roleIds: [role.id],
    shortcutSourceScope: { roleIds: [role.id], type: "selected_roles" },
    steps: [
      { action: "tap", code: "KeyJ", id: "concurrent-key-j", type: "key" }
    ],
    trigger: { alt: false, code: "KeyY", ctrl: false, meta: false, shift: false }
  });
  const window = await createChromiumMacroWindow(
    WINDOW_ID,
    "Chromium Macro Input Recovery"
  );
  await showChromiumMacroWindow(window);
  const tab = await launchChromiumRoleVisible(role, FIXTURE_ID, window);
  await activateChromiumRoleVisible(context, tab);
  const nativeBinding = await expectChromiumNativeRoleBinding(context, tab);
  const interleaveStatusCursor = await rendererEventCursor();
  const concurrentPhysicalInput = await exerciseConcurrentPhysicalInput({
    mainWindowHandle: context.mainWindowHandle,
    macroId: interleaveMacro.id,
    macroStatusCursor: interleaveStatusCursor,
    platform: context.platform,
    processId,
    roleId: role.id,
    roleName: role.name,
    roleUrl
  });
  const baselineRuntime = await electronDesktopE2eRoleSessionRuntime(role.id);
  const firstEffectCursor = await fixtureCursor();
  const macroCursor = await startChromiumMacroVisible(macro, [role.id]);
  await waitExactTrustedCanvasMouseUp(firstEffectCursor);
  const beforeRecovery = await electronDesktopE2eTrustedInputRuntime(role.id);
  const beforeSequence = beforeRecovery.at(-1)?.sequence ?? 0;

  const verificationCursor = await fixtureCursor();
  const recoveryProjection = await rendererEventCursor();
  if (context.platform === "macos") {
    await clickMacosVisibleRoleControl(
      WINDOW_ID,
      role.id,
      await readVisibleElectronPageElementPoint(
        roleUrl,
        context.mainWindowHandle,
        "#qa-target"
      )
    );
  } else {
    await clickVisibleElectronPageElementWithPointer(
      roleUrl,
      context.mainWindowHandle,
      "#qa-target"
    );
  }
  const verificationOpen = await waitFixtureEvent({
    afterSequence: verificationCursor,
    kind: "verification-open",
    roleId: FIXTURE_ID
  });
  await waitForMacroProjection({
    afterSequence: recoveryProjection,
    macroId: macro.id,
    roleIds: [role.id],
    state: "recovering"
  });
  const duringRecovery = await electronDesktopE2eTrustedInputRuntime(role.id);
  const verificationOpenedAtMs = Date.parse(verificationOpen.timestamp);
  expect(Number.isFinite(verificationOpenedAtMs)).toBe(true);
  expect(duringRecovery.filter((entry) =>
    entry.request.scheduledAtMs >= verificationOpenedAtMs
  )).toEqual([]);
  const recoveryBoundarySequence = Math.max(
    beforeSequence,
    ...duringRecovery.map((entry) => entry.sequence)
  );

  if (context.platform === "macos") {
    await clickMacosVisibleRoleControl(
      WINDOW_ID,
      role.id,
      await readVisibleElectronRoleVerificationPoint(
        roleUrl,
        context.mainWindowHandle
      )
    );
  } else {
    await completeVisibleElectronRoleVerification(roleUrl, context.mainWindowHandle);
  }
  const verificationComplete = await waitFixtureEvent({
    afterSequence: verificationOpen.sequence,
    kind: "verification-complete",
    roleId: FIXTURE_ID
  });
  const resumedEffectCursor = await fixtureCursor();
  if (context.platform === "macos") {
    await clickMacosVisibleRoleControl(
      WINDOW_ID,
      role.id,
      await readVisibleElectronPageElementPoint(
        roleUrl,
        context.mainWindowHandle,
        "#qa-target"
      )
    );
  } else {
    await clickVisibleElectronPageElementWithPointer(
      roleUrl,
      context.mainWindowHandle,
      "#qa-target"
    );
  }
  await waitForMacroProjection({
    afterSequence: recoveryProjection,
    macroId: macro.id,
    roleIds: [role.id],
    state: "running"
  });
  await waitExactTrustedCanvasMouseUp(resumedEffectCursor);
  const recoveredRuntime = await electronDesktopE2eRoleSessionRuntime(role.id);
  expect(recoveredRuntime.currentRuntime).toEqual(expect.objectContaining({
    generation: baselineRuntime.currentRuntime?.generation,
    tabId: tab.tabId,
    windowId: tab.windowId
  }));
  const recoveredObservations = await electronDesktopE2eTrustedInputRuntime(role.id);
  const recovered = recoveredObservations.filter(
    (entry) => entry.sequence > recoveryBoundarySequence
  );
  expect(recovered.length).toBeGreaterThan(0);
  expect(recovered.every((entry) =>
    entry.receipt.status === "applied"
      && entry.receipt.surfaceGeneration === nativeBinding.surfaceGeneration
  )).toBe(true);

  await stopChromiumMacroVisible(macro, macroCursor);
  const failureCursor = await rendererEventCursor();
  await startChromiumMacroVisible(macro, [role.id]);
  await fixtureRequest("/api/navigation-failure", {
    enabled: true,
    roleId: FIXTURE_ID
  });
  if (context.platform === "macos") {
    await clickMacosVisibleRoleControl(
      WINDOW_ID,
      role.id,
      await readVisibleElectronPageElementPoint(
        roleUrl,
        context.mainWindowHandle,
        "#active-navigation-failure"
      )
    );
  } else {
    await clickVisibleElectronPageElement(
      roleUrl,
      context.mainWindowHandle,
      "#active-navigation-failure"
    );
  }
  const navigationRequested = await waitFixtureEvent({
    afterSequence: verificationComplete.sequence,
    kind: "navigation-requested",
    roleId: FIXTURE_ID
  });
  expect(navigationRequested).toMatchObject({
    isTrusted: true, targetId: "active-navigation-failure"
  });
  await waitForMacroProjection({
    absent: true,
    afterSequence: failureCursor,
    macroId: macro.id
  });
  const failedRuntime = await electronDesktopE2eRoleSessionRuntime(role.id);
  expect(failedRuntime.currentRuntime).toEqual(expect.objectContaining({
    generation: nativeBinding.surfaceGeneration,
    tabId: tab.tabId,
    windowId: tab.windowId
  }));
  const failureEvents = await fixtureEvents({
    afterSequence: verificationComplete.sequence,
    roleId: FIXTURE_ID
  });
  expect(failureEvents).toEqual(expect.arrayContaining([
    expect.objectContaining({
      isTrusted: true,
      kind: "navigation-requested",
      targetId: "active-navigation-failure"
    })
  ]));
  await writeChromiumMacroEvidence("chromium-macro-input-recovery-evidence.json", {
    failedRuntime,
    concurrentPhysicalInput,
    nativeBinding,
    platform: context.platform,
    recovered,
    recoveredRuntime,
    roleId: role.id,
    tabId: tab.tabId,
    verificationComplete
  });
}
