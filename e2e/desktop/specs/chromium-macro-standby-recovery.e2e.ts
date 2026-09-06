import { $, browser, expect } from "@wdio/globals";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { Game, GameWindow, Macro, Role } from "../../../src/shared/types";
import {
  electronDesktopE2eApplicationLifecycleSignal,
  electronDesktopE2eFullscreenToolbarRuntime,
  electronDesktopE2eGameWindowRuntime,
  electronDesktopE2eProbe,
  electronDesktopE2eRoleSessionRuntime,
  electronDesktopE2eTrustedInputRuntime,
  type ElectronDesktopE2eTrustedInputObservation
} from "../support/electron-driver";
import {
  fixtureCursor,
  fixtureEvents,
  fixtureRequest,
  fixtureState,
  waitFixtureEvent
} from "../support/fixture";
import { clickVisibleRuntimeTab } from "../support/native-runtime-tabs";
import { rendererCall } from "../support/renderer-bridge";
import {
  acceptLegalAndSkipFirstRun,
  ensureEnglishUi,
  waitForRoute
} from "../support/ui";

// [journey:CHROMIUM-MACOS-APPKIT-MACRO-STANDBY-RECOVERY-023]
// [journey:CHROMIUM-WINDOWS-MACRO-STANDBY-RECOVERY-023]

const GAME_NAME = "Chromium Standby Recovery Game";
const MACRO_NAME = "Chromium Standby Recovery Macro";
const ROLE_A_NAME = "Chromium Standby Recovery Role A";
const ROLE_B_NAME = "Chromium Standby Recovery Role B";
const ROLE_A_FIXTURE = "chromium-standby-a";
const ROLE_B_FIXTURE = "chromium-standby-b";
const PHASE = "chromium-macro-standby-recovery";

type Platform = "macos" | "windows";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the Chromium standby journey`);
  return value;
}

function platform(): Platform {
  const target = required("RION_STUDIO_E2E_RUNTIME_TARGET");
  if (target === "chromium-v23-macos-appkit") return "macos";
  if (target === "chromium-v23-windows") return "windows";
  throw new Error(`Unsupported Chromium standby runtime target ${target}`);
}

function launchUrl(fixtureId: string): string {
  return new URL(`/role/${fixtureId}`, required(
    "RION_STUDIO_E2E_FIXTURE_ORIGIN"
  )).href;
}

async function openSection(label: string, route: string): Promise<void> {
  const sidebar = await $(".app-main-sidebar");
  await sidebar.waitForDisplayed({ timeout: 20_000 });
  await sidebar.$(`button*=${label}`).click();
  await waitForRoute(route);
}

async function createScenario(): Promise<Readonly<{
  game: Game;
  gameWindow: GameWindow;
  macro: Macro;
  roles: readonly [Role, Role];
}>> {
  const game = await rendererCall("createGame", {
    defaultLaunchUrl: launchUrl(ROLE_A_FIXTURE),
    name: GAME_NAME
  });
  const roleA = await rendererCall("createRole", {
    gameId: game.id,
    launchUrl: launchUrl(ROLE_A_FIXTURE),
    name: ROLE_A_NAME
  });
  const roleB = await rendererCall("createRole", {
    gameId: game.id,
    launchUrl: launchUrl(ROLE_B_FIXTURE),
    name: ROLE_B_NAME
  });
  const macro = await rendererCall("createMacro", {
    activationMode: "toggle",
    enabled: true,
    name: MACRO_NAME,
    repeat: { type: "once" },
    roleIds: [roleA.id],
    steps: [{
      action: "hold_until_stop",
      code: "KeyS",
      id: "chromium-standby-held-key",
      type: "key"
    }]
  });

  await openSection("Windows", "/game-windows");
  const before = new Set((await rendererCall("listGameWindows")).map((entry) => entry.id));
  await $("button=New game window").click();
  let gameWindow: GameWindow | undefined;
  await browser.waitUntil(async () => {
    gameWindow = (await rendererCall("listGameWindows"))
      .find((entry) => !before.has(entry.id));
    return gameWindow !== undefined;
  }, { timeout: 15_000, timeoutMsg: "Visible UI did not create standby Game Window" });
  return { game, gameWindow: gameWindow!, macro, roles: [roleA, roleB] };
}

async function showSavedWindow(gameWindow: GameWindow): Promise<void> {
  await openSection("Windows", "/game-windows");
  const row = await $(`[data-selection-id='${gameWindow.id}']`);
  await row.waitForDisplayed({ timeout: 10_000 });
  const show = await row.$("button[aria-label='Show']");
  await show.waitForClickable({ timeout: 10_000 });
  await show.click();
  await browser.waitUntil(async () => (
    await electronDesktopE2eGameWindowRuntime(gameWindow.id)
  ).currentRuntime?.visible === true, {
    timeout: 30_000,
    timeoutMsg: "Standby Game Window did not become native-visible"
  });
}

async function launchRoleIntoWindow(
  role: Role,
  fixtureId: string,
  gameWindow: GameWindow
): Promise<string> {
  await openSection("Home", "/dashboard");
  await $("[data-testid='quick-access-trigger']").click();
  const palette = await $("[data-testid='quick-access-palette'][open]");
  await palette.waitForDisplayed({ timeout: 10_000 });
  await palette.$("input[role='combobox']").setValue(role.name);
  await $(`[data-testid='quick-access-destination-role-${role.id}']`).click();
  const destination = await $(
    `[data-testid='quick-access-destination-option-window-${gameWindow.id}']`
  );
  await destination.waitForClickable({ timeout: 10_000 });
  const afterSequence = await fixtureCursor();
  await destination.click();
  await waitFixtureEvent({ afterSequence, kind: "session", roleId: fixtureId });
  let tabId: string | undefined;
  await browser.waitUntil(async () => {
    const runtime = await rendererCall("getEmbeddedRuntimeState");
    tabId = runtime.tabs.find((tab) => tab.sourceId === role.id)?.id;
    return Boolean(tabId) && (await rendererCall("listRoleStatuses"))
      .some((status) => status.roleId === role.id && status.state === "running");
  }, { timeout: 45_000, timeoutMsg: `Role ${role.id} did not reach Chromium running` });
  return tabId!;
}

async function activateRoleTab(input: Readonly<{
  gameWindow: GameWindow;
  mainWindowHandle: string;
  platform: Platform;
  role: Role;
  tabId: string;
}>): Promise<void> {
  await clickVisibleRuntimeTab({
    mainWindowHandle: input.mainWindowHandle,
    platform: input.platform,
    tabId: input.tabId,
    tabName: input.role.name
  });
  await browser.waitUntil(async () => (await rendererCall("getEmbeddedRuntimeState"))
    .windows.some((window) => window.id === input.gameWindow.id &&
      window.activeTabId === input.tabId), {
    timeout: 30_000,
    timeoutMsg: `Visible native tab ${input.tabId} did not become active`
  });
}

async function waitMacroTerminal(macroId: string): Promise<void> {
  await browser.waitUntil(async () => !(await rendererCall("listMacroStatuses"))
    .some((status) => status.macroId === macroId && [
      "recovering", "running", "stopping"
    ].includes(status.state)), {
    timeout: 20_000,
    timeoutMsg: `Macro ${macroId} did not reach a terminal state`
  });
}

async function waitExactTrustedKey(input: Readonly<{
  afterSequence: number;
  code: string;
  kind: "keydown" | "keyup";
  roleId: string;
}>): Promise<Awaited<ReturnType<typeof waitFixtureEvent>>> {
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

async function heldKeyObservation(
  roleId: string,
  input: Readonly<{ afterSequence?: number; intent: "cleanup" | "normal"; phase: "hold" | "release"; }>
): Promise<ElectronDesktopE2eTrustedInputObservation> {
  let observation: ElectronDesktopE2eTrustedInputObservation | undefined;
  // E2E external receipt boundary: DOM delivery can precede coordinator terminality.
  // Wait for the exact terminal record, then assert its outcome without retrying failure.
  await browser.waitUntil(async () => {
    observation = [...await electronDesktopE2eTrustedInputRuntime(roleId)].reverse().find((entry) =>
      entry.sequence > (input.afterSequence ?? 0) && entry.request.intent === input.intent &&
      entry.request.action.type === "key" && entry.request.action.code === "KeyS" &&
      entry.request.action.phase === input.phase);
    return observation !== undefined;
  }, { timeout: 20_000, timeoutMsg: `Missing ${input.intent} KeyS ${input.phase} terminal receipt` });
  expect(observation!.receipt.status).toBe("applied");
  return observation!;
}

async function openMacroRow(macro: Macro) {
  await openSection("Macros", "/macros");
  const row = await $(`[data-selection-id='${macro.id}']`);
  await row.waitForDisplayed({ timeout: 10_000 });
  return row;
}

describe("Chromium Macro standby recovery exact replacement", () => {
  it("terminalizes held input on suspend and starts from the beginning after wake", async () => {
    expect(required("RION_STUDIO_E2E_PHASE")).toBe(PHASE);
    const probe = await electronDesktopE2eProbe();
    const targetPlatform = platform();
    expect(probe.runtimeTarget).toBe(required("RION_STUDIO_E2E_RUNTIME_TARGET"));
    await ensureEnglishUi();
    await acceptLegalAndSkipFirstRun();
    await fixtureRequest("/api/reset", {});
    const mainWindowHandle = await browser.getWindowHandle();
    const scenario = await createScenario();
    await showSavedWindow(scenario.gameWindow);
    const tabA = await launchRoleIntoWindow(
      scenario.roles[0], ROLE_A_FIXTURE, scenario.gameWindow
    );
    const tabB = await launchRoleIntoWindow(
      scenario.roles[1], ROLE_B_FIXTURE, scenario.gameWindow
    );

    await activateRoleTab({
      gameWindow: scenario.gameWindow,
      mainWindowHandle,
      platform: targetPlatform,
      role: scenario.roles[0],
      tabId: tabA
    });
    const row = await openMacroRow(scenario.macro);
    const firstCursor = await fixtureCursor();
    const start = await row.$("button[aria-label='Start']");
    await start.waitForEnabled({ timeout: 20_000 });
    await start.click();
    const firstKeydown = await waitExactTrustedKey({
      afterSequence: firstCursor,
      code: "KeyS",
      kind: "keydown",
      roleId: ROLE_A_FIXTURE
    });
    const firstHold = await heldKeyObservation(scenario.roles[0].id, {
      intent: "normal",
      phase: "hold"
    });
    await activateRoleTab({
      gameWindow: scenario.gameWindow,
      mainWindowHandle,
      platform: targetPlatform,
      role: scenario.roles[1],
      tabId: tabB
    });

    const suspend = await electronDesktopE2eApplicationLifecycleSignal("suspend");
    expect(suspend.terminal).toEqual(expect.objectContaining({
      lifecycleEpoch: suspend.before.lifecycleEpoch + 1,
      platform: targetPlatform,
      revision: suspend.before.revision + 2,
      state: "suspended"
    }));
    await waitMacroTerminal(scenario.macro.id);
    await waitExactTrustedKey({
      afterSequence: firstKeydown.sequence,
      code: "KeyS",
      kind: "keyup",
      roleId: ROLE_A_FIXTURE
    });
    expect((await fixtureState())[ROLE_A_FIXTURE]!.pressedCodes).toEqual([]);
    await start.waitForEnabled({ reverse: true, timeout: 20_000 });
    const suspendCleanup = await heldKeyObservation(scenario.roles[0].id, {
      afterSequence: firstHold.sequence,
      intent: "cleanup",
      phase: "release"
    });
    expect(suspendCleanup.receipt.confirmedInputNeutrality).toBe(true);
    expect(suspendCleanup.request.inputEpoch).toBeGreaterThan(firstHold.request.inputEpoch);

    const resume = await electronDesktopE2eApplicationLifecycleSignal("resume");
    expect(resume.terminal).toEqual(expect.objectContaining({
      lifecycleEpoch: suspend.terminal.lifecycleEpoch + 1,
      platform: targetPlatform,
      revision: suspend.terminal.revision + 2,
      state: "active"
    }));
    if (targetPlatform === "windows") {
      await activateRoleTab({
        gameWindow: scenario.gameWindow,
        mainWindowHandle,
        platform: targetPlatform,
        role: scenario.roles[0],
        tabId: tabA
      });
    }
    const resumedRow = await openMacroRow(scenario.macro);
    const resumedStart = await resumedRow.$("button[aria-label='Start']");
    await resumedStart.waitForEnabled({ timeout: 20_000 });
    const secondCursor = await fixtureCursor();
    await resumedStart.click();
    const secondKeydown = await waitExactTrustedKey({
      afterSequence: secondCursor,
      code: "KeyS",
      kind: "keydown",
      roleId: ROLE_A_FIXTURE
    });
    const secondHold = await heldKeyObservation(scenario.roles[0].id, {
      afterSequence: suspendCleanup.sequence,
      intent: "normal",
      phase: "hold"
    });
    expect(secondHold.request.requestId).not.toBe(firstHold.request.requestId);
    expect(secondHold.request.inputEpoch).toBeGreaterThanOrEqual(
      suspendCleanup.request.inputEpoch
    );
    await activateRoleTab({
      gameWindow: scenario.gameWindow,
      mainWindowHandle,
      platform: targetPlatform,
      role: scenario.roles[1],
      tabId: tabB
    });
    const stopRow = await openMacroRow(scenario.macro);
    const stop = await stopRow.$("button[aria-label='Stop']");
    await stop.waitForEnabled({ timeout: 20_000 });
    await stop.click();
    await waitMacroTerminal(scenario.macro.id);
    await waitExactTrustedKey({
      afterSequence: secondKeydown.sequence,
      code: "KeyS",
      kind: "keyup",
      roleId: ROLE_A_FIXTURE
    });
    expect((await fixtureState())[ROLE_A_FIXTURE]!.pressedCodes).toEqual([]);
    expect((await fixtureEvents({
      afterSequence: firstCursor,
      kind: "keydown",
      roleId: ROLE_B_FIXTURE
    }))).toHaveLength(0);

    const stopCleanup = await heldKeyObservation(scenario.roles[0].id, {
      afterSequence: secondHold.sequence,
      intent: "cleanup",
      phase: "release"
    });
    expect(stopCleanup.receipt.confirmedInputNeutrality).toBe(true);
    const [roleRuntime, gameWindowRuntime, topology] = await Promise.all([
      electronDesktopE2eRoleSessionRuntime(scenario.roles[0].id),
      electronDesktopE2eGameWindowRuntime(scenario.gameWindow.id),
      electronDesktopE2eFullscreenToolbarRuntime(scenario.gameWindow.id)
    ]);
    expect(gameWindowRuntime.currentRuntime?.hostKind).toBe(
      targetPlatform === "macos" ? "appkit-chromium" : "bundled-chromium"
    );
    expect(roleRuntime.currentRuntime?.appKitIdentity === null).toBe(
      targetPlatform === "windows"
    );
    expect(topology.surfaces.filter((surface) => surface.visible)).toEqual([
      expect.objectContaining({ tabId: tabB, visible: true })
    ]);

    await writeFile(
      resolve(
        required("RION_STUDIO_E2E_ARTIFACT_DIR"),
        "chromium-macro-standby-recovery-evidence.json"
      ),
      `${JSON.stringify({
        firstHold,
        gameId: scenario.game.id,
        gameWindowId: scenario.gameWindow.id,
        gameWindowRuntime,
        macroId: scenario.macro.id,
        platform: targetPlatform,
        probe,
        resume,
        roleAId: scenario.roles[0].id,
        roleBId: scenario.roles[1].id,
        roleRuntime,
        secondHold,
        stopCleanup,
        suspend,
        suspendCleanup,
        tabA,
        tabB,
        topology
      }, null, 2)}\n`
    );
  });
});
