import { $, browser, expect } from "@wdio/globals";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { Game, GameWindow, LaunchWorkspace, Role } from "../../../src/shared/types";
import {
  electronDesktopE2eGameWindowRuntime,
  electronDesktopE2eProbe,
  electronDesktopE2eRoleSessionRuntime,
  electronDesktopE2eWorkspaceWebRuntime
} from "../support/electron-driver";
import { fixtureCursor, waitFixtureEvent } from "../support/fixture";
import { clickVisibleRuntimeTab } from "../support/native-runtime-tabs";
import { forceTerminateProcessTree } from "../support/process";
import { rendererCall } from "../support/renderer-bridge";
import {
  acceptLegalAndSkipFirstRun,
  clickWorkspaceCreateAction,
  ensureEnglishUi,
  navigate,
  setEditorName,
  setInputValue,
  submitEditor,
  waitForRoute
} from "../support/ui";

// [journey:CHROMIUM-MACOS-APPKIT-MIXED-RECOVERY-021]
// [journey:CHROMIUM-WINDOWS-MIXED-RECOVERY-021]

const GAME_NAME = "Chromium Mixed Recovery Game";
const ROLE_TAB_NAME = "Chromium Mixed Recovery Role tab";
const ROLE_WORKSPACE_NAME = "Chromium Mixed Recovery Workspace role";
const WORKSPACE_NAME = "Chromium Mixed Recovery Workspace";
const WINDOW_NAME = "Chromium Mixed Recovery Window";
const WEB_NAME = "Chromium Mixed Recovery Web";
const ROLE_TAB_FIXTURE = "chromium-mixed-recovery-role-tab";
const ROLE_WORKSPACE_FIXTURE = "chromium-mixed-recovery-role-workspace";
const WEB_FIXTURE = "chromium-mixed-recovery-web";
const MARKERS = {
  roleTab: "chromium-mixed-recovery-role-tab-marker",
  roleWorkspace: "chromium-mixed-recovery-role-workspace-marker",
  web: "chromium-mixed-recovery-web-marker"
} as const;

interface MixedRecoveryLifecycle {
  contractVersion: 1;
  platform: "macos" | "windows";
  roleTab: { chromiumPathSha256: string; roleId: string; tabId: string };
  roleWorkspace: { chromiumPathSha256: string; roleId: string };
  web: { marker: string; slotId: string };
  windowId: string;
  workspace: { id: string; tabId: string };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by mixed recovery`);
  return value;
}

function fixtureUrl(fixtureId: string, marker: string): string {
  const url = new URL(`/role/${fixtureId}`, required("RION_STUDIO_E2E_FIXTURE_ORIGIN"));
  url.searchParams.set("marker", marker);
  url.searchParams.set("mode", "seed");
  return url.href;
}

function lifecyclePath(): string {
  return resolve(dirname(required("RION_STUDIO_E2E_ARTIFACT_DIR")),
    "chromium-mixed-recovery-evidence.json");
}

async function openSection(label: string, route: string): Promise<void> {
  const sidebar = await $(".app-main-sidebar");
  await sidebar.waitForDisplayed({ timeout: 20_000 });
  const button = await sidebar.$(`button*=${label}`);
  await button.waitForClickable({ timeout: 10_000 });
  await button.click();
  await waitForRoute(route);
}

async function findEntity<Value extends { name: string }>(
  name: string,
  read: () => Promise<Value[]>
): Promise<Value> {
  let entity: Value | undefined;
  await browser.waitUntil(async () => {
    entity = (await read()).find((candidate) => candidate.name === name);
    return entity !== undefined;
  }, { timeout: 15_000, timeoutMsg: `Missing persisted entity ${name}` });
  return entity!;
}

async function menuAction(entityId: string, triggerLabel: string, action: string): Promise<void> {
  const row = await $(`[data-selection-id='${entityId}']`);
  await row.waitForDisplayed({ timeout: 10_000 });
  await row.scrollIntoView({ block: "center", inline: "center" });
  await row.moveTo();
  const trigger = await row.$(`button[aria-label='${triggerLabel}']`);
  await trigger.waitForClickable({ timeout: 10_000 });
  await trigger.click();
  const item = await $(`//*[@role='menuitem' and normalize-space(.)='${action}']`);
  await item.waitForClickable({ timeout: 10_000 });
  await item.click();
}

async function createGameAndRoles(): Promise<readonly [Game, Role, Role]> {
  await openSection("Games", "/games");
  await $("button=New game").click();
  await waitForRoute("/games/new");
  await setEditorName(GAME_NAME);
  await $("#game-launch-url").setValue(fixtureUrl(ROLE_TAB_FIXTURE, MARKERS.roleTab));
  await submitEditor("/games");
  const game = await findEntity(GAME_NAME, () => rendererCall("listGames"));
  const roles: Role[] = [];
  for (const [name, fixture, marker] of [
    [ROLE_TAB_NAME, ROLE_TAB_FIXTURE, MARKERS.roleTab],
    [ROLE_WORKSPACE_NAME, ROLE_WORKSPACE_FIXTURE, MARKERS.roleWorkspace]
  ] as const) {
    await openSection("Games", "/games");
    await menuAction(game.id, "Game actions", "Add role");
    await waitForRoute(`/roles/new?gameId=${game.id}`);
    await setEditorName(name);
    await $("#role-launch-url").setValue(fixtureUrl(fixture, marker));
    await submitEditor("/roles");
    roles.push(await findEntity(name, () => rendererCall("listRoles")));
  }
  return [game, roles[0]!, roles[1]!];
}

async function createWorkspace(role: Role): Promise<LaunchWorkspace> {
  await openSection("Workspaces", "/workspaces");
  await clickWorkspaceCreateAction();
  await waitForRoute("/workspaces/new");
  await setEditorName(WORKSPACE_NAME);
  await $("#workspace-slot-content").click();
  await $("[role='option']=Web app").click();
  await setInputValue("#workspace-web-name", WEB_NAME);
  await setInputValue("#workspace-web-url", fixtureUrl(WEB_FIXTURE, MARKERS.web));
  await $("[data-workspace-slot-index='1']").click();
  await $("#workspace-slot-content").click();
  await $("[role='option']=Role").click();
  await $(`[data-workspace-role-id='${role.id}']`).click();
  await submitEditor("/workspaces");
  return findEntity(WORKSPACE_NAME, () => rendererCall("listLaunchWorkspaces"));
}

async function createWindow(): Promise<GameWindow> {
  await openSection("Windows", "/game-windows");
  const prior = new Set((await rendererCall("listGameWindows")).map(({ id }) => id));
  await $("button=New game window").click();
  let created: GameWindow | undefined;
  await browser.waitUntil(async () => {
    created = (await rendererCall("listGameWindows")).find(({ id }) => !prior.has(id));
    return created !== undefined;
  }, { timeout: 15_000, timeoutMsg: "Visible Game Window creation did not commit" });
  await menuAction(created!.id, "Game window actions", "Rename");
  await $("#rename-game-window-name").setValue(WINDOW_NAME);
  await (await $("dialog[open]")).$("button=Save").click();
  return findEntity(WINDOW_NAME, () => rendererCall("listGameWindows"));
}

async function quickAccessLaunch(
  source: Role | LaunchWorkspace,
  kind: "role" | "workspace",
  windowId: string
): Promise<void> {
  await openSection("Home", "/dashboard");
  await $("[data-testid='quick-access-trigger']").click();
  const palette = await $("[data-testid='quick-access-palette'][open]");
  await palette.$("input[role='combobox']").setValue(source.name);
  await $(`#quick-access-option-${kind}-${source.id}`).waitForDisplayed({ timeout: 10_000 });
  const destinations = await $(`[data-testid='quick-access-destination-${kind}-${source.id}']`);
  await destinations.waitForClickable({ timeout: 10_000 });
  await destinations.click();
  const destination = await $(
    `[data-testid='quick-access-destination-option-window-${windowId}']`
  );
  await destination.waitForClickable({ timeout: 10_000 });
  await destination.click();
}

async function waitSession(
  afterSequence: number,
  roleId: string,
  marker: string,
  stored: boolean
): Promise<void> {
  const event = await waitFixtureEvent({ afterSequence, kind: "session", roleId });
  expect(event.session).toEqual({
    after: { cookie: marker, localStorage: marker },
    before: stored
      ? { cookie: marker, localStorage: marker }
      : { cookie: null, localStorage: null },
    marker,
    mode: "seed"
  });
}

async function activateTab(input: Readonly<{
  mainWindowHandle: string;
  name: string;
  platform: "macos" | "windows";
  tabId: string;
  windowId: string;
}>): Promise<void> {
  await clickVisibleRuntimeTab({
    mainWindowHandle: input.mainWindowHandle,
    platform: input.platform,
    tabId: input.tabId,
    tabName: input.name
  });
  await browser.waitUntil(async () => (await rendererCall("getEmbeddedRuntimeState"))
    .windows.find(({ id }) => id === input.windowId)?.activeTabId === input.tabId, {
    timeout: 30_000,
    timeoutMsg: `Visible native tab ${input.tabId} did not activate`
  });
}

async function exactNative(lifecycle: MixedRecoveryLifecycle) {
  const [roleTab, roleWorkspace, web, gameWindow] = await Promise.all([
    electronDesktopE2eRoleSessionRuntime(lifecycle.roleTab.roleId),
    electronDesktopE2eRoleSessionRuntime(lifecycle.roleWorkspace.roleId),
    electronDesktopE2eWorkspaceWebRuntime(lifecycle.windowId),
    electronDesktopE2eGameWindowRuntime(lifecycle.windowId)
  ]);
  return { gameWindow, roleTab, roleWorkspace, web };
}

async function writeRuntime(lifecycle: MixedRecoveryLifecycle): Promise<void> {
  await writeFile(
    resolve(required("RION_STUDIO_E2E_ARTIFACT_DIR"), "chromium-mixed-recovery-runtime.json"),
    `${JSON.stringify({ lifecycle, native: await exactNative(lifecycle) }, null, 2)}\n`
  );
}

async function readLifecycle(platform: "macos" | "windows"): Promise<MixedRecoveryLifecycle> {
  const lifecycle = JSON.parse(await readFile(lifecyclePath(), "utf8")) as MixedRecoveryLifecycle;
  expect(lifecycle).toEqual(expect.objectContaining({ contractVersion: 1, platform }));
  return lifecycle;
}

async function waitExactRuntime(lifecycle: MixedRecoveryLifecycle): Promise<void> {
  await browser.waitUntil(async () => {
    const runtime = await rendererCall("getEmbeddedRuntimeState");
    return runtime.windows.length === 1
      && runtime.windows[0]?.id === lifecycle.windowId
      && runtime.tabs.map(({ id }) => id).sort().join("|") ===
        [lifecycle.roleTab.tabId, lifecycle.workspace.tabId].sort().join("|");
  }, { timeout: 45_000, timeoutMsg: "Exact mixed native topology did not become live" });
}

async function showWindow(windowId: string): Promise<void> {
  await openSection("Windows", "/game-windows");
  const show = await $(`[data-selection-id='${windowId}'] button[aria-label='Show']`);
  await show.waitForClickable({ timeout: 10_000 });
  await show.click();
}

async function seedPhase(platform: "macos" | "windows"): Promise<void> {
  const [, roleTab, roleWorkspace] = await createGameAndRoles();
  const workspace = await createWorkspace(roleWorkspace);
  const gameWindow = await createWindow();
  let cursor = await fixtureCursor();
  await quickAccessLaunch(roleTab, "role", gameWindow.id);
  await waitSession(cursor, ROLE_TAB_FIXTURE, MARKERS.roleTab, false);
  cursor = await fixtureCursor();
  await quickAccessLaunch(workspace, "workspace", gameWindow.id);
  await Promise.all([
    waitSession(cursor, ROLE_WORKSPACE_FIXTURE, MARKERS.roleWorkspace, false),
    waitSession(cursor, WEB_FIXTURE, MARKERS.web, false)
  ]);
  const runtime = await rendererCall("getEmbeddedRuntimeState");
  const roleTabState = runtime.tabs.find(({ sourceId }) => sourceId === roleTab.id)!;
  const workspaceTab = runtime.tabs.find(({ sourceId }) => sourceId === workspace.id)!;
  const [roleTabNative, roleWorkspaceNative, web] = await Promise.all([
    electronDesktopE2eRoleSessionRuntime(roleTab.id),
    electronDesktopE2eRoleSessionRuntime(roleWorkspace.id),
    electronDesktopE2eWorkspaceWebRuntime(gameWindow.id)
  ]);
  const lifecycle: MixedRecoveryLifecycle = {
    contractVersion: 1,
    platform,
    roleTab: {
      chromiumPathSha256: roleTabNative.latestSessionEnsure.chromiumPathSha256,
      roleId: roleTab.id,
      tabId: roleTabState.id
    },
    roleWorkspace: {
      chromiumPathSha256: roleWorkspaceNative.latestSessionEnsure.chromiumPathSha256,
      roleId: roleWorkspace.id
    },
    web: { marker: MARKERS.web, slotId: web.web.slotId },
    windowId: gameWindow.id,
    workspace: { id: workspace.id, tabId: workspaceTab.id }
  };
  await writeFile(lifecyclePath(), `${JSON.stringify(lifecycle, null, 2)}\n`);
  await writeRuntime(lifecycle);
}

async function forcePhase(input: Readonly<{
  mainWindowHandle: string;
  platform: "macos" | "windows";
  processId: number;
}>): Promise<void> {
  const lifecycle = await readLifecycle(input.platform);
  expect((await rendererCall("getEmbeddedRuntimeState")).windows).toEqual([]);
  const cursor = await fixtureCursor();
  await showWindow(lifecycle.windowId);
  await waitExactRuntime(lifecycle);
  await Promise.all([
    waitSession(cursor, ROLE_WORKSPACE_FIXTURE, MARKERS.roleWorkspace, true),
    waitSession(cursor, WEB_FIXTURE, MARKERS.web, true)
  ]);
  const roleCursor = await fixtureCursor();
  await activateTab({
    mainWindowHandle: input.mainWindowHandle,
    name: ROLE_TAB_NAME,
    platform: input.platform,
    tabId: lifecycle.roleTab.tabId,
    windowId: lifecycle.windowId
  });
  await waitSession(roleCursor, ROLE_TAB_FIXTURE, MARKERS.roleTab, true);
  await activateTab({
    mainWindowHandle: input.mainWindowHandle,
    name: WORKSPACE_NAME,
    platform: input.platform,
    tabId: lifecycle.workspace.tabId,
    windowId: lifecycle.windowId
  });
  await writeRuntime(lifecycle);
  await writeFile(resolve(required("RION_STUDIO_E2E_ARTIFACT_DIR"), "forced-termination.json"),
    `${JSON.stringify({ pid: input.processId, requestedAt: new Date().toISOString() }, null, 2)}\n`);
  await forceTerminateProcessTree(input.processId);
}

async function restorePhase(input: Readonly<{
  mainWindowHandle: string;
  platform: "macos" | "windows";
}>): Promise<void> {
  const lifecycle = await readLifecycle(input.platform);
  await navigate("/dashboard");
  const awaiting = await rendererCall("getEmbeddedRuntimeState");
  expect(awaiting.recovery).toEqual(expect.objectContaining({
    interruptedWindowIds: [lifecycle.windowId],
    tabCount: 2,
    windowCount: 1
  }));
  expect(awaiting.savedWindows?.find(({ id }) => id === lifecycle.windowId)?.state)
    .toBe("awaiting-recovery");
  const cursor = await fixtureCursor();
  const restore = await $("button=Restore session");
  await restore.waitForClickable({ timeout: 10_000 });
  await restore.click();
  await waitExactRuntime(lifecycle);
  await Promise.all([
    waitSession(cursor, ROLE_WORKSPACE_FIXTURE, MARKERS.roleWorkspace, true),
    waitSession(cursor, WEB_FIXTURE, MARKERS.web, true)
  ]);
  const roleCursor = await fixtureCursor();
  await activateTab({
    mainWindowHandle: input.mainWindowHandle,
    name: ROLE_TAB_NAME,
    platform: input.platform,
    tabId: lifecycle.roleTab.tabId,
    windowId: lifecycle.windowId
  });
  await waitSession(roleCursor, ROLE_TAB_FIXTURE, MARKERS.roleTab, true);
  await activateTab({
    mainWindowHandle: input.mainWindowHandle,
    name: WORKSPACE_NAME,
    platform: input.platform,
    tabId: lifecycle.workspace.tabId,
    windowId: lifecycle.windowId
  });
  await browser.waitUntil(async () => (await rendererCall("getEmbeddedRuntimeState"))
    .recovery === undefined, { timeout: 45_000, timeoutMsg: "Mixed recovery did not terminalize" });
  await writeRuntime(lifecycle);
}

describe("mixed Chromium runtime recovery", () => {
  it("restores exact Role and Workspace-Web tabs through retained native chrome", async () => {
    const phase = required("RION_STUDIO_E2E_PHASE");
    const probe = await electronDesktopE2eProbe();
    expect(probe.runtimeTarget).toBe(required("RION_STUDIO_E2E_RUNTIME_TARGET"));
    await ensureEnglishUi();
    await acceptLegalAndSkipFirstRun();
    const mainWindowHandle = await browser.getWindowHandle();
    if (phase === "chromium-mixed-recovery-seed") await seedPhase(probe.platform);
    else if (phase === "chromium-mixed-recovery-force") {
      await forcePhase({ mainWindowHandle, platform: probe.platform, processId: probe.processId });
    } else if (phase === "chromium-mixed-recovery-restore") {
      await restorePhase({ mainWindowHandle, platform: probe.platform });
    } else throw new Error(`Unexpected mixed recovery phase ${phase}`);
  });
});
