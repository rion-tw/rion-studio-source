import { expect } from "@wdio/globals";

import {
  claimVisibleElectronRolePlaceholder,
  clickVisibleElectronRolePageButton
} from "../support/electron-role-surface";
import {
  fixtureCursor,
  fixtureEvents,
  waitFixtureEvent
} from "../support/fixture";
import { closeVisibleRuntimeTab } from "../support/native-runtime-tabs";
import { waitForMacroProjection } from "../support/renderer-events";
import { rendererCall } from "../support/renderer-bridge";
import {
  bootstrapChromiumMacroCutover,
  createChromiumMacroWindow,
  clickChromiumMacroStartVisible,
  expectChromiumNativeRoleBinding,
  launchChromiumWorkspaceVisible,
  macroFixtureUrl,
  showChromiumMacroWindow,
  startChromiumMacroVisible,
  stopChromiumMacroVisible,
  waitForChromiumMacroRoleReady,
  writeChromiumMacroEvidence
} from "./chromium-macro-cutover-support";

const WINDOW_ID = "c8e00000-0000-4000-8000-000000000023";
const SHARED_FIXTURE = "macro-multirole-a";
const ROLE_B_FIXTURE = "macro-multirole-b";
const WEB_FIXTURE = "macro-multirole-web";
const NAMES = Object.freeze({
  game: "Chromium Macro Topology Game",
  multiMacro: "Chromium Macro Multirole",
  roleB: "Chromium Macro Multirole B",
  shared: "Chromium Macro Shared Role",
  singleMacro: "Chromium Macro Ownership Single",
  window: "Chromium Macro Topology",
  workspaceA: "Chromium Macro Workspace A",
  workspaceB: "Chromium Macro Workspace B"
});

function requireNamed<T extends { name: string }>(items: readonly T[], name: string): T {
  const item = items.find((candidate) => candidate.name === name);
  if (!item) throw new Error(`Chromium Macro topology entity ${name} is unavailable`);
  return item;
}

export async function seedChromiumMacroTopologyCutover(): Promise<void> {
  const context = await bootstrapChromiumMacroCutover();
  const game = await rendererCall("createGame", {
    defaultLaunchUrl: macroFixtureUrl(SHARED_FIXTURE),
    name: NAMES.game
  });
  const shared = await rendererCall("createRole", {
    gameId: game.id,
    launchUrl: macroFixtureUrl(SHARED_FIXTURE),
    name: NAMES.shared
  });
  const roleB = await rendererCall("createRole", {
    gameId: game.id,
    launchUrl: macroFixtureUrl(ROLE_B_FIXTURE),
    name: NAMES.roleB
  });
  const multiMacro = await rendererCall("createMacro", {
    activationMode: "toggle",
    enabled: true,
    name: NAMES.multiMacro,
    repeat: { intervalMs: 120, type: "loop" },
    roleIds: [shared.id, roleB.id],
    steps: [{ action: "tap", code: "KeyM", id: "multirole-key", type: "key" }]
  });
  const singleMacro = await rendererCall("createMacro", {
    activationMode: "toggle",
    enabled: true,
    name: NAMES.singleMacro,
    repeat: { type: "once" },
    roleIds: [shared.id],
    steps: [{ action: "tap", code: "KeyS", id: "ownership-key", type: "key" }]
  });
  const workspaceA = await rendererCall("createLaunchWorkspace", {
    name: NAMES.workspaceA,
    slots: [
      { roleId: shared.id },
      { roleId: roleB.id },
      { web: { name: "Chromium Macro Web", startUrl: macroFixtureUrl(WEB_FIXTURE) } }
    ],
    template: "three_columns"
  });
  const workspaceB = await rendererCall("createLaunchWorkspace", {
    name: NAMES.workspaceB,
    slots: [{ roleId: shared.id }],
    template: "single"
  });
  const window = await createChromiumMacroWindow(WINDOW_ID, NAMES.window);
  await showChromiumMacroWindow(window);
  const tabA = await launchChromiumWorkspaceVisible(
    workspaceA,
    [SHARED_FIXTURE, ROLE_B_FIXTURE, WEB_FIXTURE],
    window
  );
  const bindingBefore = await expectChromiumNativeRoleBinding(context, {
    role: shared,
    tabId: tabA.tabId,
    windowId: tabA.windowId
  });

  const fixtureAfter = await fixtureCursor();
  const macroCursor = await startChromiumMacroVisible(
    multiMacro,
    [shared.id, roleB.id]
  );
  const [sharedKey, roleBKey] = await Promise.all([
    waitFixtureEvent({ afterSequence: fixtureAfter, kind: "keydown", roleId: SHARED_FIXTURE }),
    waitFixtureEvent({ afterSequence: fixtureAfter, kind: "keydown", roleId: ROLE_B_FIXTURE })
  ]);
  expect([sharedKey, roleBKey].every((event) =>
    event.code === "KeyM" && event.isTrusted === true
  )).toBe(true);
  const focusCursor = await fixtureCursor();
  await clickVisibleElectronRolePageButton(roleB.launchUrl!, context.mainWindowHandle);
  const roleBClick = await waitFixtureEvent({
    afterSequence: focusCursor,
    kind: "click",
    roleId: ROLE_B_FIXTURE
  });
  expect(roleBClick.isTrusted).toBe(true);
  await stopChromiumMacroVisible(multiMacro, macroCursor);

  const tabB = await launchChromiumWorkspaceVisible(workspaceB, [], window);
  const placeholderBeforeTransfer = await rendererCall("getEmbeddedRuntimeState");
  const sharedSlots = placeholderBeforeTransfer.tabs.flatMap((tab) => tab.slots)
    .filter((slot) => slot.roleId === shared.id);
  expect(sharedSlots).toEqual(expect.arrayContaining([
    expect.objectContaining({ owner: expect.objectContaining({ tabId: tabA.tabId }),
      state: "running" }),
    expect.objectContaining({ owner: expect.objectContaining({ tabId: tabA.tabId }),
      state: "blocked" })
  ]));
  const transferCursor = await fixtureCursor();
  await claimVisibleElectronRolePlaceholder({
    currentOwnerTabId: tabA.tabId,
    mainWindowHandle: context.mainWindowHandle,
    roleId: shared.id,
    targetTabId: tabB.tabId
  });
  const bindingAfter = await expectChromiumNativeRoleBinding(context, {
    role: shared,
    tabId: tabB.tabId,
    windowId: tabB.windowId
  });
  expect(bindingAfter.ownerGeneration).toBeGreaterThan(bindingBefore.ownerGeneration);
  await waitForChromiumMacroRoleReady(shared.id);
  await clickVisibleElectronRolePageButton(shared.launchUrl!, context.mainWindowHandle);
  const transferredClick = await waitFixtureEvent({
    afterSequence: transferCursor,
    kind: "click",
    roleId: SHARED_FIXTURE
  });
  expect(transferredClick.isTrusted).toBe(true);
  await closeVisibleRuntimeTab({
    mainWindowHandle: context.mainWindowHandle,
    platform: context.platform,
    tabId: tabA.tabId,
    tabName: workspaceA.name,
    windowId: tabA.windowId
  });

  const singleFixture = await fixtureCursor();
  const singleCursor = await clickChromiumMacroStartVisible(singleMacro);
  const sharedOnly = await waitFixtureEvent({
    afterSequence: singleFixture,
    kind: "keydown",
    roleId: SHARED_FIXTURE
  });
  expect(sharedOnly).toEqual(expect.objectContaining({ code: "KeyS", isTrusted: true }));
  const released = await waitFixtureEvent({ afterSequence: sharedOnly.sequence,
    kind: "consumer-keyup", roleId: SHARED_FIXTURE });
  expect(released).toEqual(expect.objectContaining({ code: "KeyS", isTrusted: true }));
  await waitForMacroProjection({ afterSequence: singleCursor, macroId: singleMacro.id, absent: true });
  expect(await fixtureEvents({
    afterSequence: singleFixture,
    kind: "keydown",
    roleId: ROLE_B_FIXTURE
  })).toEqual([]);
  await writeChromiumMacroEvidence("chromium-macro-topology-seed-evidence.json", {
    bindingAfter,
    bindingBefore,
    multiMacroId: multiMacro.id,
    platform: context.platform,
    sharedRoleId: shared.id,
    singleCursor,
    singleMacroId: singleMacro.id,
    tabA,
    tabB,
    windowId: window.id,
    workspaceAId: workspaceA.id,
    workspaceBId: workspaceB.id
  });
}

export async function restartChromiumMacroTopologyCutover(): Promise<void> {
  const context = await bootstrapChromiumMacroCutover();
  const roles = await rendererCall("listRoles");
  const macros = await rendererCall("listMacros");
  const workspaces = await rendererCall("listLaunchWorkspaces");
  const windows = await rendererCall("listGameWindows");
  const shared = requireNamed(roles, NAMES.shared);
  const singleMacro = requireNamed(macros, NAMES.singleMacro);
  const workspaceB = requireNamed(workspaces, NAMES.workspaceB);
  const window = requireNamed(windows, NAMES.window);
  const persistedTab = window.tabs.find((tab) => tab.sourceId === workspaceB.id);
  if (!persistedTab || persistedTab.tabType !== "workspace") {
    throw new Error("Persisted Chromium Macro Workspace B tab is unavailable");
  }
  expect(window.activeTabId).toBe(persistedTab.id);
  await showChromiumMacroWindow(window);
  const tab = { role: shared, tabId: persistedTab.id, windowId: window.id };
  const binding = await expectChromiumNativeRoleBinding(context, {
    role: shared,
    tabId: tab.tabId,
    windowId: tab.windowId
  });
  await waitForChromiumMacroRoleReady(shared.id);
  const fixtureAfter = await fixtureCursor();
  const singleCursor = await clickChromiumMacroStartVisible(singleMacro);
  const key = await waitFixtureEvent({
    afterSequence: fixtureAfter,
    kind: "keydown",
    roleId: SHARED_FIXTURE
  });
  expect(key).toEqual(expect.objectContaining({ code: "KeyS", isTrusted: true }));
  const released = await waitFixtureEvent({ afterSequence: key.sequence,
    kind: "consumer-keyup", roleId: SHARED_FIXTURE });
  expect(released).toEqual(expect.objectContaining({ code: "KeyS", isTrusted: true }));
  await waitForMacroProjection({ afterSequence: singleCursor, macroId: singleMacro.id, absent: true });
  await writeChromiumMacroEvidence("chromium-macro-topology-restart-evidence.json", {
    binding,
    platform: context.platform,
    roleId: shared.id,
    tabId: tab.tabId,
    windowId: window.id
  });
}
