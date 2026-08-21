import { $, browser, expect } from "@wdio/globals";
import { Key } from "webdriverio";

import type { Game, GameWindow, LaunchWorkspace, Macro, Role, RoleStatus } from "../../../src/shared/types";
import {
  detachTerminatedApplicationSession,
  keyboardInput,
  keyboardInputSequence,
  probe,
  rendererCall,
  requireEnvironment,
  runtimeUiAction,
  shutdown,
  waitEvent,
  windowSnapshot
} from "../support/control";
import { waitForTranscriptEvent } from "../support/transcript";
import { fixtureCursor, fixtureEvents, waitFixtureEvent } from "../support/fixture";
import { exerciseFullscreenToolbarPreference } from "../support/fullscreen-toolbar";
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
// [journey:WORKSPACE-WEB-SLOT-004]
// [journey:WORKSPACE-WEB-FULLSCREEN-005]
// [journey:GAME-WINDOWS-UI-001]
// [journey:GAME-WINDOWS-FULLSCREEN-TOOLBAR-012]
// [journey:MACROS-UI-001]
// [journey:SETTINGS-PERSIST-001]
// [journey:QUICK-ACCESS-UI-001]

const GAME_NAME = "E2E Smoke Game";
const GAME_NAME_EDITED = "E2E Smoke Game Edited";
const DELETE_GAME_NAME = "E2E Delete Game";
const ROLE_NAME = "E2E Smoke Role";
const WORKSPACE_NAME = "E2E Smoke Workspace";
const MACRO_NAME = "E2E Smoke Macro";
const GAME_WINDOW_NAME = "E2E Smoke Game Window";
const ROLE_FIXTURE_ID = "e2e-smoke-role";
const WEB_FIXTURE_ID = "e2e-workspace-web";
const WEB_POPUP_FIXTURE_ID = "e2e-workspace-popup";
const WEB_SESSION_MARKER = "e2e-global-web-session";
const FULLSCREEN_WORKSPACE_NAME = "E2E Contained Fullscreen Workspace";
const FULLSCREEN_GAME_NAME = "E2E Contained Fullscreen Game";
const FULLSCREEN_ROLE_NAME = "E2E Contained Fullscreen Role";

interface MacroMindMapFocusFrame {
  activeNodeIds: string[];
  focusedEdgeFilters: string[];
  focusedEdgeIds: string[];
  nodeFilters: string[];
}

function expectWithinCssPixel(actual: number | undefined, expected: number | undefined): void {
  expect(actual).toBeDefined();
  expect(expected).toBeDefined();
  expect(Math.abs((actual ?? Number.NaN) - (expected ?? Number.NaN))).toBeLessThanOrEqual(1);
}

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
  await $("#workspace-slot-content").click();
  const webOption = await $("[role='option']=Web app");
  await webOption.waitForExist({ timeout: 10_000 });
  await webOption.click();
  const webPresetSelect = await $("[data-workspace-web-preset-select]");
  await webPresetSelect.click();
  const youtubePreset = await $("[role='option'][data-workspace-web-preset='youtube']");
  await youtubePreset.waitForDisplayed({ timeout: 10_000 });
  await youtubePreset.click();
  await browser.waitUntil(async () =>
    await $("#workspace-web-name").getValue() === "YouTube" &&
    await $("#workspace-web-url").getValue() === "https://www.youtube.com/" &&
    await webPresetSelect.getText() === "YouTube"
  );
  await $("#workspace-web-name").setValue("E2E Web App");
  await $("#workspace-web-url").setValue(
    `${requireEnvironment("RION_STUDIO_E2E_FIXTURE_ORIGIN")}/role/${WEB_FIXTURE_ID}?mode=seed&marker=${WEB_SESSION_MARKER}`
  );
  await $("[data-workspace-slot-index='1']").click();
  await $("#workspace-slot-content").click();
  const roleOption = await $("[role='option']=Role");
  await roleOption.waitForExist({ timeout: 10_000 });
  await roleOption.click();
  await $(`[data-workspace-role-id='${role.id}']`).click();
  await submitEditor("/workspaces");
  return findWorkspace(WORKSPACE_NAME);
}

async function createContainedFullscreenRole(): Promise<Role> {
  await navigate("/games/new");
  await setEditorName(FULLSCREEN_GAME_NAME);
  await $("#game-launch-url").setValue(
    `${requireEnvironment("RION_STUDIO_E2E_FIXTURE_ORIGIN")}/role/e2e-fullscreen-sibling-role`
  );
  await submitEditor("/games");
  const game = await findGame(FULLSCREEN_GAME_NAME);
  await navigate(`/roles/new?gameId=${game.id}`);
  await setEditorName(FULLSCREEN_ROLE_NAME);
  await submitEditor("/roles");
  return findRole(FULLSCREEN_ROLE_NAME);
}

async function createContainedFullscreenWorkspace(role: Role): Promise<LaunchWorkspace> {
  await navigate("/workspaces");
  await $("button=Create workspace").click();
  await waitForRoute("/workspaces/new");
  await setEditorName(FULLSCREEN_WORKSPACE_NAME);
  await $("#workspace-slot-content").click();
  await $("[role='option']=Web app").click();
  await $("#workspace-web-name").setValue("Fullscreen fixture");
  await $("#workspace-web-url").setValue(
    `${requireEnvironment("RION_STUDIO_E2E_FIXTURE_ORIGIN")}/role/${WEB_FIXTURE_ID}`
  );
  await $("[data-workspace-slot-index='1']").click();
  await $("#workspace-slot-content").click();
  await $("[role='option']=Role").click();
  await $(`[data-workspace-role-id='${role.id}']`).click();
  await submitEditor("/workspaces");
  return findWorkspace(FULLSCREEN_WORKSPACE_NAME);
}

async function exerciseMacroMindMapFocus(): Promise<void> {
  const rootSelector = ".react-flow__node:has([data-macro-mind-map-node-kind='macroRoot'])";
  const stepSelector = ".react-flow__node:has([data-macro-mind-map-node-kind='macroStep'])";
  const settingsSelector = ".react-flow__node:has([data-macro-mind-map-node-kind='macroSettings'])";
  const rootNode = await $(rootSelector);
  const stepNode = await $(stepSelector);
  const settingsNode = await $(settingsSelector);
  await rootNode.waitForExist({ timeout: 10_000 });
  await stepNode.waitForExist({ timeout: 10_000 });
  await settingsNode.waitForExist({ timeout: 10_000 });
  const rootNodeId = await rootNode.getAttribute("data-id");
  const stepNodeId = await stepNode.getAttribute("data-id");
  const settingsNodeId = await settingsNode.getAttribute("data-id");
  if (!rootNodeId || !stepNodeId || !settingsNodeId) {
    throw new Error("Macro mind map focus nodes must expose data-id");
  }
  const waitForSingleActiveNode = async (expectedNodeId: string): Promise<void> => {
    await browser.waitUntil(
      async () => {
        const activeNodeIds = await browser.execute(() => [
          ...document.querySelectorAll<HTMLElement>(".macro-mind-map-node-active")
        ].map((node) => node.dataset.id ?? ""));
        return activeNodeIds.length === 1 && activeNodeIds[0] === expectedNodeId;
      },
      { timeout: 10_000, timeoutMsg: `Macro mind map did not focus only ${expectedNodeId}` }
    );
  };

  await rootNode.scrollIntoView({ block: "center", inline: "center" });
  await rootNode.click();
  await waitForSingleActiveNode(rootNodeId);
  await stepNode.click();
  await waitForSingleActiveNode(stepNodeId);
  await settingsNode.click();
  await waitForSingleActiveNode(settingsNodeId);
  await browser.waitUntil(
    async () => await browser.execute(() => (
      document.querySelectorAll("[class~='macro-mind-map-edge-focused']").length > 0
    )),
    { timeout: 10_000, timeoutMsg: "Macro mind map did not focus the settings edge" }
  );
  const frames = await browser.executeAsync(
    (done: (frames: MacroMindMapFocusFrame[]) => void) => {
      const samples: MacroMindMapFocusFrame[] = [];
      const sample = (): void => {
        const map = document.querySelector<HTMLElement>("[data-macro-mind-map='inline']");
        const activeNodes = [...(map?.querySelectorAll<HTMLElement>(".macro-mind-map-node-active") ?? [])];
        const focusedEdges = [
          ...document.querySelectorAll<SVGGElement>("[class~='macro-mind-map-edge-focused']")
        ];
        samples.push({
          activeNodeIds: activeNodes.map((node) => node.dataset.id ?? ""),
          focusedEdgeFilters: focusedEdges.map((edge) => {
            const path = edge.querySelector<SVGPathElement>("[class~='react-flow__edge-path']");
            return path ? getComputedStyle(path).filter : "missing";
          }),
          focusedEdgeIds: focusedEdges.map((edge) => edge.dataset.id ?? ""),
          nodeFilters: [...(map?.querySelectorAll<HTMLElement>(".react-flow__node") ?? [])]
            .map((node) => getComputedStyle(node).filter)
        });
        if (samples.length === 12) {
          done(samples);
          return;
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }
  ) as MacroMindMapFocusFrame[];

  expect(frames).toHaveLength(12);
  expect(frames[0]?.focusedEdgeIds.length).toBeGreaterThan(0);
  for (const frame of frames) {
    expect(frame.activeNodeIds).toEqual([settingsNodeId]);
    expect(frame.nodeFilters.every((filter) => filter === "none")).toBe(true);
    expect(frame.focusedEdgeFilters.every((filter) => filter === "none")).toBe(true);
    expect(frame).toEqual(frames[0]);
  }
}

async function createMacro(role: Role): Promise<Macro> {
  const sidebar = await $(".app-main-sidebar");
  await sidebar.$("button*=Macros").click();
  await waitForRoute("/macros");
  await navigate(`/macros/new?roleId=${role.id}`);
  await setEditorName(MACRO_NAME);
  await $("button[aria-label='Record']").click();
  await browser.action("key")
    .down(Key.Ctrl)
    .down("k")
    .up("k")
    .up(Key.Ctrl)
    .perform();
  const shortcutError = await $("p.text-destructive");
  await shortcutError.waitForExist({ timeout: 10_000 });
  await expect(shortcutError).toHaveText("Ctrl/Command+K is reserved for Rion Studio Quick Access.");
  await expect($("button=Create macro")).toBeDisabled();
  await $("button=Clear").click();
  await $("button=Hold until stopped").click();
  await exerciseMacroMindMapFocus();
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
  await navigate("/settings?section=data");
  await $("button=Clear Web session").click();
  await $("div=The shared Web session was cleared.").waitForExist({ timeout: 10_000 });
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

async function openQuickAccessWithKeyboard(): Promise<void> {
  await browser.action("key")
    .down(Key.Ctrl)
    .down("k")
    .up("k")
    .up(Key.Ctrl)
    .perform();
  await $("[data-testid='quick-access-palette'][open]").waitForExist({ timeout: 10_000 });
}

async function launchAndPinRoleFromQuickAccess(role: Role): Promise<void> {
  await navigate("/dashboard");
  await $("[data-testid='quick-access-trigger']").click();
  const palette = await $("[data-testid='quick-access-palette'][open]");
  await palette.waitForExist({ timeout: 10_000 });
  await browser.keys(Key.Escape);
  await palette.waitForExist({ reverse: true, timeout: 10_000 });

  await fixtureRequest("/api/gate", { roleId: ROLE_FIXTURE_ID });
  await openQuickAccessWithKeyboard();
  const search = await $("[data-testid='quick-access-palette'][open] input[role='combobox']");
  await search.setValue(role.name);
  const option = await $(`#quick-access-option-role-${role.id}`);
  await option.waitForDisplayed({ timeout: 10_000 });
  await $(`button[aria-label='Pin ${role.name}']`).click();
  await $(`button[aria-label='Unpin ${role.name}']`).waitForExist({ timeout: 10_000 });
  await option.click();
  await waitForFixtureNavigation(ROLE_FIXTURE_ID);
  await fixtureRequest("/api/release", { roleId: ROLE_FIXTURE_ID });
  await waitForRoleStatus(
    role.id,
    (status) => status?.state === "running" && status.automationState !== "unavailable"
  );
  await exerciseFullscreenToolbarPreference(role.id);
  await exerciseInGameQuickAccess(role);
}

async function exerciseInGameQuickAccess(role: Role): Promise<void> {
  const runtime = await rendererCall("getEmbeddedRuntimeState");
  const sourceTab = runtime.tabs.find((tab) => tab.roleIds.includes(role.id));
  if (!sourceTab) throw new Error("The launched smoke role has no runtime tab");
  await waitForSelectedRuntimeTabReady(sourceTab.windowId);
  const snapshot = await windowSnapshot(sourceTab.windowId);
  const roleWebview = snapshot.native.roleWebviews?.find((surface) => surface.roleId === role.id);
  if (!roleWebview) throw new Error("The launched smoke role has no native WebView label");
  expect(snapshot.native.focused).toBe(true);

  const fixtureAfter = await fixtureCursor();
  const nativeRequestAfter = (await probe()).latestSequence;
  await submitInGameQuickAccessShortcut(
    sourceTab.windowId,
    snapshot.windowGeneration,
    sourceTab.id,
    role.id
  );
  const nativeRequest = await waitEvent({
    afterSequence: nativeRequestAfter,
    kind: "game-quick-access-requested",
    windowId: sourceTab.windowId
  });
  expect(nativeRequest.details).toEqual(expect.objectContaining({
    origin: "runtimeTab",
    tabId: sourceTab.id,
    webviewLabel: roleWebview.webviewLabel
  }));
  const palette = await $("[data-testid='quick-access-palette'][open]");
  await palette.waitForExist({ timeout: 10_000 });
  expect((await fixtureEvents({ afterSequence: fixtureAfter, roleId: ROLE_FIXTURE_ID }))
    .some((event) => event.code === "KeyK" && event.kind.includes("keydown"))).toBe(false);

  await browser.keys(Key.Escape);
  await palette.waitForExist({ reverse: true, timeout: 10_000 });
  await browser.waitUntil(async () => {
    const restored = await windowSnapshot(sourceTab.windowId);
    return restored.native.focused === true && restored.kernel?.selectedTabId === sourceTab.id;
  }, { timeout: 10_000, timeoutMsg: "Cancelling Quick Access did not restore the source game tab" });

  const secondRequestAfter = (await probe()).latestSequence;
  const restoredSnapshot = await windowSnapshot(sourceTab.windowId);
  await submitInGameQuickAccessShortcut(
    sourceTab.windowId,
    restoredSnapshot.windowGeneration,
    sourceTab.id,
    role.id
  );
  await waitEvent({
    afterSequence: secondRequestAfter,
    kind: "game-quick-access-requested",
    windowId: sourceTab.windowId
  });
  await $("[data-testid='quick-access-palette'][open]").waitForExist({ timeout: 10_000 });
  await $("#quick-access-option-route-settings").click();
  await waitForRoute("/settings");
  await browser.waitUntil(async () => (
    await windowSnapshot(sourceTab.windowId)
  ).native.focused === false, {
    timeout: 10_000,
    timeoutMsg: "A successful Quick Access action incorrectly restored the source game window"
  });
}

async function submitInGameQuickAccessShortcut(
  windowId: string,
  windowGeneration: number,
  tabId: string,
  roleId: string
): Promise<void> {
  // Tauri WebDriver exposes only the main WebviewWindow handle; managed game
  // WKWebView/WebView2 children are native surfaces. Focus the exact child,
  // then submit real platform keyboard input through the desktop driver.
  await runtimeUiAction(windowId, {
    action: "focusRole",
    roleId,
    tabId,
    windowGeneration
  });
  const modifier = process.platform === "darwin" ? "MetaLeft" : "ControlLeft";
  await keyboardInputSequence([
    { code: modifier, phase: "keyDown" },
    { code: "KeyK", phase: "keyDown" },
    { code: "KeyK", phase: "keyUp" },
    { code: modifier, phase: "keyUp" }
  ]);
}

async function launchRoleAndRunMacro(role: Role, macro: Macro): Promise<void> {
  const running = (await rendererCall("listRoleStatuses")).find((status) =>
    status.roleId === role.id && status.state === "running"
  );
  if (!running) throw new Error("Quick Access did not launch the smoke role");

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

async function launchWorkspace(
  workspace: LaunchWorkspace,
  role: Role,
  expectedWebSessionBefore: string | null,
  preserveForRestart = false
): Promise<void> {
  await rendererCall("stopRole", role.id);
  await waitForRoleStatus(role.id, (status) => status === undefined);
  const webSessionCursor = await fixtureCursor();
  await fixtureRequest("/api/gate", { roleId: ROLE_FIXTURE_ID });
  await navigate("/workspaces");
  await $(`[data-selection-id='${workspace.id}'] button[aria-label='Open workspace']`).click();
  await waitForFixtureNavigation(ROLE_FIXTURE_ID);
  await fixtureRequest("/api/release", { roleId: ROLE_FIXTURE_ID });
  const webSession = await waitFixtureEvent({
    afterSequence: webSessionCursor,
    kind: "session",
    roleId: WEB_FIXTURE_ID
  });
  expect(webSession.session).toMatchObject({
    after: { cookie: WEB_SESSION_MARKER, localStorage: WEB_SESSION_MARKER },
    before: { cookie: expectedWebSessionBefore, localStorage: expectedWebSessionBefore },
    marker: WEB_SESSION_MARKER,
    mode: "seed"
  });
  await waitForRoleStatus(role.id, (status) => status?.state === "running");
  await exerciseWorkspaceContainedFullscreen(workspace, role.id);
  await exerciseWorkspaceDivider(workspace, role.id);
  if (!preserveForRestart) {
    await rendererCall("stopRole", role.id);
    await waitForRoleStatus(role.id, (status) => status === undefined);
  }
}

async function exerciseWorkspaceDivider(
  workspace: LaunchWorkspace,
  roleId: string
): Promise<void> {
  const runtime = await rendererCall("getEmbeddedRuntimeState");
  const tab = runtime.tabs.find((candidate) =>
    candidate.type === "workspace"
      && candidate.sourceId === workspace.id
      && candidate.active
  );
  if (!tab) throw new Error("The mixed workspace has no active runtime tab for divider drag");
  await waitForSelectedRuntimeTabReady(tab.windowId);
  const before = await windowSnapshot(tab.windowId);
  const beforeKernelTab = before.kernel?.tabs.find((candidate) => candidate.tabId === tab.id);
  const divider = before.native.dividerSurfaces?.find((candidate) =>
    candidate.axis === "vertical"
  );
  const beforeRoleSlot = beforeKernelTab?.workspaceSlots.find((slot) => slot.roleId === roleId);
  const beforeWebSlot = beforeKernelTab?.workspaceSlots.find((slot) => slot.web !== undefined);
  const webSurfaceId = before.native.roleWebviews?.find(
    (surface) => surface.url?.includes(`/role/${WEB_FIXTURE_ID}`)
  )?.roleId;
  const beforeRoleSurface = before.native.roleSurfaces?.find(
    (surface) => surface.roleId === roleId
  );
  const beforeWebSurface = before.native.roleSurfaces?.find(
    (surface) => surface.roleId === webSurfaceId
  );
  const beforeChrome = before.native.workspaceWebChromeSurfaces?.find(
    (surface) => surface.roleId === webSurfaceId
  );
  if (!before.kernel || !beforeKernelTab || !divider || !beforeRoleSlot || !beforeWebSlot ||
      !webSurfaceId || !beforeRoleSurface || !beforeWebSurface || !beforeChrome) {
    throw new Error("The mixed workspace divider did not expose complete authoritative evidence");
  }

  await runtimeUiAction(tab.windowId, {
    action: "dragDivider",
    deltaRatio: 0.08,
    dividerIndex: divider.dividerIndex,
    tabId: tab.id,
    topologyRevision: before.kernel.revision,
    windowGeneration: before.windowGeneration
  });
  let after: Awaited<ReturnType<typeof windowSnapshot>> | undefined;
  await browser.waitUntil(async () => {
    const candidate = await windowSnapshot(tab.windowId);
    const candidateTab = candidate.kernel?.tabs.find((item) => item.tabId === tab.id);
    const roleSlot = candidateTab?.workspaceSlots.find((slot) => slot.roleId === roleId);
    const roleSurface = candidate.native.roleSurfaces?.find(
      (surface) => surface.roleId === roleId
    );
    const webSurface = candidate.native.roleSurfaces?.find(
      (surface) => surface.roleId === webSurfaceId
    );
    const chrome = candidate.native.workspaceWebChromeSurfaces?.find(
      (surface) => surface.roleId === webSurfaceId
    );
    if ((candidate.kernel?.windowRevision ?? 0) <= before.kernel!.windowRevision ||
        !roleSlot || roleSlot.rect.x <= beforeRoleSlot.rect.x + 0.03 ||
        !roleSurface || (roleSurface.hostBounds.x ?? 0) <=
          (beforeRoleSurface.hostBounds.x ?? 0) + 10 ||
        !webSurface || webSurface.hostBounds.width <= beforeWebSurface.hostBounds.width + 10 ||
        !chrome || chrome.bounds.width <= beforeChrome.bounds.width + 10) {
      return false;
    }
    after = candidate;
    return true;
  }, {
    timeout: 15_000,
    timeoutMsg: "The visible mixed-workspace divider drag did not advance Kernel layout"
  });
  if (!after) throw new Error("The mixed-workspace divider drag produced no snapshot");
  const afterKernelTab = after.kernel?.tabs.find((candidate) => candidate.tabId === tab.id);
  const afterRoleSlot = afterKernelTab?.workspaceSlots.find((slot) => slot.roleId === roleId);
  const afterWebSlot = afterKernelTab?.workspaceSlots.find((slot) => slot.web !== undefined);
  const afterRoleSurface = after.native.roleSurfaces?.find((surface) => surface.roleId === roleId);
  const afterWebSurface = after.native.roleSurfaces?.find(
    (surface) => surface.roleId === webSurfaceId
  );
  const afterChrome = after.native.workspaceWebChromeSurfaces?.find(
    (surface) => surface.roleId === webSurfaceId
  );
  if (!afterRoleSlot || !afterWebSlot || !afterRoleSurface || !afterWebSurface || !afterChrome) {
    throw new Error("The resized mixed workspace lost authoritative or native slot evidence");
  }
  expect(afterWebSlot.rect.width).toBeGreaterThan(beforeWebSlot.rect.width + 0.03);
  expect(afterRoleSlot.rect.x).toBeGreaterThan(beforeRoleSlot.rect.x + 0.03);
  expect(afterWebSlot.rect.x + afterWebSlot.rect.width).toBeCloseTo(afterRoleSlot.rect.x, 5);
  expect(afterWebSurface.hostBounds.width).toBeGreaterThan(beforeWebSurface.hostBounds.width + 10);
  expect(afterRoleSurface.hostBounds.x ?? 0).toBeGreaterThan(
    (beforeRoleSurface.hostBounds.x ?? 0) + 10
  );
  expect(afterChrome.bounds.width).toBeGreaterThan(beforeChrome.bounds.width + 10);
  expectWithinCssPixel(afterChrome.bounds.x, afterWebSurface.hostBounds.x);
  expectWithinCssPixel(afterChrome.bounds.width, afterWebSurface.hostBounds.width);
}

async function verifyRestoredWorkspaceDivider(
  windowId: string,
  workspace: LaunchWorkspace,
  roleId: string
): Promise<void> {
  await waitForSelectedRuntimeTabReady(windowId);
  const restored = await windowSnapshot(windowId);
  const tab = restored.kernel?.tabs.find((candidate) =>
    candidate.sourceId === workspace.id && candidate.tabType === "workspace"
  );
  const roleSlot = tab?.workspaceSlots.find((slot) => slot.roleId === roleId);
  const webSlot = tab?.workspaceSlots.find((slot) => slot.web !== undefined);
  if (!tab || !roleSlot || !webSlot) {
    throw new Error("The restarted Game Window did not restore its complete mixed workspace layout");
  }
  expect(restored.kernel?.selectedTabId).toBe(tab.tabId);
  expect(roleSlot.rect.x).toBeGreaterThan(0.53);
  expect(webSlot.rect.width).toBeGreaterThan(0.53);
  expect(webSlot.rect.x + webSlot.rect.width).toBeCloseTo(roleSlot.rect.x, 5);
  const webSurfaceId = restored.native.roleWebviews?.find(
    (surface) => surface.url?.includes(`/role/${WEB_FIXTURE_ID}`)
  )?.roleId;
  const roleSurface = restored.native.roleSurfaces?.find((surface) => surface.roleId === roleId);
  const webSurface = restored.native.roleSurfaces?.find(
    (surface) => surface.roleId === webSurfaceId
  );
  const chrome = restored.native.workspaceWebChromeSurfaces?.find(
    (surface) => surface.roleId === webSurfaceId
  );
  if (!roleSurface || !webSurface || !chrome) {
    throw new Error("The restarted mixed workspace did not restore all native surfaces");
  }
  expect(roleSurface.hostBounds.x ?? 0).toBeGreaterThan(webSurface.hostBounds.x ?? 0);
  expectWithinCssPixel(chrome.bounds.x, webSurface.hostBounds.x);
  expectWithinCssPixel(chrome.bounds.width, webSurface.hostBounds.width);
}

async function exerciseWorkspaceContainedFullscreen(
  workspace: LaunchWorkspace,
  expectedSiblingSurfaceId?: string
): Promise<void> {
  const runtime = await rendererCall("getEmbeddedRuntimeState");
  const tab = runtime.tabs.find((candidate) =>
    candidate.type === "workspace"
      && candidate.sourceId === workspace.id
      && candidate.active
  );
  if (!tab) throw new Error("The launched Web workspace has no active runtime tab");
  await waitForSelectedRuntimeTabReady(tab.windowId);
  const before = await windowSnapshot(tab.windowId);
  const webSurfaceId = before.native.roleWebviews?.find(
    (surface) => surface.url?.includes(`/role/${WEB_FIXTURE_ID}`)
  )?.roleId;
  if (!webSurfaceId) throw new Error("The launched workspace has no Web surface identity");
  const beforeSurfaces = before.native.roleSurfaces ?? [];
  const webSurface = beforeSurfaces.find((surface) => surface.roleId === webSurfaceId);
  const siblingSurface = beforeSurfaces.find((surface) =>
    expectedSiblingSurfaceId
      ? surface.roleId === expectedSiblingSurfaceId
      : surface.roleId !== webSurfaceId
  );
  if (!webSurface || !siblingSurface) {
    throw new Error("The mixed workspace did not expose both native slot surfaces");
  }
  const originalPresentation = before.native.presentation;
  const originalWebBounds = webSurface.hostBounds;
  const originalChrome = before.native.workspaceWebChromeSurfaces?.find(
    (surface) => surface.roleId === webSurfaceId
  );
  if (!originalChrome) {
    throw new Error("The Workspace Web slot did not expose its sibling chrome surface");
  }
  const originalSlotBounds = {
    height: originalChrome.bounds.height + originalWebBounds.height,
    width: originalWebBounds.width,
    x: originalWebBounds.x,
    y: originalChrome.bounds.y
  };
  const originalSiblingBounds = siblingSurface.hostBounds;
  const siblingSurfaceId = siblingSurface.roleId;

  await runtimeUiAction(tab.windowId, {
    action: "focusRole",
    roleId: webSurfaceId,
    tabId: tab.id,
    windowGeneration: before.windowGeneration
  });

  const enterAfter = await fixtureCursor();
  await keyboardInputSequence([
    { code: "Tab", phase: "keyDown" },
    { code: "Tab", phase: "keyUp" },
    { code: "Tab", phase: "keyDown" },
    { code: "Tab", phase: "keyUp" },
    { code: "Enter", phase: "keyDown" },
    { code: "Enter", phase: "keyUp" }
  ]);
  const entered = await waitFixtureEvent({
    afterSequence: enterAfter,
    kind: "contained-fullscreen-enter",
    roleId: WEB_FIXTURE_ID
  });
  expect(entered.fullscreen).toEqual(expect.objectContaining({
    active: true,
    targetId: "contained-fullscreen-controls",
    toolbarPresent: false
  }));
  expectWithinCssPixel(entered.fullscreen?.rect.width, entered.fullscreen?.viewport.width);
  expectWithinCssPixel(entered.fullscreen?.rect.height, entered.fullscreen?.viewport.height);
  expectWithinCssPixel(entered.fullscreen?.rect.x, 0);
  expectWithinCssPixel(entered.fullscreen?.rect.y, 0);

  const whileContained = await windowSnapshot(tab.windowId);
  expect(whileContained.native.presentation).toBe(originalPresentation);
  expect(whileContained.native.roleSurfaces?.find(
    (surface) => surface.roleId === webSurfaceId
  )?.hostBounds).toEqual(originalSlotBounds);
  expect(whileContained.native.workspaceWebChromeSurfaces?.find(
    (surface) => surface.roleId === webSurfaceId
  )).toEqual(expect.objectContaining({
    fullscreen: true,
    visible: false
  }));
  expect(whileContained.native.roleSurfaces?.find(
    (surface) => surface.roleId === siblingSurfaceId
  )?.hostBounds).toEqual(originalSiblingBounds);

  const siteExitAfter = await fixtureCursor();
  await keyboardInputSequence([
    { code: "Tab", phase: "keyDown" },
    { code: "Tab", phase: "keyUp" },
    { code: "Enter", phase: "keyDown" },
    { code: "Enter", phase: "keyUp" }
  ]);
  const siteExit = await waitFixtureEvent({
    afterSequence: siteExitAfter,
    kind: "contained-fullscreen-exit",
    roleId: WEB_FIXTURE_ID
  });
  expect(siteExit.fullscreen).toEqual(expect.objectContaining({
    active: false,
    targetId: null,
    toolbarPresent: false
  }));

  const secondEnterAfter = await fixtureCursor();
  await keyboardInputSequence([
    { code: "ShiftLeft", phase: "keyDown" },
    { code: "Tab", phase: "keyDown" },
    { code: "Tab", phase: "keyUp" },
    { code: "ShiftLeft", phase: "keyUp" },
    { code: "Enter", phase: "keyDown" },
    { code: "Enter", phase: "keyUp" }
  ]);
  await waitFixtureEvent({
    afterSequence: secondEnterAfter,
    kind: "contained-fullscreen-enter",
    roleId: WEB_FIXTURE_ID
  });

  const escapeAfter = await fixtureCursor();
  await keyboardInputSequence([
    { code: "Escape", phase: "keyDown" },
    { code: "Escape", phase: "keyUp" }
  ]);
  const escapeExit = await waitFixtureEvent({
    afterSequence: escapeAfter,
    kind: "contained-fullscreen-exit",
    roleId: WEB_FIXTURE_ID
  });
  expect(escapeExit.fullscreen).toEqual(expect.objectContaining({
    active: false,
    toolbarPresent: false
  }));
  const restored = await windowSnapshot(tab.windowId);
  expect(restored.native.presentation).toBe(originalPresentation);
  expect(restored.native.roleSurfaces?.find(
    (surface) => surface.roleId === webSurfaceId
  )?.hostBounds).toEqual(originalWebBounds);
  expect(restored.native.roleSurfaces?.find(
    (surface) => surface.roleId === siblingSurfaceId
  )?.hostBounds).toEqual(originalSiblingBounds);
  expect(restored.native.workspaceWebChromeSurfaces?.find(
    (surface) => surface.roleId === webSurfaceId
  )).toEqual(expect.objectContaining({
    bounds: originalChrome.bounds,
    fullscreen: false,
    visible: true
  }));

  // WKWebView does not grant transient popup activation to the synthetic
  // desktop-E2E input stream. The product popup contract remains covered by
  // native policy tests, while WebView2 CI exercises the visible popup flow.
  if (process.platform === "darwin") return;

  const popupReadyAfter = await fixtureCursor();
  await keyboardInputSequence([
    { code: "Tab", phase: "keyDown" },
    { code: "Tab", phase: "keyUp" },
    { code: "Tab", phase: "keyDown" },
    { code: "Tab", phase: "keyUp" },
    { code: "Enter", phase: "keyDown" },
    { code: "Enter", phase: "keyUp" }
  ]);
  await waitFixtureEvent({
    afterSequence: popupReadyAfter,
    kind: "contained-popup-ready",
    roleId: WEB_POPUP_FIXTURE_ID
  });
  const popupBefore = await windowSnapshot(tab.windowId);
  const popup = popupBefore.native.popupWindows?.find(
    (candidate) => candidate.roleId === webSurfaceId
  );
  if (!popup) throw new Error("The controlled Workspace Web popup was not registered");
  expect(popup.native.presentation).toBe("normal");
  const popupBounds = popup.native.outerBounds;

  const popupEnterAfter = await fixtureCursor();
  await keyboardInput("Enter", "keyDown", false);
  await keyboardInput("Enter", "keyUp", false);
  const popupEntered = await waitFixtureEvent({
    afterSequence: popupEnterAfter,
    kind: "contained-fullscreen-enter",
    roleId: WEB_POPUP_FIXTURE_ID
  });
  expect(popupEntered.fullscreen).toEqual(expect.objectContaining({
    active: true,
    targetId: "contained-fullscreen-controls",
    toolbarPresent: false
  }));
  expectWithinCssPixel(
    popupEntered.fullscreen?.rect.width,
    popupEntered.fullscreen?.viewport.width
  );
  expectWithinCssPixel(
    popupEntered.fullscreen?.rect.height,
    popupEntered.fullscreen?.viewport.height
  );
  const popupWhileContained = (await windowSnapshot(tab.windowId)).native.popupWindows?.find(
    (candidate) => candidate.label === popup.label
  );
  expect(popupWhileContained?.native.presentation).toBe("normal");
  expect(popupWhileContained?.native.outerBounds).toEqual(popupBounds);

  const popupSiteExitAfter = await fixtureCursor();
  await keyboardInput("Tab", "keyDown", false);
  await keyboardInput("Tab", "keyUp", false);
  await keyboardInput("Enter", "keyDown", false);
  await keyboardInput("Enter", "keyUp", false);
  await waitFixtureEvent({
    afterSequence: popupSiteExitAfter,
    kind: "contained-fullscreen-exit",
    roleId: WEB_POPUP_FIXTURE_ID
  });

  const popupSecondEnterAfter = await fixtureCursor();
  await keyboardInput("ShiftLeft", "keyDown", false);
  await keyboardInput("Tab", "keyDown", false);
  await keyboardInput("Tab", "keyUp", false);
  await keyboardInput("ShiftLeft", "keyUp", false);
  await keyboardInput("Enter", "keyDown", false);
  await keyboardInput("Enter", "keyUp", false);
  await waitFixtureEvent({
    afterSequence: popupSecondEnterAfter,
    kind: "contained-fullscreen-enter",
    roleId: WEB_POPUP_FIXTURE_ID
  });
  const popupEscapeAfter = await fixtureCursor();
  await keyboardInput("Escape", "keyDown", false);
  await keyboardInput("Escape", "keyUp", false);
  const popupEscapeExit = await waitFixtureEvent({
    afterSequence: popupEscapeAfter,
    kind: "contained-fullscreen-exit",
    roleId: WEB_POPUP_FIXTURE_ID
  });
  expect(popupEscapeExit.fullscreen).toEqual(expect.objectContaining({
    active: false,
    toolbarPresent: false
  }));
  const popupRestored = (await windowSnapshot(tab.windowId)).native.popupWindows?.find(
    (candidate) => candidate.label === popup.label
  );
  expect(popupRestored?.native.presentation).toBe("normal");
  expect(popupRestored?.native.outerBounds).toEqual(popupBounds);
}

async function containedFullscreenPhase(): Promise<void> {
  await ensureEnglishUi();
  await acceptLegalAndSkipFirstRun();
  const role = await createContainedFullscreenRole();
  const workspace = await createContainedFullscreenWorkspace(role);
  const primaryAfter = await fixtureCursor();
  await navigate("/workspaces");
  await $(`[data-selection-id='${workspace.id}'] button[aria-label='Open workspace']`).click();
  await waitFixtureEvent({
    afterSequence: primaryAfter,
    kind: "session",
    roleId: WEB_FIXTURE_ID
  });
  await waitForRoleStatus(role.id, (status) => status?.state === "running");
  await exerciseWorkspaceContainedFullscreen(workspace, role.id);
  await shutdownAndWaitForFlush();
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
  await launchAndPinRoleFromQuickAccess(role);
  await launchRoleAndRunMacro(role, macro);
  await launchWorkspace(workspace, role, null, true);
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
  expect(workspace.slots.some((slot) =>
    slot.web?.name === "E2E Web App" && slot.web.startUrl.includes(WEB_FIXTURE_ID)
  )).toBe(true);
  expect(macro.roleIds).toContain(role.id);
  expect(await browser.execute(() => document.documentElement.dataset.theme)).toBe("light");
  expect(await rendererCall("getRuntimeWindowPreferences")).toEqual(
    expect.objectContaining({
      alwaysHideTabCloseButton: true,
      alwaysShowToolbarInFullScreen: false
    })
  );
  expect((await rendererCall("getGameBrowserSettings")).macroOverlay).toEqual({
    showClickMarkers: false,
    showRunningBadges: false,
    showToolButton: false
  });
  await navigate("/dashboard");
  await $("[data-testid='quick-access-trigger']").click();
  await $(`#quick-access-option-role-${role.id}`).waitForDisplayed({ timeout: 10_000 });
  await $(`button[aria-label='Unpin ${role.name}']`).waitForExist({ timeout: 10_000 });
  await browser.keys(Key.Escape);
  await navigate("/settings?section=preferences");
  const clearRecent = await $("button=Clear recent");
  await clearRecent.waitForEnabled({ timeout: 10_000 });
  await clearRecent.click();
  await clearRecent.waitForEnabled({ reverse: true, timeout: 10_000 });
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
  await verifyRestoredWorkspaceDivider(smokeWindow.id, workspace, role.id);
  const cursor = (await probe()).latestSequence;
  await clickEntityMenuAction(smokeWindow.id, "Game window actions", "Delete window");
  await clickConfirmation("Delete");
  await waitEvent({ afterSequence: cursor, kind: "window-destroyed", windowId: smokeWindow.id });
  await browser.waitUntil(
    async () => !(await rendererCall("listGameWindows")).some((candidate) => candidate.id === smokeWindow.id),
    { timeout: 15_000, timeoutMsg: "Smoke Game Window remained after UI deletion" }
  );
  await launchWorkspace(workspace, role, WEB_SESSION_MARKER);
  await shutdownAndWaitForFlush();
}

describe("application UI smoke journeys", () => {
  it(`runs ${requireEnvironment("RION_STUDIO_E2E_PHASE")} through visible user actions`, async () => {
    const phase = requireEnvironment("RION_STUDIO_E2E_PHASE");
    if (phase === "smoke-seed") await seedPhase();
    else if (phase === "smoke-restart") await restartPhase();
    else if (phase === "workspace-contained-fullscreen") await containedFullscreenPhase();
    else throw new Error(`Unknown application journey phase: ${phase}`);
  });
});
