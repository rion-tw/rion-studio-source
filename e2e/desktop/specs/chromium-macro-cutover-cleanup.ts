import { browser, expect } from "@wdio/globals";

import type { Macro, Role } from "../../../src/shared/types";
import { electronDesktopE2eTrustedInputRuntime } from "../support/electron-driver";
import { fixtureCursor, fixtureState, waitFixtureEvent } from "../support/fixture";
import {
  closeVisibleRuntimeTab,
  closeVisibleRuntimeWindow
} from "../support/native-runtime-tabs";
import { rendererCall } from "../support/renderer-bridge";
import { waitForMacroProjection } from "../support/renderer-events";
import {
  bootstrapChromiumMacroCutover,
  createChromiumMacroWindow,
  expectChromiumNativeRoleBinding,
  launchChromiumRoleVisible,
  macroFixtureUrl,
  quitChromiumApplicationVisible,
  showChromiumMacroWindow,
  startChromiumMacroVisible,
  stopChromiumMacroVisible,
  writeChromiumMacroEvidence,
  type ChromiumMacroScenarioContext,
  type ChromiumRoleTab
} from "./chromium-macro-cutover-support";

const WINDOW_A = "c8e00000-0000-4000-8000-000000000024";
const WINDOW_B = "c8e00000-0000-4000-8000-000000000025";
const WINDOW_C = "c8e00000-0000-4000-8000-000000000026";
const NAMES = Object.freeze({
  child: "Chromium Cleanup Child",
  game: "Chromium Cleanup Game",
  parent: "Chromium Cleanup Parent",
  roleParent: "Chromium Cleanup Parent Role",
  roleShutdown: "Chromium Cleanup Shutdown Role",
  roleTab: "Chromium Cleanup Tab Role",
  roleWindow: "Chromium Cleanup Window Role",
  shutdownMacro: "Chromium Cleanup Shutdown Macro",
  tabMacro: "Chromium Cleanup Tab Macro",
  windowA: "Chromium Cleanup Window A",
  windowB: "Chromium Cleanup Window B",
  windowC: "Chromium Cleanup Window C",
  windowMacro: "Chromium Cleanup Window Macro"
});
const FIXTURES = Object.freeze({
  parent: "chromium-cleanup-parent",
  shutdown: "chromium-cleanup-shutdown",
  tab: "chromium-cleanup-tab",
  window: "chromium-cleanup-window"
});

function requireNamed<T extends { name: string }>(items: readonly T[], name: string): T {
  const item = items.find((candidate) => candidate.name === name);
  if (!item) throw new Error(`Chromium terminal-cleanup entity ${name} is unavailable`);
  return item;
}

async function createRole(
  gameId: string,
  name: string,
  fixtureId: string
): Promise<Role> {
  return rendererCall("createRole", {
    gameId,
    launchUrl: macroFixtureUrl(fixtureId),
    name
  });
}

async function createHeldMacro(
  role: Role,
  name: string,
  code: string
): Promise<Macro> {
  return rendererCall("createMacro", {
    activationMode: "toggle",
    enabled: true,
    name,
    repeat: { type: "once" },
    roleIds: [role.id],
    steps: [{ action: "hold_until_stop", code, id: `${name}-held`, type: "key" }]
  });
}

async function expectExactCleanup(
  role: Role,
  afterSequence: number
): Promise<void> {
  const observations = await electronDesktopE2eTrustedInputRuntime(role.id);
  const cleanup = observations.find((entry) =>
    entry.sequence > afterSequence
      && entry.request.intent === "cleanup"
      && entry.request.action.type === "key"
      && entry.request.action.phase === "release"
  );
  expect(cleanup).toEqual(expect.objectContaining({
    receipt: expect.objectContaining({
      confirmedInputNeutrality: true,
      status: "applied"
    })
  }));
}

async function launchBound(
  context: ChromiumMacroScenarioContext,
  role: Role,
  fixtureId: string,
  windowId: string,
  windowName: string
): Promise<ChromiumRoleTab> {
  const window = await createChromiumMacroWindow(windowId, windowName);
  await showChromiumMacroWindow(window);
  const tab = await launchChromiumRoleVisible(role, fixtureId, window);
  await expectChromiumNativeRoleBinding(context, tab);
  return tab;
}

export async function seedChromiumMacroTerminalCleanup(): Promise<void> {
  const context = await bootstrapChromiumMacroCutover();
  const game = await rendererCall("createGame", {
    defaultLaunchUrl: macroFixtureUrl(FIXTURES.parent),
    name: NAMES.game
  });
  const parentRole = await createRole(game.id, NAMES.roleParent, FIXTURES.parent);
  const tabRole = await createRole(game.id, NAMES.roleTab, FIXTURES.tab);
  const windowRole = await createRole(game.id, NAMES.roleWindow, FIXTURES.window);
  const shutdownRole = await createRole(game.id, NAMES.roleShutdown, FIXTURES.shutdown);
  const child = await rendererCall("createMacro", {
    activationMode: "toggle",
    enabled: true,
    name: NAMES.child,
    repeat: { intervalMs: 100, type: "loop" },
    roleIds: [parentRole.id],
    steps: [{ action: "tap", code: "KeyC", id: "cleanup-child", type: "key" }]
  });
  const parent = await rendererCall("createMacro", {
    activationMode: "toggle",
    enabled: true,
    name: NAMES.parent,
    repeat: { type: "once" },
    roleIds: [parentRole.id],
    steps: [{
      callMode: "trigger",
      id: "cleanup-parent-child",
      macroId: child.id,
      type: "macro"
    }]
  });
  const tabMacro = await createHeldMacro(tabRole, NAMES.tabMacro, "KeyT");
  const windowMacro = await createHeldMacro(windowRole, NAMES.windowMacro, "KeyW");
  const shutdownMacro = await createHeldMacro(
    shutdownRole,
    NAMES.shutdownMacro,
    "KeyA"
  );
  const tabParent = await launchBound(
    context,
    parentRole,
    FIXTURES.parent,
    WINDOW_A,
    NAMES.windowA
  );
  const windowA = requireNamed(await rendererCall("listGameWindows"), NAMES.windowA);
  const tabChild = await launchChromiumRoleVisible(tabRole, FIXTURES.tab, windowA);
  const parentFixture = await fixtureCursor();
  const parentCursor = await startChromiumMacroVisible(parent, [parentRole.id]);
  const childKey = await waitFixtureEvent({
    afterSequence: parentFixture,
    kind: "keydown",
    roleId: FIXTURES.parent
  });
  expect(childKey).toEqual(expect.objectContaining({ code: "KeyC", isTrusted: true }));
  await stopChromiumMacroVisible(parent, parentCursor);
  await waitForMacroProjection({
    absent: true,
    afterSequence: parentCursor,
    macroId: child.id
  });
  expect((await rendererCall("listMacroStatuses")).some((status) =>
    status.macroId === child.id
  )).toBe(false);

  const tabFixture = await fixtureCursor();
  await startChromiumMacroVisible(tabMacro, [tabRole.id]);
  const tabDown = await waitFixtureEvent({
    afterSequence: tabFixture,
    kind: "keydown",
    roleId: FIXTURES.tab
  });
  const tabObservations = await electronDesktopE2eTrustedInputRuntime(tabRole.id);
  await closeVisibleRuntimeTab({
    mainWindowHandle: context.mainWindowHandle,
    platform: context.platform,
    tabId: tabChild.tabId,
    tabName: tabRole.name,
    windowId: tabChild.windowId
  });
  await waitFixtureEvent({
    afterSequence: tabDown.sequence,
    kind: "keyup",
    roleId: FIXTURES.tab
  });
  await expectExactCleanup(tabRole, tabObservations.at(-1)?.sequence ?? 0);
  await closeVisibleRuntimeWindow({
    mainWindowHandle: context.mainWindowHandle,
    platform: context.platform
  });

  const tabWindow = await launchBound(
    context,
    windowRole,
    FIXTURES.window,
    WINDOW_B,
    NAMES.windowB
  );
  const windowFixture = await fixtureCursor();
  await startChromiumMacroVisible(windowMacro, [windowRole.id]);
  const windowDown = await waitFixtureEvent({
    afterSequence: windowFixture,
    kind: "keydown",
    roleId: FIXTURES.window
  });
  const windowObservations = await electronDesktopE2eTrustedInputRuntime(windowRole.id);
  await closeVisibleRuntimeWindow({
    mainWindowHandle: context.mainWindowHandle,
    platform: context.platform
  });
  await waitFixtureEvent({
    afterSequence: windowDown.sequence,
    kind: "keyup",
    roleId: FIXTURES.window
  });
  await expectExactCleanup(windowRole, windowObservations.at(-1)?.sequence ?? 0);

  const tabShutdown = await launchBound(
    context,
    shutdownRole,
    FIXTURES.shutdown,
    WINDOW_C,
    NAMES.windowC
  );
  const shutdownFixture = await fixtureCursor();
  await startChromiumMacroVisible(shutdownMacro, [shutdownRole.id]);
  const shutdownDown = await waitFixtureEvent({
    afterSequence: shutdownFixture,
    kind: "keydown",
    roleId: FIXTURES.shutdown
  });
  expect((await fixtureState())[FIXTURES.shutdown]?.pressedCodes).toContain("KeyA");
  const nativeBinding = await expectChromiumNativeRoleBinding(context, tabShutdown);
  await writeChromiumMacroEvidence("chromium-macro-terminal-cleanup-seed.json", {
    nativeBinding,
    parentRoleId: parentRole.id,
    platform: context.platform,
    shutdownDown,
    shutdownMacroId: shutdownMacro.id,
    shutdownRoleId: shutdownRole.id,
    tabParent,
    tabShutdown,
    tabWindow
  });
  await quitChromiumApplicationVisible(context);
}

export async function restartChromiumMacroTerminalCleanup(): Promise<void> {
  const context = await bootstrapChromiumMacroCutover();
  const roles = await rendererCall("listRoles");
  const macros = await rendererCall("listMacros");
  const windows = await rendererCall("listGameWindows");
  const role = requireNamed(roles, NAMES.roleShutdown);
  const macro = requireNamed(macros, NAMES.shutdownMacro);
  const window = requireNamed(windows, NAMES.windowC);
  await showChromiumMacroWindow(window);
  let restoredTab: ChromiumRoleTab | undefined;
  await browser.waitUntil(async () => {
    const runtime = await rendererCall("getEmbeddedRuntimeState");
    const tab = runtime.tabs.find((candidate) =>
      candidate.sourceId === role.id && candidate.windowId === window.id
    );
    if (!tab) return false;
    restoredTab = { role, tabId: tab.id, windowId: tab.windowId };
    return true;
  }, {
    interval: 50,
    timeout: 15_000,
    timeoutMsg: "The cleanly persisted shutdown Role did not restore into its exact window"
  });
  const tab = restoredTab!;
  const binding = await expectChromiumNativeRoleBinding(context, tab);
  const fixtureAfter = await fixtureCursor();
  const macroCursor = await startChromiumMacroVisible(macro, [role.id]);
  const keyDown = await waitFixtureEvent({
    afterSequence: fixtureAfter,
    kind: "keydown",
    roleId: FIXTURES.shutdown
  });
  expect(keyDown).toEqual(expect.objectContaining({ code: "KeyA", isTrusted: true }));
  await stopChromiumMacroVisible(macro, macroCursor);
  const keyUp = await waitFixtureEvent({
    afterSequence: keyDown.sequence,
    kind: "keyup",
    roleId: FIXTURES.shutdown
  });
  expect(keyUp.isTrusted).toBe(true);
  expect((await fixtureState())[FIXTURES.shutdown]?.pressedCodes).toEqual([]);
  await writeChromiumMacroEvidence("chromium-macro-terminal-cleanup-restart.json", {
    binding,
    macroId: macro.id,
    platform: context.platform,
    roleId: role.id,
    tabId: tab.tabId
  });
}
