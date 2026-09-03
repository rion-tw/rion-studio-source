import { $, expect } from "@wdio/globals";

import { focusMainApplicationWindow, runtimeUiAction } from "../support/control";
import { fixtureCursor, fixtureState, waitFixtureEvent } from "../support/fixture";
import { waitFixtureCode } from "./macro-runtime-keyboard-helpers";

interface ModifierFocusJourneyInput {
  activateVisibleRuntimeTab: (input: {
    tabId: string;
    windowGeneration: number;
    windowId: string;
  }) => Promise<void>;
  fixtureRoleId: string;
  press: (code: string) => Promise<void>;
  release: (code: string, focus?: boolean) => Promise<void>;
  roleId: string;
  tabId: string;
  windowGeneration: number;
  windowId: string;
}

export async function verifyModifierFocusReconciliation(
  input: ModifierFocusJourneyInput
): Promise<void> {
  const focusRole = async (): Promise<void> => {
    const cursor = await fixtureCursor();
    await input.activateVisibleRuntimeTab({
      tabId: input.tabId,
      windowGeneration: input.windowGeneration,
      windowId: input.windowId
    });
    await runtimeUiAction(input.windowId, {
      action: "focusRole",
      roleId: input.roleId,
      tabId: input.tabId,
      windowGeneration: input.windowGeneration
    });
    await waitFixtureEvent({
      afterSequence: cursor,
      kind: "focus",
      roleId: input.fixtureRoleId
    });
  };
  const sidebar = await $(".app-main-sidebar");
  const baselineState = (await fixtureState())[input.fixtureRoleId];
  const baselineTrustedPressedCodes = baselineState.trustedPressedCodes;
  expect(baselineState.pressedCodes).toEqual([]);
  expect(baselineState.consumerPressedCodes).toEqual([]);

  const releasedAwayCursor = await fixtureCursor();
  await input.press("ShiftLeft");
  const releasedAwayShiftDown = await waitFixtureCode({
    afterSequence: releasedAwayCursor,
    code: "ShiftLeft",
    kind: "keydown",
    roleId: input.fixtureRoleId
  });
  await sidebar.$("button*=Macros").click();
  await focusMainApplicationWindow();
  await waitFixtureCode({
    afterSequence: releasedAwayShiftDown.sequence,
    code: "ShiftLeft",
    kind: "keyup",
    roleId: input.fixtureRoleId
  });
  await input.release("ShiftLeft", false);

  const releasedAwayRefocusCursor = await fixtureCursor();
  await focusRole();
  await input.press("Digit4");
  const unshiftedDigitFourDown = await waitFixtureCode({
    afterSequence: releasedAwayRefocusCursor,
    code: "Digit4",
    kind: "keydown",
    roleId: input.fixtureRoleId
  });
  expect(unshiftedDigitFourDown.modifiers?.shift).toBe(false);
  await input.release("Digit4");
  await waitFixtureCode({
    afterSequence: unshiftedDigitFourDown.sequence,
    code: "Digit4",
    kind: "keyup",
    roleId: input.fixtureRoleId
  });
  const releasedAwayState = (await fixtureState())[input.fixtureRoleId];
  expect(releasedAwayState.pressedCodes).toEqual([]);
  expect(releasedAwayState.consumerPressedCodes).toEqual([]);

  const stillHeldCursor = await fixtureCursor();
  await input.press("ShiftLeft");
  const stillHeldShiftDown = await waitFixtureCode({
    afterSequence: stillHeldCursor,
    code: "ShiftLeft",
    kind: "keydown",
    roleId: input.fixtureRoleId
  });
  await sidebar.$("button*=Macros").click();
  await focusMainApplicationWindow();
  const neutralizedStillHeldShift = await waitFixtureCode({
    afterSequence: stillHeldShiftDown.sequence,
    code: "ShiftLeft",
    kind: "keyup",
    roleId: input.fixtureRoleId
  });
  await focusRole();
  const reassertedShiftDown = await waitFixtureCode({
    afterSequence: neutralizedStillHeldShift.sequence,
    code: "ShiftLeft",
    kind: "keydown",
    roleId: input.fixtureRoleId
  });
  await input.press("Digit4");
  const shiftedDigitFourDown = await waitFixtureCode({
    afterSequence: reassertedShiftDown.sequence,
    code: "Digit4",
    kind: "keydown",
    roleId: input.fixtureRoleId
  });
  expect(shiftedDigitFourDown.modifiers?.shift).toBe(true);
  await input.release("Digit4");
  await waitFixtureCode({
    afterSequence: shiftedDigitFourDown.sequence,
    code: "Digit4",
    kind: "keyup",
    roleId: input.fixtureRoleId
  });
  await input.release("ShiftLeft");
  const releasedShiftUp = await waitFixtureCode({
    afterSequence: reassertedShiftDown.sequence,
    code: "ShiftLeft",
    kind: "keyup",
    roleId: input.fixtureRoleId
  });
  await waitFixtureCode({
    afterSequence: releasedShiftUp.sequence,
    code: "ShiftLeft",
    kind: "consumer-keyup",
    roleId: input.fixtureRoleId
  });
  const stillHeldState = (await fixtureState())[input.fixtureRoleId];
  expect(stillHeldState.pressedCodes).toEqual([]);
  expect(stillHeldState.trustedPressedCodes).toEqual(baselineTrustedPressedCodes);
  expect(stillHeldState.consumerPressedCodes).toEqual([]);
}
