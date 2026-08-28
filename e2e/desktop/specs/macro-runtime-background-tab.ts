import { expect } from "@wdio/globals";

import type { Macro, MacroRunStatus } from "../../../src/shared/types";
import {
  inputDiagnostics,
  keyboardInputSequence,
  probe,
  rendererCall,
  runtimeUiAction,
  windowSnapshot
} from "../support/control";
import { fixtureState } from "../support/fixture";
import { rendererEventCursor, waitForMacroProjection } from "../support/renderer-events";
import { waitMacroKeyReceipt } from "./macro-runtime-keyboard-helpers";

interface VisibleTabActivation {
  tabId: string;
  windowGeneration: number;
  windowId: string;
}

interface BackgroundTabContinuityInput {
  activateVisibleRuntimeTab: (input: VisibleTabActivation) => Promise<void>;
  macro: Macro;
  roleId: string;
  tabA: { id: string; windowId: string };
  tabB: { id: string };
  windowGeneration: number;
}

async function toggleMacroShortcut(): Promise<void> {
  await keyboardInputSequence([
    { code: "ShiftLeft", phase: "keyDown" },
    { code: "Digit4", phase: "keyDown" },
    { code: "Digit4", phase: "keyUp" },
    { code: "ShiftLeft", phase: "keyUp" }
  ]);
}

export async function verifyBackgroundTabContinuity(
  input: BackgroundTabContinuityInput
): Promise<void> {
  const { macro, roleId, tabA, tabB, windowGeneration } = input;
  await input.activateVisibleRuntimeTab({
    tabId: tabA.id,
    windowGeneration,
    windowId: tabA.windowId
  });
  await runtimeUiAction(tabA.windowId, {
    action: "focusRole",
    roleId,
    tabId: tabA.id,
    windowGeneration
  });

  const macroCursor = await rendererEventCursor();
  await toggleMacroShortcut();
  const runningBeforeSwitch = await waitForMacroProjection({
    afterSequence: macroCursor,
    macroId: macro.id,
    minimumIteration: 2,
    roleIds: [roleId],
    state: "running"
  });
  const iterationBeforeSwitch = runningBeforeSwitch.find(
    (status) => status.macroId === macro.id
  )?.iteration ?? 0;
  expect(iterationBeforeSwitch).toBeGreaterThanOrEqual(2);

  const transactionCursor = (await probe()).latestSequence;
  await waitMacroKeyReceipt({
    afterSequence: transactionCursor,
    code: "KeyB",
    kind: "macro-key-native-acknowledged",
    phase: "keydown",
    roleId
  });
  const continuationCursor = await rendererEventCursor();
  await input.activateVisibleRuntimeTab({
    tabId: tabB.id,
    windowGeneration,
    windowId: tabA.windowId
  });
  await input.activateVisibleRuntimeTab({
    tabId: tabA.id,
    windowGeneration,
    windowId: tabA.windowId
  });

  const continuedStatuses = await waitForMacroProjection({
    afterSequence: continuationCursor,
    macroId: macro.id,
    minimumIteration: iterationBeforeSwitch + 2,
    roleIds: [roleId],
    state: "running"
  });
  const continued = continuedStatuses.find((status) => status.macroId === macro.id);
  expect(continued?.iteration).toBeGreaterThan(iterationBeforeSwitch);
  expect(continued?.error ?? null).toBeNull();

  const state = await fixtureState();
  expect(state["macro-background-a"].keydown).toBeGreaterThan(0);
  expect(state["macro-background-b"].keydown).toBe(0);
  expect((await windowSnapshot(tabA.windowId)).kernel?.selectedTabId).toBe(tabA.id);
  const currentStatuses: MacroRunStatus[] = await rendererCall("listMacroStatuses");
  expect(currentStatuses.filter((status) => status.macroId === macro.id))
    .toEqual([expect.objectContaining({ error: null, state: "running" })]);
  const diagnostics = await inputDiagnostics();
  expect(diagnostics.roles.filter((role) => role.roleId === roleId))
    .toEqual(expect.arrayContaining([expect.objectContaining({
      quiesced: false,
      restartRequired: false,
      roleId,
      stopping: false
    })]));

  const stopCursor = await rendererEventCursor();
  await toggleMacroShortcut();
  await waitForMacroProjection({ afterSequence: stopCursor, absent: true, macroId: macro.id });
}
