import { browser, expect } from "@wdio/globals";

import type { Game, Macro, Role } from "../../../src/shared/types";
import {
  controlWindow,
  mouseInput,
  probe,
  rendererCall,
  waitEvent,
  windowSnapshot
} from "../support/control";
import { fixtureCursor, fixtureEvents, waitFixtureEvent } from "../support/fixture";
import { waitShortcutLifecycle } from "./macro-runtime-keyboard-helpers";

interface MiddleButtonScenario {
  game: Game;
  macro: Macro;
  roles: Role[];
}

interface MiddleButtonPhaseDependencies {
  bootstrap(): Promise<void>;
  cleanup(scenario: MiddleButtonScenario): Promise<void>;
  createScenario(input: {
    fixtureRoleIds: string[];
    macroRoleIndexes?: number[];
    name: string;
    repeat: Macro["repeat"];
    steps: Macro["steps"];
    trigger: NonNullable<Macro["trigger"]>;
  }): Promise<MiddleButtonScenario>;
  launchRole(role: Role, destination: "new-window"): Promise<{
    id: string;
    windowId: string;
  }>;
  shutdownAndWaitForFlush(): Promise<void>;
  startMacro(macro: Macro, roleIds: string[]): Promise<number>;
}

async function focusWindowForPhysicalInput(windowId: string): Promise<void> {
  const snapshot = await windowSnapshot(windowId);
  const cursor = (await probe()).latestSequence;
  await controlWindow(windowId, { action: "focus" });
  await waitEvent({
    afterSequence: cursor,
    kind: "window-focus-acknowledged",
    minimumGeneration: snapshot.windowGeneration,
    windowId
  });
}

async function waitForRuntimeTabReady(input: {
  afterSequence: number;
  tabId: string;
  windowId: string;
}): Promise<void> {
  const snapshot = await windowSnapshot(input.windowId);
  if (snapshot.kernel?.tabs.find((tab) => tab.tabId === input.tabId)?.launchPhase ===
      "ready") return;
  await waitEvent({
    afterSequence: input.afterSequence,
    kind: `tab-launch-phase:${input.tabId}:ready`,
    timeoutMs: 55_000,
    windowId: input.windowId
  });
}

export async function middleButtonPhase(
  dependencies: MiddleButtonPhaseDependencies
): Promise<void> {
  await dependencies.bootstrap();
  const scenario = await dependencies.createScenario({
    fixtureRoleIds: ["macro-middle-button", "macro-middle-button-held"],
    macroRoleIndexes: [0],
    name: "E2E Middle Button",
    repeat: { intervalMs: 250, type: "loop" },
    steps: [{ id: "middle-delay", ms: 250, type: "delay" }],
    trigger: { alt: false, button: "middle", ctrl: false, meta: false, shift: false }
  });
  const firstLaunchCursor = (await probe()).latestSequence;
  const tab = await dependencies.launchRole(scenario.roles[0], "new-window");
  await waitForRuntimeTabReady({
    afterSequence: firstLaunchCursor,
    tabId: tab.id,
    windowId: tab.windowId
  });
  await focusWindowForPhysicalInput(tab.windowId);
  const fixtureAfter = await fixtureCursor();
  const controlAfter = (await probe()).latestSequence;
  await controlWindow(tab.windowId, { action: "movePointerToRoleContent" });
  expect(await mouseInput("mouseDown")).toMatchObject({
    button: "middle",
    phase: "mouseDown",
    status: "submitted"
  });
  await waitShortcutLifecycle({
    afterSequence: controlAfter,
    code: "MouseMiddle",
    macroId: scenario.macro.id,
    phase: "physical-keydown-managed",
    roleId: scenario.roles[0].id
  });
  expect(await mouseInput("mouseUp")).toMatchObject({
    button: "middle",
    phase: "mouseUp",
    status: "submitted"
  });
  await waitShortcutLifecycle({
    afterSequence: controlAfter,
    code: "MouseMiddle",
    macroId: scenario.macro.id,
    phase: "macro-dispatched",
    roleId: scenario.roles[0].id
  });
  await browser.waitUntil(async () => (await rendererCall("listMacroStatuses"))
    .some((status) => status.macroId === scenario.macro.id && status.state === "running"), {
      timeout: 45_000,
      timeoutMsg: "Middle-click shortcut did not start its macro"
    });
  expect((await fixtureEvents({
    afterSequence: fixtureAfter,
    roleId: "macro-middle-button"
  })).filter((event) => ["mousedown", "mouseup", "auxclick"].includes(event.kind))).toEqual([]);

  const stopCursor = (await probe()).latestSequence;
  await mouseInput("mouseDown");
  await mouseInput("mouseUp");
  await waitShortcutLifecycle({
    afterSequence: stopCursor,
    code: "MouseMiddle",
    macroId: scenario.macro.id,
    phase: "macro-dispatched",
    roleId: scenario.roles[0].id
  });
  await browser.waitUntil(async () => !(await rendererCall("listMacroStatuses"))
    .some((status) => status.macroId === scenario.macro.id), {
      timeout: 45_000,
      timeoutMsg: "Second middle-click shortcut did not stop its toggle macro"
    });
  const heldMacro = await rendererCall("createMacro", {
    activationMode: "while_held",
    enabled: true,
    name: "E2E Middle Button Held Macro",
    repeat: { intervalMs: 250, type: "loop" },
    roleIds: [scenario.roles[1].id],
    steps: [{ id: "held-delay", ms: 250, type: "delay" }],
    trigger: { alt: false, button: "middle", ctrl: false, meta: false, shift: false }
  });
  const heldLaunchCursor = (await probe()).latestSequence;
  const heldTab = await dependencies.launchRole(scenario.roles[1], "new-window");
  await waitForRuntimeTabReady({
    afterSequence: heldLaunchCursor,
    tabId: heldTab.id,
    windowId: heldTab.windowId
  });
  await focusWindowForPhysicalInput(heldTab.windowId);
  const heldFixtureAfter = await fixtureCursor();
  const heldControlAfter = (await probe()).latestSequence;
  await controlWindow(heldTab.windowId, { action: "movePointerToRoleContent" });
  await mouseInput("mouseDown");
  await waitShortcutLifecycle({
    afterSequence: heldControlAfter,
    code: "MouseMiddle",
    macroId: heldMacro.id,
    phase: "physical-keydown-managed",
    roleId: scenario.roles[1].id
  });
  await browser.waitUntil(async () => (await rendererCall("listMacroStatuses"))
    .some((status) => status.macroId === heldMacro.id
      && status.roleId === scenario.roles[1].id
      && status.state === "running"), {
      timeout: 45_000,
      timeoutMsg: "Middle-button hold did not start its while-held macro"
    });
  await mouseInput("mouseUp");
  await browser.waitUntil(async () => !(await rendererCall("listMacroStatuses"))
    .some((status) => status.macroId === heldMacro.id), {
    timeout: 45_000,
    timeoutMsg: "Middle-button release did not stop its while-held macro"
  });
  expect((await fixtureEvents({
    afterSequence: heldFixtureAfter,
    roleId: "macro-middle-button-held"
  })).filter((event) => ["mousedown", "mouseup", "auxclick"].includes(event.kind))).toEqual([]);
  await rendererCall("deleteMacro", heldMacro.id);
  await controlWindow(tab.windowId, { action: "movePointerToRoleContent" });

  const outputMacro = await rendererCall("createMacro", {
    activationMode: "toggle",
    enabled: true,
    name: "E2E Mouse Button Output Macro",
    repeat: { type: "once" },
    roleIds: [scenario.roles[0].id],
    steps: [
      { button: "left", id: "left", type: "click", xPercent: 50, yPercent: 50 },
      { button: "middle", id: "middle", type: "click", xPercent: 50, yPercent: 50 },
      { button: "right", id: "right", type: "click", xPercent: 50, yPercent: 50 }
    ]
  });
  const cursor = await fixtureCursor();
  await dependencies.startMacro(outputMacro, [scenario.roles[0].id]);
  const [leftClick, middleAuxClick, rightContextMenu] = await Promise.all([
    waitFixtureEvent({ afterSequence: cursor, kind: "click", roleId: "macro-middle-button" }),
    waitFixtureEvent({ afterSequence: cursor, kind: "auxclick", roleId: "macro-middle-button" }),
    waitFixtureEvent({ afterSequence: cursor, kind: "contextmenu", roleId: "macro-middle-button" })
  ]);
  expect([leftClick, middleAuxClick, rightContextMenu]
    .map((event) => ({ isTrusted: event.isTrusted, targetId: event.targetId })))
    .toEqual([
      { isTrusted: true, targetId: "qa-target" },
      { isTrusted: true, targetId: "qa-target" },
      { isTrusted: true, targetId: "qa-target" }
    ]);
  expect((await rendererCall("listMacroStatuses"))
    .some((status) => status.macroId === scenario.macro.id)).toBe(false);
  await rendererCall("deleteMacro", outputMacro.id);
  await dependencies.cleanup(scenario);
  await dependencies.shutdownAndWaitForFlush();
}
