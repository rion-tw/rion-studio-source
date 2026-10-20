import { browser, expect } from "@wdio/globals";
import type { GameWindow, Macro, Role } from "../../../src/shared/types";
import {
  electronDesktopE2eGameWindowRuntime, electronDesktopE2eTrustedInputRuntime,
  type ElectronDesktopE2eTrustedInputObservation
} from "../support/electron-driver";
import { fixtureCursor, fixtureState, waitFixtureEvent, type FixtureEvent } from "../support/fixture";
import { clickVisibleRuntimeWindowControl, runtimeWindowIsMinimized } from "../support/native-runtime-tabs";
import { rendererCall } from "../support/renderer-bridge";
import { focusWindowsRoleCanvas } from "../support/windows-role-canvas";
import {
  activateChromiumRoleVisible, openChromiumSection, writeChromiumMacroEvidence,
  type ChromiumMacroScenarioContext, type ChromiumRoleTab
} from "./chromium-macro-cutover-support";

async function latestObservation(roleId: string): Promise<number> {
  return Math.max(0, ...(await electronDesktopE2eTrustedInputRuntime(roleId)).map(entry => entry.sequence));
}

async function waitAppliedDigit2(input: Readonly<{
  afterSequence: number; intent: "cleanup" | "normal"; phase: "hold" | "release"; roleId: string;
}>): Promise<ElectronDesktopE2eTrustedInputObservation> {
  let observation: ElectronDesktopE2eTrustedInputObservation | undefined;
  await browser.waitUntil(async () => {
    observation = (await electronDesktopE2eTrustedInputRuntime(input.roleId)).find(entry =>
      entry.sequence > input.afterSequence && entry.request.intent === input.intent &&
      entry.request.action.type === "key" && entry.request.action.code === "Digit2" &&
      entry.request.action.phase === input.phase && entry.receipt.status === "applied");
    return observation !== undefined;
  }, { timeout: 20_000, timeoutMsg: `Missing applied Digit2 ${input.intent} ${input.phase} receipt` });
  return observation!;
}

async function waitMinimized(expected: boolean): Promise<void> {
  await browser.waitUntil(async () => {
    try {
      return await runtimeWindowIsMinimized("windows") === expected;
    } catch {
      return !expected;
    }
  }, { interval: 100, timeout: 30_000,
    timeoutMsg: `The exact Windows runtime host did not become ${expected ? "minimized" : "restored"}` });
}

/**
 * A taskbar minimize must not stop Canvas-compatible delivery. The Macro is
 * stopped from the visible Macros page while the game window stays minimized,
 * so its cleanup release is admitted against a minimized parent.
 */
export async function exerciseWindowsMinimizedHeldMacro(input: Readonly<{
  context: ChromiumMacroScenarioContext; fixtureId: string; macro: Macro; role: Role;
  start: () => Promise<FixtureEvent>; tab: ChromiumRoleTab; window: GameWindow;
}>): Promise<void> {
  await activateChromiumRoleVisible(input.context, input.tab);
  await focusWindowsRoleCanvas({ launchUrl: input.role.launchUrl!, mainWindowHandle: input.context.mainWindowHandle,
    windowId: input.window.id, roleId: input.role.id, fixtureId: input.fixtureId });
  const observationAfter = await latestObservation(input.role.id);
  await input.start();
  const hold = await waitAppliedDigit2({ afterSequence: observationAfter, intent: "normal", phase: "hold",
    roleId: input.role.id });

  await clickVisibleRuntimeWindowControl({ command: "minimize", mainWindowHandle: input.context.mainWindowHandle,
    platform: "windows", tabId: input.tab.tabId });
  await waitMinimized(true);
  const minimizedStatuses = (await rendererCall("listMacroStatuses"))
    .filter(status => status.macroId === input.macro.id);
  expect(minimizedStatuses.some(status => status.state === "running")).toBe(true);

  const releaseAfter = await fixtureCursor();
  await openChromiumSection("Macros", "/macros");
  const row = await $(`[data-selection-id='${input.macro.id}']`);
  await row.waitForDisplayed({ timeout: 10_000 });
  const stop = await row.$("button[aria-label='Stop']");
  await stop.waitForEnabled({ timeout: 20_000 });
  await stop.click();
  const cleanup = await waitAppliedDigit2({ afterSequence: hold.sequence, intent: "cleanup", phase: "release",
    roleId: input.role.id });
  let keyup: FixtureEvent | undefined;
  for (let cursor = releaseAfter; !keyup;) {
    const event = await waitFixtureEvent({ afterSequence: cursor, kind: "keyup", roleId: input.fixtureId });
    if (event.code === "Digit2") keyup = event;
    cursor = event.sequence;
  }
  expect(keyup.isTrusted).toBe(false);
  expect(await runtimeWindowIsMinimized("windows")).toBe(true);
  await browser.waitUntil(async () => !(await rendererCall("listMacroStatuses"))
    .some(status => status.macroId === input.macro.id), {
    timeout: 20_000, timeoutMsg: "The minimized Role Macro did not stop from the visible Macros page"
  });
  const observations = (await electronDesktopE2eTrustedInputRuntime(input.role.id))
    .filter(entry => entry.sequence > hold.sequence);
  // A refused or unknown delivery is what disabled the Role before; superseded
  // work never reached the page and is not evidence either way.
  expect(observations.filter(entry => entry.receipt.status === "failed" ||
    entry.receipt.status === "indeterminate")).toEqual([]);
  const roleStatus = (await rendererCall("listRoleStatuses")).find(status => status.roleId === input.role.id);
  expect(roleStatus).toEqual(expect.objectContaining({ automationState: "ready", state: "running" }));
  expect(roleStatus?.issueReason).toBeUndefined();
  expect((await fixtureState())[input.fixtureId]!.consumerPressedCodes).not.toContain("Digit2");

  await openChromiumSection("Windows", "/game-windows");
  const show = await $(`[data-selection-id='${input.window.id}'] button[aria-label='Show']`);
  await show.waitForClickable({ timeout: 10_000 });
  await show.click();
  await waitMinimized(false);
  await browser.waitUntil(async () =>
    (await electronDesktopE2eGameWindowRuntime(input.window.id)).currentRuntime?.visible === true, {
    timeout: 30_000, timeoutMsg: "The minimized game window did not restore from the visible Show action"
  });
  await writeChromiumMacroEvidence("chromium-macro-minimized-window.json", {
    cleanup, hold, keyup, minimizedStatuses, observations, roleStatus
  });
}
