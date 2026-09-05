import { browser, expect } from "@wdio/globals";
import { Key } from "webdriverio";

import type { GameWindow, Macro, Role } from "../../../src/shared/types";
import {
  electronDesktopE2eFullscreenToolbarRuntime,
  electronDesktopE2eGameWindowRuntime,
  electronDesktopE2eProbe,
  electronDesktopE2eRoleSessionRuntime,
  electronDesktopE2eTrustedInputRuntime,
  type ElectronDesktopE2eTrustedInputObservation
} from "../support/electron-driver";
import { submitElectronRoleKeyPhases } from "../support/electron-role-surface";
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
  launchChromiumRoleVisible,
  macroFixtureUrl,
  showChromiumMacroWindow,
  writeChromiumMacroEvidence,
  type ChromiumMacroPlatform,
  type ChromiumMacroScenarioContext,
  type ChromiumRoleTab
} from "./chromium-macro-cutover-support";

// [journey:CHROMIUM-MACOS-APPKIT-MACRO-BACKGROUND-TAB-004]
// [journey:CHROMIUM-WINDOWS-MACRO-BACKGROUND-TAB-004]

const PHASE = "chromium-macro-background-tab";
const WINDOW_ID = "c8e00000-0000-4000-8000-000000000024";
const GAME_NAME = "Chromium Background Tab Game";
const MACRO_NAME = "Chromium Background Tab Macro";
const ROLE_A_NAME = "Chromium Background Tab Role A";
const ROLE_B_NAME = "Chromium Background Tab Role B";
const ROLE_A_FIXTURE = "chromium-background-a";
const ROLE_B_FIXTURE = "chromium-background-b";

interface BackgroundScenario {
  readonly gameId: string;
  readonly macro: Macro;
  readonly roles: readonly [Role, Role];
  readonly window: GameWindow;
}

interface HiddenPresentationEvidence {
  readonly roleA: Awaited<ReturnType<typeof electronDesktopE2eRoleSessionRuntime>>;
  readonly roleB: Awaited<ReturnType<typeof electronDesktopE2eRoleSessionRuntime>>;
  readonly topology: Awaited<
    ReturnType<typeof electronDesktopE2eFullscreenToolbarRuntime>
  >;
  readonly window: Awaited<ReturnType<typeof electronDesktopE2eGameWindowRuntime>>;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the background-tab journey`);
  return value;
}

function roleALaunchUrl(platform: ChromiumMacroPlatform): string {
  return macroFixtureUrl(
    ROLE_A_FIXTURE,
    platform === "windows" ? "resetConsumerInputOnContextLoss=1" : ""
  );
}

async function createScenario(
  platform: ChromiumMacroPlatform
): Promise<BackgroundScenario> {
  const roleAUrl = roleALaunchUrl(platform);
  const game = await rendererCall("createGame", {
    defaultLaunchUrl: roleAUrl,
    name: GAME_NAME
  });
  const roleA = await rendererCall("createRole", {
    gameId: game.id,
    launchUrl: roleAUrl,
    name: ROLE_A_NAME
  });
  const roleB = await rendererCall("createRole", {
    gameId: game.id,
    launchUrl: macroFixtureUrl(ROLE_B_FIXTURE),
    name: ROLE_B_NAME
  });
  const macro = await rendererCall("createMacro", {
    activationMode: "toggle",
    enabled: true,
    name: MACRO_NAME,
    repeat: { type: "once" },
    roleIds: [roleA.id],
    shortcutSourceScope: {
      roleIds: [roleA.id, roleB.id],
      type: "selected_roles"
    },
    steps: [{
      action: "hold_until_stop",
      code: "Digit2",
      id: "chromium-background-held-key",
      type: "key"
    }],
    trigger: {
      alt: false,
      code: "Digit4",
      ctrl: false,
      meta: false,
      shift: true
    }
  });
  const window = await createChromiumMacroWindow(
    WINDOW_ID,
    "Chromium Background Tab"
  );
  return { gameId: game.id, macro, roles: [roleA, roleB], window };
}

async function waitExactTrustedKey(input: Readonly<{
  afterSequence: number;
  code: string;
  kind: "consumer-keydown" | "keydown" | "keyup";
  roleId: string;
}>): Promise<FixtureEvent> {
  let cursor = input.afterSequence;
  for (;;) {
    const event = await waitFixtureEvent({
      afterSequence: cursor,
      kind: input.kind,
      roleId: input.roleId
    });
    if (event.code === input.code) {
      expect(event.isTrusted).toBe(true);
      return event;
    }
    cursor = event.sequence;
  }
}

async function waitInputObservation(input: Readonly<{
  afterSequence: number;
  intent: "cleanup" | "normal";
  phase: "hold" | "release";
  roleId: string;
}>): Promise<ElectronDesktopE2eTrustedInputObservation> {
  let observation: ElectronDesktopE2eTrustedInputObservation | undefined;
  await browser.waitUntil(async () => {
    observation = [...await electronDesktopE2eTrustedInputRuntime(input.roleId)]
      .reverse()
      .find((entry) => entry.sequence > input.afterSequence &&
        entry.request.intent === input.intent &&
        entry.request.action.type === "key" &&
        entry.request.action.code === "Digit2" &&
        entry.request.action.phase === input.phase &&
        entry.receipt.status === "applied");
    return observation !== undefined;
  }, {
    timeout: 20_000,
    timeoutMsg: `Missing applied Digit2 ${input.intent} ${input.phase} receipt`
  });
  return observation!;
}

async function submitToggleShortcut(role: Role, mainWindowHandle: string): Promise<void> {
  await submitElectronRoleKeyPhases(role.launchUrl!, mainWindowHandle, [
    { key: Key.Shift, phase: "keyDown" },
    { key: "4", phase: "keyDown" },
    { key: "4", phase: "keyUp" },
    { key: Key.Shift, phase: "keyUp" }
  ]);
}

async function observeHiddenPresentation(input: Readonly<{
  context: ChromiumMacroScenarioContext;
  hidden: ChromiumRoleTab;
  visible: ChromiumRoleTab;
}>): Promise<HiddenPresentationEvidence> {
  let evidence: HiddenPresentationEvidence | undefined;
  await browser.waitUntil(async () => {
    const [roleA, roleB, window, topology] = await Promise.all([
      electronDesktopE2eRoleSessionRuntime(input.hidden.role.id),
      electronDesktopE2eRoleSessionRuntime(input.visible.role.id),
      electronDesktopE2eGameWindowRuntime(input.visible.windowId),
      electronDesktopE2eFullscreenToolbarRuntime(input.visible.windowId)
    ]);
    evidence = { roleA, roleB, topology, window };
    return roleA.currentRuntime?.visible === false &&
      roleA.currentRuntime.focused === false &&
      roleB.currentRuntime?.visible === true &&
      roleB.currentRuntime.focused === true &&
      window.currentRuntime?.visible === true &&
      window.currentRuntime.focused === true &&
      topology.surfaces.filter((surface) => surface.visible).length === 1 &&
      topology.surfaces.find((surface) => surface.visible)?.tabId ===
        input.visible.tabId;
  }, {
    timeout: 30_000,
    timeoutMsg: "The exact sibling Role did not remain visible in the foreground window"
  });
  return evidence!;
}

async function activateAndObserveHidden(input: Readonly<{
  context: ChromiumMacroScenarioContext;
  hidden: ChromiumRoleTab;
  visible: ChromiumRoleTab;
}>): Promise<HiddenPresentationEvidence> {
  await activateChromiumRoleVisible(input.context, input.visible);
  return observeHiddenPresentation(input);
}

async function startFromShortcut(input: Readonly<{
  macro: Macro;
  source: Role;
  mainWindowHandle: string;
  fixtureAfter: number;
}>): Promise<FixtureEvent> {
  const projectionAfter = await rendererEventCursor();
  await submitToggleShortcut(input.source, input.mainWindowHandle);
  const [keydown] = await Promise.all([
    waitExactTrustedKey({
      afterSequence: input.fixtureAfter,
      code: "Digit2",
      kind: "keydown",
      roleId: ROLE_A_FIXTURE
    }),
    waitForMacroProjection({
      afterSequence: projectionAfter,
      macroId: input.macro.id,
      roleIds: [input.macro.roleIds[0]!],
      state: "running"
    })
  ]);
  return keydown;
}

async function stopFromShortcut(input: Readonly<{
  macro: Macro;
  source: Role;
  mainWindowHandle: string;
}>): Promise<FixtureEvent> {
  const fixtureAfter = await fixtureCursor();
  const projectionAfter = await rendererEventCursor();
  await submitToggleShortcut(input.source, input.mainWindowHandle);
  const [keyup] = await Promise.all([
    waitExactTrustedKey({
      afterSequence: fixtureAfter,
      code: "Digit2",
      kind: "keyup",
      roleId: ROLE_A_FIXTURE
    }),
    waitForMacroProjection({
      absent: true,
      afterSequence: projectionAfter,
      macroId: input.macro.id
    })
  ]);
  return keyup;
}

describe("Chromium Macro background-tab exact replacement", () => {
  it("preserves and starts a trusted hold in a hidden Role without selecting it", async () => {
    expect(required("RION_STUDIO_E2E_PHASE")).toBe(PHASE);
    const probe = await electronDesktopE2eProbe();
    const context = await bootstrapChromiumMacroCutover();
    const scenario = await createScenario(context.platform);
    await showChromiumMacroWindow(scenario.window);
    const tabA = await launchChromiumRoleVisible(
      scenario.roles[0], ROLE_A_FIXTURE, scenario.window
    );
    const tabB = await launchChromiumRoleVisible(
      scenario.roles[1], ROLE_B_FIXTURE, scenario.window
    );
    await activateChromiumRoleVisible(context, tabA);

    const journeyAfter = await fixtureCursor();
    const initialObservationCursor = Math.max(0,
      ...((await electronDesktopE2eTrustedInputRuntime(scenario.roles[0].id))
        .map((entry) => entry.sequence)));
    const firstKeydown = await startFromShortcut({
      fixtureAfter: journeyAfter,
      macro: scenario.macro,
      mainWindowHandle: context.mainWindowHandle,
      source: scenario.roles[0]
    });
    const firstHold = await waitInputObservation({
      afterSequence: initialObservationCursor,
      intent: "normal",
      phase: "hold",
      roleId: scenario.roles[0].id
    });
    const firstConsumerKeydown = await waitExactTrustedKey({
      afterSequence: firstKeydown.sequence,
      code: "Digit2",
      kind: "consumer-keydown",
      roleId: ROLE_A_FIXTURE
    });
    expect((await fixtureState())[ROLE_A_FIXTURE]!.consumerPressedCodes)
      .toContain("Digit2");

    const firstHiddenAfter = await fixtureCursor();
    const firstHiddenPresentation = await activateAndObserveHidden({
      context,
      hidden: tabA,
      visible: tabB
    });
    const firstHiddenEvent = await waitFixtureEvent({
      afterSequence: firstHiddenAfter,
      kind: "hidden",
      roleId: ROLE_A_FIXTURE
    });
    let continuityHold: ElectronDesktopE2eTrustedInputObservation | null = null;
    let firstHiddenKeydown: FixtureEvent | null = null;
    if (context.platform === "windows") {
      firstHiddenKeydown = await waitExactTrustedKey({
        afterSequence: firstHiddenEvent.sequence,
        code: "Digit2",
        kind: "keydown",
        roleId: ROLE_A_FIXTURE
      });
      continuityHold = await waitInputObservation({
        afterSequence: firstHold.sequence,
        intent: "normal",
        phase: "hold",
        roleId: scenario.roles[0].id
      });
      expect(continuityHold.request.action.type).toBe("key");
      if (continuityHold.request.action.type === "key" &&
        firstHold.request.action.type === "key") {
        expect(continuityHold.request.action.ownerId)
          .toBe(firstHold.request.action.ownerId);
      }
    }
    expect((await fixtureState())[ROLE_A_FIXTURE]!.consumerPressedCodes)
      .toContain("Digit2");

    const operationAfter = await fixtureCursor();
    await submitElectronRoleKeyPhases(
      scenario.roles[1].launchUrl!,
      context.mainWindowHandle,
      [{ key: "z", phase: "keyDown" }, { key: "z", phase: "keyUp" }]
    );
    const roleBKeyup = await waitExactTrustedKey({
      afterSequence: operationAfter,
      code: "KeyZ",
      kind: "keyup",
      roleId: ROLE_B_FIXTURE
    });
    expect((await fixtureState())[ROLE_A_FIXTURE]!.consumerPressedCodes)
      .toContain("Digit2");

    await activateChromiumRoleVisible(context, tabA);
    const firstKeyup = await stopFromShortcut({
      macro: scenario.macro,
      mainWindowHandle: context.mainWindowHandle,
      source: scenario.roles[0]
    });
    const firstCleanup = await waitInputObservation({
      afterSequence: continuityHold?.sequence ?? firstHold.sequence,
      intent: "cleanup",
      phase: "release",
      roleId: scenario.roles[0].id
    });

    const secondHiddenAfter = await fixtureCursor();
    const secondHiddenPresentation = await activateAndObserveHidden({
      context,
      hidden: tabA,
      visible: tabB
    });
    const secondHiddenEvent = await waitFixtureEvent({
      afterSequence: secondHiddenAfter,
      kind: "hidden",
      roleId: ROLE_A_FIXTURE
    });
    const secondKeydown = await startFromShortcut({
      fixtureAfter: secondHiddenEvent.sequence,
      macro: scenario.macro,
      mainWindowHandle: context.mainWindowHandle,
      source: scenario.roles[1]
    });
    const secondHiddenStartHold = await waitInputObservation({
      afterSequence: firstCleanup.sequence,
      intent: "normal",
      phase: "hold",
      roleId: scenario.roles[0].id
    });
    expect(secondHiddenStartHold.request.action.type).toBe("key");
    if (secondHiddenStartHold.request.action.type === "key" &&
      firstHold.request.action.type === "key") {
      expect(secondHiddenStartHold.request.action.ownerId)
        .not.toBe(firstHold.request.action.ownerId);
    }
    // Read-only post-operation proof: do not activate, show, select, or focus
    // either Role after the hidden Macro start. A stayed hidden and B stayed
    // selected only if the trusted-input path preserved presentation itself.
    const hiddenStartPresentation = await observeHiddenPresentation({
      context,
      hidden: tabA,
      visible: tabB
    });
    await waitExactTrustedKey({
      afterSequence: secondKeydown.sequence,
      code: "Digit2",
      kind: "consumer-keydown",
      roleId: ROLE_A_FIXTURE
    });
    expect((await fixtureState())[ROLE_A_FIXTURE]!.consumerPressedCodes)
      .toContain("Digit2");

    await activateChromiumRoleVisible(context, tabA);
    const secondKeyup = await stopFromShortcut({
      macro: scenario.macro,
      mainWindowHandle: context.mainWindowHandle,
      source: scenario.roles[0]
    });
    const secondCleanup = await waitInputObservation({
      afterSequence: secondHiddenStartHold.sequence,
      intent: "cleanup",
      phase: "release",
      roleId: scenario.roles[0].id
    });
    const state = await fixtureState();
    expect(state[ROLE_A_FIXTURE]!.consumerPressedCodes).not.toContain("Digit2");
    const roleBDigit2Events = (await fixtureEvents({
      afterSequence: journeyAfter,
      roleId: ROLE_B_FIXTURE
    })).filter((event) => event.code === "Digit2");
    expect(roleBDigit2Events).toEqual([]);
    const finalMacroStatuses = (await rendererCall("listMacroStatuses"))
      .filter((status) => status.macroId === scenario.macro.id);
    expect(finalMacroStatuses).toEqual([]);
    const finalRoleStatuses = (await rendererCall("listRoleStatuses"))
      .filter((status) => scenario.roles.some((role) => role.id === status.roleId));
    expect(finalRoleStatuses.every((status) => status.issueReason === undefined))
      .toBe(true);
    expect(finalRoleStatuses).toEqual(expect.arrayContaining([
      expect.objectContaining({
        automationState: "ready",
        roleId: scenario.roles[0].id,
        state: "running"
      }),
      expect.objectContaining({
        automationState: "ready",
        roleId: scenario.roles[1].id,
        state: "running"
      })
    ]));

    await writeChromiumMacroEvidence(
      "chromium-macro-background-tab-evidence.json",
      {
        continuityHold,
        finalConsumerPressedCodes: state[ROLE_A_FIXTURE]!.consumerPressedCodes,
        finalMacroStatuses,
        finalRoleStatuses,
        firstCleanup,
        firstConsumerKeydown,
        firstHiddenEvent,
        firstHiddenKeydown,
        firstHiddenPresentation,
        firstHold,
        firstKeydown,
        firstKeyup,
        gameId: scenario.gameId,
        gameWindowId: scenario.window.id,
        hiddenStartPresentation,
        macroId: scenario.macro.id,
        platform: context.platform,
        probe,
        roleAId: scenario.roles[0].id,
        roleBId: scenario.roles[1].id,
        roleBDigit2Events,
        roleBKeyup,
        secondCleanup,
        secondHiddenEvent,
        secondHiddenPresentation,
        secondHiddenStartHold,
        secondKeydown,
        secondKeyup,
        tabA: tabA.tabId,
        tabB: tabB.tabId
      }
    );
  });
});
