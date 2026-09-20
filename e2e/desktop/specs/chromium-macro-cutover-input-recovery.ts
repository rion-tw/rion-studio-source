import { exerciseCompatibleReceiptRecovery } from "./chromium-macro-receipt-recovery";
import { verifyUnboundChromiumInput } from "./chromium-input-confinement";
import { browser, expect } from "@wdio/globals";
import { Key } from "webdriverio";

import {
  electronDesktopE2eFullscreenToolbarRuntime,
  electronDesktopE2eGameWindowRuntime,
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
  startChromiumMacroVisible,
  stopChromiumMacroVisible,
  writeChromiumMacroEvidence
} from "./chromium-macro-cutover-support";

const FIXTURE_ID = "macro-input-recovery";
const WINDOW_ID = "c8e00000-0000-4000-8000-000000000022";

async function waitExactCompatibleCanvasMouseUp(afterSequence: number): Promise<void> {
  let cursor = afterSequence;
  while (true) {
    const event = await waitFixtureEvent({
      afterSequence: cursor,
      kind: "mouseup",
      roleId: FIXTURE_ID
    });
    if (event.isTrusted === false && event.targetId === "game-input-canvas") return;
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
  const nativeBefore = (await electronDesktopE2eGameWindowRuntime(WINDOW_ID)).currentRuntime;
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
  expect((await electronDesktopE2eGameWindowRuntime(WINDOW_ID)).currentRuntime?.nativeDisplay)
    .toEqual(nativeBefore?.nativeDisplay);
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
  expect((await electronDesktopE2eGameWindowRuntime(WINDOW_ID)).currentRuntime?.nativeDisplay)
    .toEqual(nativeBefore?.nativeDisplay);
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
  let stoppedShortcutEvidence: unknown = null;
  await browser.waitUntil(async () => {
    const entries = (await rendererCall("queryLogs", {
      levels: ["debug"],
      limit: 100,
      search: "managed_shortcut_transition"
    })).entries;
    stoppedShortcutEvidence = entries.find((entry) =>
      entry.event === "managed_shortcut_transition" &&
      entry.context?.roleId === input.roleId &&
      entry.context?.macroId === input.macroId &&
      entry.context?.phase === "keyDown" &&
      entry.context?.state === "accepted" &&
      entry.context?.controlOutcome === "stopped");
    return stoppedShortcutEvidence !== undefined;
  }, {
    timeout: 10_000,
    timeoutMsg: "The second shortcut did not persist Core stop-before-replacement evidence"
  });
  expect(stoppedShortcutEvidence).toBeDefined();
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
    if (event.code === input.code && event.isTrusted === false) return event;
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
      { id: "recovery-key", type: "key", action: "tap", code: "KeyJ" },
      { id: "recovery-click", type: "click", xPercent: 5, yPercent: 5 },
      { id: "recovery-event-gap", ms: 250, type: "delay" }
    ]
  });
  const window = await createChromiumMacroWindow(
    WINDOW_ID,
    "Chromium Macro Input Recovery"
  );
  const tab = await launchChromiumRoleVisible(role, FIXTURE_ID, window);
  await activateChromiumRoleVisible(context, tab);
  const nativeBinding = await expectChromiumNativeRoleBinding(context, tab);
  await verifyUnboundChromiumInput({
    ...context, processId, roleId: role.id, roleName: role.name, roleUrl,
    fixtureId: FIXTURE_ID, windowId: WINDOW_ID
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
  await waitExactCompatibleCanvasMouseUp(firstEffectCursor);
  const beforeRecovery = await electronDesktopE2eTrustedInputRuntime(role.id);
  const beforeSequence = beforeRecovery.at(-1)?.sequence ?? 0;
  const beforeStatus = (await rendererCall("listMacroStatuses")).find(status => status.macroId === macro.id);
  expect(beforeStatus?.state).toBe("running");

  const verificationCursor = await fixtureCursor();
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
  await waitExactCompatibleCanvasMouseUp(verificationOpen.sequence);
  const duringKey = await waitExactKey({ afterSequence: verificationOpen.sequence, code: "KeyJ", kind: "keyup", roleId: FIXTURE_ID });
  expect(duringKey.activeElementId).toBe("verification-frame");
  const duringClick = await waitFixtureEvent({ afterSequence: duringKey.sequence, kind: "game-click", roleId: FIXTURE_ID });
  expect(duringClick).toEqual(expect.objectContaining({ activeElementId: "verification-frame", isTrusted: false, targetId: "game-input-canvas" }));
  const duringStatus = (await rendererCall("listMacroStatuses")).find(status => status.macroId === macro.id);
  expect(duringStatus).toEqual(expect.objectContaining({ state: "running", startedAt: beforeStatus?.startedAt }));
  expect(duringStatus?.iteration ?? 0).toBeGreaterThanOrEqual(beforeStatus?.iteration ?? 0);
  const duringRecovery = await electronDesktopE2eTrustedInputRuntime(role.id);
  expect(duringRecovery.filter(entry => entry.sequence > beforeSequence).every(entry =>
    entry.receipt.status === "applied" && entry.request.inputEpoch === beforeRecovery.at(-1)?.request.inputEpoch)).toBe(true);
  const recoveryBoundarySequence = Math.max(beforeSequence, ...duringRecovery.map(entry => entry.sequence));

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
  const afterStatus = (await rendererCall("listMacroStatuses")).find(status => status.macroId === macro.id);
  expect(afterStatus).toEqual(expect.objectContaining({ state: "running", startedAt: beforeStatus?.startedAt }));
  await waitExactCompatibleCanvasMouseUp(resumedEffectCursor);
  expect((await fixtureEvents({ afterSequence: verificationOpen.sequence, roleId: FIXTURE_ID }))
    .filter(event => event.kind === "verification-input-leak")).toEqual([]);
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
  // Navigation can win before submission or while a release is uncertain.
  // Both terminate the invocation; uncertain cleanup remains visibly failed.
  await browser.waitUntil(async () => {
    const status = (await rendererCall("listMacroStatuses")).find(candidate => candidate.macroId === macro.id);
    return !status || status.state === "failed";
  }, { timeout: 20_000, timeoutMsg: "Navigation failure did not terminalize the macro" });
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
  const receiptRecovery = await exerciseCompatibleReceiptRecovery(context, game.id, window);
  await writeChromiumMacroEvidence("chromium-macro-input-recovery-evidence.json", {
    receiptRecovery,
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
