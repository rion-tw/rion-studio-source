import { $, browser, expect } from "@wdio/globals";

import type { Game, GameWindow, LaunchWorkspace, Macro, Role, RoleStatus } from "../../../src/shared/types";
import {
  detachTerminatedApplicationSession,
  probe,
  rendererCall,
  requireEnvironment,
  shutdown,
  waitEvent,
  windowSnapshot
} from "../support/control";
import { waitForTranscriptEvent } from "../support/transcript";
import {
  acceptLegalAndSkipFirstRun,
  clickConfirmation,
  clickEntityMenuAction,
  ensureEnglishUi,
  navigate,
  setEditorName,
  submitEditor,
  waitForRoute
} from "../support/ui";

// [journey:APP-LEGAL-001]
// [journey:DASHBOARD-NAV-001]
// [journey:GAMES-UI-001]
// [journey:ROLES-UI-001]
// [journey:WORKSPACES-UI-001]
// [journey:GAME-WINDOWS-UI-001]
// [journey:MACROS-UI-001]
// [journey:SETTINGS-PERSIST-001]

const GAME_NAME = "E2E Smoke Game";
const GAME_NAME_EDITED = "E2E Smoke Game Edited";
const DELETE_GAME_NAME = "E2E Delete Game";
const ROLE_NAME = "E2E Smoke Role";
const WORKSPACE_NAME = "E2E Smoke Workspace";
const MACRO_NAME = "E2E Smoke Macro";
const GAME_WINDOW_NAME = "E2E Smoke Game Window";
const ROLE_FIXTURE_ID = "e2e-smoke-role";

async function fixtureRequest(path: string, body: unknown): Promise<void> {
  const response = await fetch(`${requireEnvironment("RION_STUDIO_E2E_FIXTURE_ORIGIN")}${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
  if (!response.ok) throw new Error(`Fixture ${path} failed with ${response.status}`);
}

async function waitForFixtureNavigation(roleId: string): Promise<void> {
  const response = await fetch(
    `${requireEnvironment("RION_STUDIO_E2E_FIXTURE_ORIGIN")}/api/gates/${roleId}/waiting`,
    { signal: AbortSignal.timeout(45_000) }
  );
  if (!response.ok) throw new Error(`Fixture gate wait failed with ${response.status}`);
}

async function waitForRoleStatus(roleId: string, predicate: (status: RoleStatus | undefined) => boolean): Promise<RoleStatus | undefined> {
  let matching: RoleStatus | undefined;
  await browser.waitUntil(async () => {
    matching = (await rendererCall("listRoleStatuses")).find((status) => status.roleId === roleId);
    return predicate(matching);
  }, { interval: 100, timeout: 45_000, timeoutMsg: `Role ${roleId} did not reach the expected status` });
  return matching;
}

async function waitForSelectedRuntimeTabReady(windowId: string): Promise<void> {
  const cursor = (await probe()).latestSequence;
  let snapshot = await windowSnapshot(windowId);
  const selectedTabId = snapshot.kernel?.selectedTabId;
  if (!selectedTabId) throw new Error("Restored Game Window has no selected runtime tab");
  if (snapshot.kernel?.tabs.find((tab) => tab.tabId === selectedTabId)?.launchPhase === "ready") {
    return;
  }
  await waitEvent({
    afterSequence: cursor,
    kind: `tab-launch-phase:${selectedTabId}:ready`,
    timeoutMs: 55_000,
    windowId
  });
  snapshot = await windowSnapshot(windowId);
  expect(snapshot.kernel?.tabs.find((tab) => tab.tabId === selectedTabId)?.launchPhase)
    .toBe("ready");
}

async function shutdownAndWaitForFlush(): Promise<void> {
  const control = await probe();
  const requestedAfter = new Date().toISOString();
  await shutdown().catch(() => undefined);
  const event = await waitForTranscriptEvent(
    control.transcriptPath,
    (candidate) => candidate.kind === "application-final-flush-complete" && candidate.timestamp >= requestedAfter
  );
  expect((event.details as { complete?: boolean }).complete).toBe(true);
  detachTerminatedApplicationSession();
}

async function findGame(name: string): Promise<Game> {
  let game: Game | undefined;
  await browser.waitUntil(async () => {
    game = (await rendererCall("listGames")).find((candidate) => candidate.name === name);
    return Boolean(game);
  }, { timeout: 15_000, timeoutMsg: `Game ${name} was not persisted` });
  return game as Game;
}

async function findRole(name: string): Promise<Role> {
  let role: Role | undefined;
  await browser.waitUntil(async () => {
    role = (await rendererCall("listRoles")).find((candidate) => candidate.name === name);
    return Boolean(role);
  }, { timeout: 15_000, timeoutMsg: `Role ${name} was not persisted` });
  return role as Role;
}

async function findWorkspace(name: string): Promise<LaunchWorkspace> {
  let workspace: LaunchWorkspace | undefined;
  await browser.waitUntil(async () => {
    workspace = (await rendererCall("listLaunchWorkspaces")).find((candidate) => candidate.name === name);
    return Boolean(workspace);
  }, { timeout: 15_000, timeoutMsg: `Workspace ${name} was not persisted` });
  return workspace as LaunchWorkspace;
}

async function findMacro(name: string): Promise<Macro> {
  let macro: Macro | undefined;
  await browser.waitUntil(async () => {
    macro = (await rendererCall("listMacros")).find((candidate) => candidate.name === name);
    return Boolean(macro);
  }, { timeout: 15_000, timeoutMsg: `Macro ${name} was not persisted` });
  return macro as Macro;
}

async function exercisePrimaryNavigation(): Promise<void> {
  const sidebar = await $(".app-main-sidebar");
  const targets = [
    ["Games", "/games"],
    ["Roles", "/roles"],
    ["Workspaces", "/workspaces"],
    ["Windows", "/game-windows"],
    ["Macros", "/macros"],
    ["Home", "/dashboard"]
  ] as const;
  for (const [label, path] of targets) {
    await sidebar.$(`button*=${label}`).click();
    await waitForRoute(path);
  }
  await sidebar.$("button*=Settings").click();
  await waitForRoute("/settings");
  await $("button=Back to app").click();
  await waitForRoute("/dashboard");
}

async function createAndEditGames(): Promise<Game> {
  const sidebar = await $(".app-main-sidebar");
  await sidebar.$("button*=Games").click();
  await waitForRoute("/games");
  await $("button=New game").click();
  await waitForRoute("/games/new");
  await setEditorName(GAME_NAME);
  const launchUrl = await $("#game-launch-url");
  await launchUrl.setValue("not-a-valid-url");
  await expect($("#app-editor-form button[type='submit']")).toBeDisabled();
  await launchUrl.setValue(`${requireEnvironment("RION_STUDIO_E2E_FIXTURE_ORIGIN")}/role/${ROLE_FIXTURE_ID}`);
  await submitEditor("/games");
  const game = await findGame(GAME_NAME);

  await clickEntityMenuAction(game.id, "Game actions", "Edit");
  await waitForRoute(`/games/${game.id}/edit`);
  await setEditorName(GAME_NAME_EDITED);
  await submitEditor("/games");
  const edited = await findGame(GAME_NAME_EDITED);

  await $("button=New game").click();
  await waitForRoute("/games/new");
  await setEditorName(DELETE_GAME_NAME);
  await $("#game-launch-url").setValue(`${requireEnvironment("RION_STUDIO_E2E_FIXTURE_ORIGIN")}/delete-target`);
  await submitEditor("/games");
  const deleteTarget = await findGame(DELETE_GAME_NAME);
  await clickEntityMenuAction(deleteTarget.id, "Game actions", "Delete");
  await clickConfirmation("Cancel");
  expect((await rendererCall("listGames")).some((candidate) => candidate.id === deleteTarget.id)).toBe(true);
  await clickEntityMenuAction(deleteTarget.id, "Game actions", "Delete");
  await clickConfirmation("Delete");
  await browser.waitUntil(
    async () => !(await rendererCall("listGames")).some((candidate) => candidate.id === deleteTarget.id),
    { timeout: 15_000, timeoutMsg: "Delete target game remained after UI confirmation" }
  );
  return edited;
}

async function createRole(game: Game): Promise<Role> {
  await clickEntityMenuAction(game.id, "Game actions", "Add role");
  await waitForRoute(`/roles/new?gameId=${game.id}`);
  await setEditorName(ROLE_NAME);
  await submitEditor("/roles");
  return findRole(ROLE_NAME);
}

async function createWorkspace(role: Role): Promise<LaunchWorkspace> {
  const sidebar = await $(".app-main-sidebar");
  await sidebar.$("button*=Workspaces").click();
  await waitForRoute("/workspaces");
  await $("button=Create workspace").click();
  await waitForRoute("/workspaces/new");
  await setEditorName(WORKSPACE_NAME);
  await $(`[data-workspace-role-id='${role.id}']`).click();
  await submitEditor("/workspaces");
  return findWorkspace(WORKSPACE_NAME);
}

async function createMacro(role: Role): Promise<Macro> {
  const sidebar = await $(".app-main-sidebar");
  await sidebar.$("button*=Macros").click();
  await waitForRoute("/macros");
  await navigate(`/macros/new?roleId=${role.id}`);
  await setEditorName(MACRO_NAME);
  await $("button=Hold until stopped").click();
  await submitEditor("/macros");
  const macro = await findMacro(MACRO_NAME);
  await $("[data-macro-list-view='grouped']").waitForExist({ timeout: 10_000 });
  expect(await $("[data-macro-list-view='grouped'] table thead").isExisting()).toBe(true);
  const roleGroup = await $(`[data-macro-group]:has([data-selection-id='${macro.id}'])`);
  expect(await roleGroup.getTagName()).toBe("tbody");
  expect(await roleGroup.$("tr:first-child > td").getAttribute("colspan")).toBe("5");
  await expect(roleGroup).toHaveText(expect.stringContaining(role.name));
  expect(await roleGroup.$("button=Select 1").isExisting()).toBe(true);
  expect(await roleGroup.getText()).not.toContain("1 macros");
  const listSurfaceAppearance = await browser.execute(() => {
    const macroSurface = document.querySelector(".macro-list-surface");
    if (!macroSurface) {
      return null;
    }
    const windowSurfaceReference = document.createElement("div");
    windowSurfaceReference.className = "game-window-list-surface glass-panel";
    document.body.append(windowSurfaceReference);
    const readAppearance = (element: Element) => {
      const style = getComputedStyle(element);
      return {
        background: style.background,
        borderColor: style.borderColor,
        boxShadow: style.boxShadow
      };
    };
    const appearance = {
      macro: readAppearance(macroSurface),
      window: readAppearance(windowSurfaceReference)
    };
    windowSurfaceReference.remove();
    return appearance;
  });
  expect(listSurfaceAppearance?.macro).toEqual(listSurfaceAppearance?.window);
  const groupedRowSpacing = await browser.execute((macroId) => {
    const row = document.querySelector(`[data-selection-id="${CSS.escape(macroId)}"]`);
    const cells = row?.querySelectorAll("td");
    const heading = row?.closest("[data-macro-group]")?.querySelector(".macro-list-group-heading");
    if (!cells || cells.length === 0 || !heading) {
      return null;
    }
    const headingStyle = getComputedStyle(heading);
    return {
      headingBorderBottom: Number.parseFloat(headingStyle.borderBottomWidth),
      headingSeparator: headingStyle.backgroundImage,
      left: Number.parseFloat(getComputedStyle(cells[0]).paddingLeft),
      right: Number.parseFloat(getComputedStyle(cells[cells.length - 1]).paddingRight)
    };
  }, macro.id);
  expect(groupedRowSpacing?.headingBorderBottom).toBe(0);
  expect(groupedRowSpacing?.headingSeparator).not.toBe("none");
  expect(groupedRowSpacing?.left).toBeGreaterThanOrEqual(16);
  expect(groupedRowSpacing?.right).toBeGreaterThanOrEqual(16);
  await roleGroup.$("button[aria-label='New macro']").click();
  await $("h1=New Macro").waitForExist({ timeout: 10_000 });
  expect(await browser.execute(() => {
    const route = window.location.hash.slice(1);
    return new URL(route, "https://rion.invalid").searchParams.getAll("roleId");
  }))
    .toEqual([role.id]);
  await navigate("/macros");
  await $("thead th[aria-sort='ascending'] button[title='Sort by Name']").click();
  await $("thead th[aria-sort='descending'] button[title='Sort by Name']").waitForExist({ timeout: 10_000 });
  await $("thead th[aria-sort='descending'] button[title='Sort by Name']").click();
  await $("thead th[aria-sort='ascending'] button[title='Sort by Name']").waitForExist({ timeout: 10_000 });
  await $("button[role='combobox'][aria-label='Macro view']").click();
  await $('//*[@role="option" and normalize-space(.)="Flat"]').click();
  await $("[data-macro-list-view='flat']").waitForExist({ timeout: 10_000 });
  expect(await $("[data-macro-list-view='flat'] table tbody").isExisting()).toBe(true);
  await $("button[role='combobox'][aria-label='Macro view']").click();
  await $('//*[@role="option" and normalize-space(.)="Grouped"]').click();
  await $("[data-macro-list-view='grouped']").waitForExist({ timeout: 10_000 });
  const runButton = await $(`[data-selection-id='${macro.id}'] button[aria-label='Start']`);
  await expect(runButton).toBeDisabled();
  return macro;
}

async function createAndShowGameWindow(): Promise<GameWindow> {
  await navigate("/game-windows");
  const before = await rendererCall("listGameWindows");
  await $("button=New game window").click();
  let created: GameWindow | undefined;
  await browser.waitUntil(async () => {
    const windows = await rendererCall("listGameWindows");
    created = windows.find((candidate) => !before.some((existing) => existing.id === candidate.id));
    return Boolean(created);
  }, { timeout: 15_000, timeoutMsg: "Game Window UI did not create a permanent window" });
  const gameWindow = created as GameWindow;
  await clickEntityMenuAction(gameWindow.id, "Game window actions", "Rename");
  const nameInput = await $("#rename-game-window-name");
  await nameInput.clearValue();
  await nameInput.setValue(GAME_WINDOW_NAME);
  const renameDialog = await $("dialog[open]");
  await renameDialog.$("button=Save").click();
  await browser.waitUntil(
    async () => (await rendererCall("listGameWindows"))
      .some((candidate) => candidate.id === gameWindow.id && candidate.name === GAME_WINDOW_NAME),
    { timeout: 15_000, timeoutMsg: "Game Window name was not persisted" }
  );
  const cursor = (await probe()).latestSequence;
  await $(`[data-selection-id='${gameWindow.id}'] button[aria-label='Show']`).click();
  await waitEvent({ afterSequence: cursor, kind: "window-context-initialized", windowId: gameWindow.id });
  return gameWindow;
}

async function updateSettings(): Promise<void> {
  await navigate("/settings?section=preferences");
  const light = await $("button=Light");
  await light.click();
  await browser.waitUntil(
    async () => browser.execute(() => document.documentElement.dataset.theme === "light"),
    { timeout: 10_000, timeoutMsg: "Light theme did not apply" }
  );
  const hideCloseButtons = await $("button[role='switch'][aria-label='Always hide tab close buttons']");
  if ((await hideCloseButtons.getAttribute("data-state")) !== "checked") await hideCloseButtons.click();
  const restore = await $("button[role='switch'][aria-label='Restore Game Windows on startup']");
  if (await restore.isExisting() && (await restore.getAttribute("data-state")) !== "checked") await restore.click();
  await navigate("/settings?section=interface");
  for (const label of [
    "Show macro tools button",
    "Show running macro badges",
    "Show macro click markers"
  ]) {
    const control = await $(`button[role='switch'][aria-label='${label}']`);
    if ((await control.getAttribute("data-state")) === "checked") await control.click();
  }
  await browser.waitUntil(async () => (await rendererCall("getRuntimeWindowPreferences")).alwaysHideTabCloseButton, {
    timeout: 10_000,
    timeoutMsg: "Runtime Window preferences did not persist"
  });
  await browser.waitUntil(async () => {
    const settings = await rendererCall("getGameBrowserSettings");
    const overlay = settings.macroOverlay;
    return !overlay.showToolButton
      && !overlay.showRunningBadges
      && !overlay.showClickMarkers;
  }, {
    timeout: 10_000,
    timeoutMsg: "In-game macro interface preferences did not persist"
  });
}

async function launchRoleAndRunMacro(role: Role, macro: Macro): Promise<void> {
  await fixtureRequest("/api/gate", { roleId: ROLE_FIXTURE_ID });
  await navigate("/roles");
  await $(`[data-selection-id='${role.id}'] button[aria-label='Open']`).click();
  await waitForFixtureNavigation(ROLE_FIXTURE_ID);
  await fixtureRequest("/api/release", { roleId: ROLE_FIXTURE_ID });
  await waitForRoleStatus(
    role.id,
    (status) => status?.state === "running" && status.automationState !== "unavailable"
  );

  await navigate("/macros");
  const start = await $(`[data-selection-id='${macro.id}'] button[aria-label='Start']`);
  await start.waitForEnabled({ timeout: 15_000 });
  await start.click();
  await browser.waitUntil(
    async () => (await rendererCall("listMacroStatuses")).some((status) => status.macroId === macro.id && status.state === "running"),
    { timeout: 15_000, timeoutMsg: "Macro did not start from its UI action" }
  );
  const stop = await $(`[data-selection-id='${macro.id}'] button[aria-label='Stop']`);
  await stop.waitForEnabled({ timeout: 15_000 });
  await stop.click();
  await browser.waitUntil(
    async () => !(await rendererCall("listMacroStatuses")).some((status) => status.macroId === macro.id && ["running", "stopping"].includes(status.state)),
    { timeout: 15_000, timeoutMsg: "Macro did not stop from its UI action" }
  );
}

async function launchWorkspace(workspace: LaunchWorkspace, role: Role): Promise<void> {
  await rendererCall("stopRole", role.id);
  await waitForRoleStatus(role.id, (status) => status === undefined);
  await fixtureRequest("/api/gate", { roleId: ROLE_FIXTURE_ID });
  await navigate("/workspaces");
  await $(`[data-selection-id='${workspace.id}'] button[aria-label='Open workspace']`).click();
  await waitForFixtureNavigation(ROLE_FIXTURE_ID);
  await fixtureRequest("/api/release", { roleId: ROLE_FIXTURE_ID });
  await waitForRoleStatus(role.id, (status) => status?.state === "running");
  await rendererCall("stopRole", role.id);
  await waitForRoleStatus(role.id, (status) => status === undefined);
}

async function seedPhase(): Promise<void> {
  await ensureEnglishUi();
  await acceptLegalAndSkipFirstRun();
  await exercisePrimaryNavigation();
  const game = await createAndEditGames();
  const role = await createRole(game);
  const workspace = await createWorkspace(role);
  const macro = await createMacro(role);
  await createAndShowGameWindow();
  await updateSettings();
  await launchRoleAndRunMacro(role, macro);
  await launchWorkspace(workspace, role);
  await shutdownAndWaitForFlush();
}

async function restartPhase(): Promise<void> {
  await ensureEnglishUi();
  await acceptLegalAndSkipFirstRun();
  const game = await findGame(GAME_NAME_EDITED);
  const role = await findRole(ROLE_NAME);
  const workspace = await findWorkspace(WORKSPACE_NAME);
  const macro = await findMacro(MACRO_NAME);
  expect(game.defaultLaunchUrl).toContain(ROLE_FIXTURE_ID);
  expect(workspace.slots.some((slot) => slot.roleId === role.id)).toBe(true);
  expect(macro.roleIds).toContain(role.id);
  expect(await browser.execute(() => document.documentElement.dataset.theme)).toBe("light");
  expect((await rendererCall("getRuntimeWindowPreferences")).alwaysHideTabCloseButton).toBe(true);
  expect((await rendererCall("getGameBrowserSettings")).macroOverlay).toEqual({
    showClickMarkers: false,
    showRunningBadges: false,
    showToolButton: false
  });
  await navigate("/settings?section=interface");
  expect(await $("button[role='switch'][aria-label='Maximum WebGL performance']").isExisting())
    .toBe(false);
  for (const label of [
    "Show macro tools button",
    "Show running macro badges",
    "Show macro click markers"
  ]) {
    expect(await $(`button[role='switch'][aria-label='${label}']`).getAttribute("data-state"))
      .toBe("unchecked");
  }

  await navigate("/games");
  await $(`[data-selection-id='${game.id}']`).waitForExist({ timeout: 10_000 });
  await navigate("/roles");
  await $(`[data-selection-id='${role.id}']`).waitForExist({ timeout: 10_000 });
  await navigate("/workspaces");
  await $(`[data-selection-id='${workspace.id}']`).waitForExist({ timeout: 10_000 });
  await navigate("/macros");
  await $(`[data-selection-id='${macro.id}']`).waitForExist({ timeout: 10_000 });

  const smokeWindow = (await rendererCall("listGameWindows")).find((candidate) =>
    !candidate.id.startsWith("e2e00000-")
  );
  if (!smokeWindow) throw new Error("Persisted smoke Game Window was not found after restart");
  await navigate("/game-windows");
  const isAlreadyRestored = await windowSnapshot(smokeWindow.id).then(
    () => true,
    () => false
  );
  if (!isAlreadyRestored) {
    const showCursor = (await probe()).latestSequence;
    await $(`[data-selection-id='${smokeWindow.id}'] button[aria-label='Show']`).click();
    await waitEvent({
      afterSequence: showCursor,
      kind: "window-context-initialized",
      windowId: smokeWindow.id
    });
  }
  await waitForSelectedRuntimeTabReady(smokeWindow.id);
  const cursor = (await probe()).latestSequence;
  await clickEntityMenuAction(smokeWindow.id, "Game window actions", "Delete window");
  await clickConfirmation("Delete");
  await waitEvent({ afterSequence: cursor, kind: "window-destroyed", windowId: smokeWindow.id });
  await browser.waitUntil(
    async () => !(await rendererCall("listGameWindows")).some((candidate) => candidate.id === smokeWindow.id),
    { timeout: 15_000, timeoutMsg: "Smoke Game Window remained after UI deletion" }
  );
  await shutdownAndWaitForFlush();
}

describe("application UI smoke journeys", () => {
  it(`runs ${requireEnvironment("RION_STUDIO_E2E_PHASE")} through visible user actions`, async () => {
    const phase = requireEnvironment("RION_STUDIO_E2E_PHASE");
    if (phase === "smoke-seed") await seedPhase();
    else if (phase === "smoke-restart") await restartPhase();
    else throw new Error(`Unknown application journey phase: ${phase}`);
  });
});
