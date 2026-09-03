import { expect } from "@wdio/globals";

import {
  electronDesktopE2eRoleSessionRuntime,
  electronDesktopE2eTrustedInputRuntime
} from "../support/electron-driver";
import {
  clickVisibleElectronPageElement,
  clickVisibleElectronPageElementWithPointer,
  completeVisibleElectronRoleVerification,
  readVisibleElectronPageElementPoint,
  readVisibleElectronRoleVerificationPoint
} from "../support/electron-role-surface";
import {
  fixtureCursor,
  fixtureEvents,
  fixtureRequest,
  waitFixtureEvent
} from "../support/fixture";
import { clickMacosVisibleRoleControl } from "../support/macos-appkit-ui";
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

export async function runChromiumMacroInputRecoveryCutover(): Promise<void> {
  const context = await bootstrapChromiumMacroCutover();
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
    activationMode: "toggle",
    enabled: true,
    name: "Chromium Macro Input Recovery",
    repeat: { intervalMs: 0, type: "loop" },
    roleIds: [role.id],
    steps: [
      { id: "recovery-click", type: "click", xPercent: 5, yPercent: 5 },
      { id: "recovery-event-gap", ms: 5_000, type: "delay" }
    ]
  });
  const window = await createChromiumMacroWindow(
    WINDOW_ID,
    "Chromium Macro Input Recovery"
  );
  await showChromiumMacroWindow(window);
  const tab = await launchChromiumRoleVisible(role, FIXTURE_ID, window);
  await activateChromiumRoleVisible(context, tab);
  const nativeBinding = await expectChromiumNativeRoleBinding(context, tab);
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
    nativeBinding,
    platform: context.platform,
    recovered,
    recoveredRuntime,
    roleId: role.id,
    tabId: tab.tabId,
    verificationComplete
  });
}
