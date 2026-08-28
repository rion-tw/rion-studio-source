import { expect } from "@wdio/globals";

import type { Macro, MacroRunStatus } from "../../../src/shared/types";
import {
  inputDiagnostics,
  keyboardInputSequence,
  probe,
  rendererCall,
  runtimeUiAction,
  waitEvent,
  windowSnapshot
} from "../support/control";
import { fixtureCursor, fixtureEvents, fixtureState, waitFixtureEvent } from "../support/fixture";
import { rendererEventCursor, waitForMacroProjection } from "../support/renderer-events";
import { waitFixtureCode } from "./macro-runtime-keyboard-helpers";

interface VisibleTabActivation {
  tabId: string;
  windowGeneration: number;
  windowId: string;
}

interface BackgroundTabContinuityInput {
  activateVisibleRuntimeTab: (input: VisibleTabActivation) => Promise<void>;
  macro: Macro;
  roleId: string;
  roleBId: string;
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
  ], false);
}

async function waitHeldKeyContinuity(
  afterSequence: number,
  roleId: string,
  status: "reasserted",
  lossReason?: "blur" | "hidden"
): Promise<void> {
  let cursor = afterSequence;
  for (;;) {
    const event = await waitEvent({
      afterSequence: cursor,
      kind: "held-key-continuity-terminal"
    });
    const details = event.details as {
      lossReason?: string;
      roleId?: string;
      status?: string;
    };
    if (
      details.roleId === roleId
      && details.status === status
      && (!lossReason || details.lossReason === lossReason)
    ) return;
    cursor = event.sequence;
  }
}

async function expectTargetHeld(): Promise<void> {
  const state = await fixtureState();
  expect(state["macro-background-a"].consumerPressedCodes).toContain("Digit2");
}

async function stopHeldMacro(macroId: string): Promise<void> {
  const macroCursor = await rendererEventCursor();
  const fixtureAfter = await fixtureCursor();
  await toggleMacroShortcut();
  await Promise.all([
    waitForMacroProjection({ afterSequence: macroCursor, absent: true, macroId }),
    waitFixtureCode({
      afterSequence: fixtureAfter,
      code: "Digit2",
      kind: "consumer-keyup",
      roleId: "macro-background-a"
    })
  ]);
  expect((await fixtureState())["macro-background-a"].consumerPressedCodes)
    .not.toContain("Digit2");
}

export async function verifyBackgroundTabContinuity(
  input: BackgroundTabContinuityInput
): Promise<void> {
  const { macro, roleBId, roleId, tabA, tabB, windowGeneration } = input;
  const journeyFixtureCursor = await fixtureCursor();
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

  const firstFixtureCursor = await fixtureCursor();
  const macroCursor = await rendererEventCursor();
  await toggleMacroShortcut();
  const [runningBeforeSwitch, initialKeyDown] = await Promise.all([
    waitForMacroProjection({
      afterSequence: macroCursor,
      macroId: macro.id,
      minimumIteration: 1,
      roleIds: [roleId],
      state: "running"
    }),
    waitFixtureCode({
      afterSequence: firstFixtureCursor,
      code: "Digit2",
      kind: "consumer-keydown",
      roleId: "macro-background-a"
    })
  ]);
  expect(runningBeforeSwitch.find((status) => status.macroId === macro.id)?.iteration).toBe(1);
  expect(initialKeyDown.isTrusted).toBe(true);
  await expectTargetHeld();

  const continuityCursor = (await probe()).latestSequence;
  const hiddenCursor = await fixtureCursor();
  await input.activateVisibleRuntimeTab({
    tabId: tabB.id,
    windowGeneration,
    windowId: tabA.windowId
  });
  const hidden = await waitFixtureEvent({
    afterSequence: hiddenCursor,
    kind: "hidden",
    roleId: "macro-background-a"
  });
  if (process.platform === "win32") {
    await Promise.all([
      waitHeldKeyContinuity(continuityCursor, roleId, "reasserted", "hidden"),
      waitFixtureCode({
        afterSequence: hidden.sequence,
        code: "Digit2",
        kind: "consumer-keydown",
        roleId: "macro-background-a"
      })
    ]);
  }
  await expectTargetHeld();
  const operatedCursor = await fixtureCursor();
  await keyboardInputSequence([
    { code: "KeyZ", phase: "keyDown" },
    { code: "KeyZ", phase: "keyUp" }
  ], false);
  await waitFixtureCode({
    afterSequence: operatedCursor,
    code: "KeyZ",
    kind: "consumer-keyup",
    roleId: "macro-background-b"
  });
  await expectTargetHeld();

  await input.activateVisibleRuntimeTab({
    tabId: tabA.id,
    windowGeneration,
    windowId: tabA.windowId
  });

  await expectTargetHeld();
  await stopHeldMacro(macro.id);

  await input.activateVisibleRuntimeTab({
    tabId: tabB.id,
    windowGeneration,
    windowId: tabA.windowId
  });
  await runtimeUiAction(tabA.windowId, {
    action: "focusRole",
    roleId: roleBId,
    tabId: tabB.id,
    windowGeneration
  });
  const backgroundStartCursor = await rendererEventCursor();
  const backgroundFixtureCursor = await fixtureCursor();
  await toggleMacroShortcut();
  await Promise.all([
    waitForMacroProjection({
      afterSequence: backgroundStartCursor,
      macroId: macro.id,
      minimumIteration: 1,
      roleIds: [roleId],
      state: "running"
    }),
    waitFixtureCode({
      afterSequence: backgroundFixtureCursor,
      code: "Digit2",
      kind: "consumer-keydown",
      roleId: "macro-background-a"
    })
  ]);
  await expectTargetHeld();
  await input.activateVisibleRuntimeTab({
    tabId: tabA.id,
    windowGeneration,
    windowId: tabA.windowId
  });
  await expectTargetHeld();

  const state = await fixtureState();
  expect(state["macro-background-a"].consumerPressedCodes).toContain("Digit2");
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
  const backgroundEvents = await fixtureEvents({
    afterSequence: journeyFixtureCursor,
    roleId: "macro-background-b"
  });
  expect(backgroundEvents.filter((event) => event.code === "Digit2")).toEqual([]);
  await stopHeldMacro(macro.id);
}

export async function verifyWorkspaceHeldKeyContinuity(input: {
  roleAId: string;
  roleBId: string;
  tab: { id: string; windowId: string };
  windowGeneration: number;
}): Promise<void> {
  const heldMacro: Macro = await rendererCall("createMacro", {
    activationMode: "toggle",
    enabled: true,
    name: "E2E Multi Role Held Key Continuity",
    repeat: { type: "once" },
    roleIds: [input.roleAId],
    shortcutSourceScope: {
      roleIds: [input.roleAId, input.roleBId],
      type: "selected_roles"
    },
    steps: [{
      action: "hold_until_stop",
      code: "Digit2",
      id: "multirole-held-key",
      type: "key"
    }],
    trigger: { alt: false, code: "Digit6", ctrl: false, meta: false, shift: true }
  });
  const toggleHeldMacro = () => keyboardInputSequence([
    { code: "ShiftLeft", phase: "keyDown" },
    { code: "Digit6", phase: "keyDown" },
    { code: "Digit6", phase: "keyUp" },
    { code: "ShiftLeft", phase: "keyUp" }
  ], false);
  try {
    const focusRoleACursor = await fixtureCursor();
    await runtimeUiAction(input.tab.windowId, {
      action: "focusRole",
      roleId: input.roleAId,
      tabId: input.tab.id,
      windowGeneration: input.windowGeneration
    });
    await waitFixtureEvent({
      afterSequence: focusRoleACursor,
      kind: "click",
      roleId: "macro-multirole-a"
    });
    const heldStartCursor = await rendererEventCursor();
    const heldFixtureCursor = await fixtureCursor();
    await toggleHeldMacro();
    await Promise.all([
      waitForMacroProjection({
        afterSequence: heldStartCursor,
        macroId: heldMacro.id,
        roleIds: [input.roleAId],
        state: "running"
      }),
      waitFixtureCode({
        afterSequence: heldFixtureCursor,
        code: "Digit2",
        kind: "consumer-keydown",
        roleId: "macro-multirole-a"
      })
    ]);
    expect((await fixtureState())["macro-multirole-a"].consumerPressedCodes)
      .toContain("Digit2");

    const continuityCursor = (await probe()).latestSequence;
    const blurCursor = await fixtureCursor();
    await runtimeUiAction(input.tab.windowId, {
      action: "focusRole",
      roleId: input.roleBId,
      tabId: input.tab.id,
      windowGeneration: input.windowGeneration
    });
    const blur = await waitFixtureEvent({
      afterSequence: blurCursor,
      kind: "blur",
      roleId: "macro-multirole-a"
    });
    if (process.platform === "win32") {
      await Promise.all([
        waitHeldKeyContinuity(continuityCursor, input.roleAId, "reasserted", "blur"),
        waitFixtureCode({
          afterSequence: blur.sequence,
          code: "Digit2",
          kind: "consumer-keydown",
          roleId: "macro-multirole-a"
        })
      ]);
    }

    const roleBOperationCursor = await fixtureCursor();
    await keyboardInputSequence([
      { code: "KeyZ", phase: "keyDown" },
      { code: "KeyZ", phase: "keyUp" }
    ], false);
    await waitFixtureCode({
      afterSequence: roleBOperationCursor,
      code: "KeyZ",
      kind: "consumer-keyup",
      roleId: "macro-multirole-b"
    });
    expect((await fixtureState())["macro-multirole-a"].consumerPressedCodes)
      .toContain("Digit2");

    const heldStopCursor = await rendererEventCursor();
    const heldReleaseCursor = await fixtureCursor();
    await toggleHeldMacro();
    await Promise.all([
      waitForMacroProjection({
        afterSequence: heldStopCursor,
        absent: true,
        macroId: heldMacro.id
      }),
      waitFixtureCode({
        afterSequence: heldReleaseCursor,
        code: "Digit2",
        kind: "consumer-keyup",
        roleId: "macro-multirole-a"
      })
    ]);
  } finally {
    await rendererCall("stopMacro", heldMacro.id).catch(() => undefined);
    await rendererCall("deleteMacro", heldMacro.id).catch(() => undefined);
  }
}
