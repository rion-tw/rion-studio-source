import { $, browser, expect } from "@wdio/globals";

import type {
  EmbeddedRuntimeState,
  Game,
  GameWindow,
  LaunchWorkspace,
  Role
} from "../../../src/shared/types";
import {
  electronDesktopE2eFullscreenToolbarRuntime,
  electronDesktopE2eProbe,
  electronDesktopE2eRoleSessionRuntime,
  type ElectronDesktopE2eFullscreenToolbarRuntimeInspection
} from "../support/electron-driver";
import { dragWindowsVisibleWorkspaceDivider } from
  "../support/electron-role-surface";
import { dragMacosVisibleWorkspaceDivider } from
  "../support/macos-appkit-ui";
import {
  installRuntimeTabShellErrorJournal,
  runtimeTabShellErrors
} from "../support/native-runtime-tabs";
import { rendererCall } from "../support/renderer-bridge";
import {
  acceptLegalAndSkipFirstRun,
  clickWorkspaceCreateAction,
  clickWorkspaceSlot,
  ensureEnglishUi,
  setEditorName,
  setInputValue,
  submitEditor,
  waitForRoute
} from "../support/ui";

// [journey:CHROMIUM-MACOS-APPKIT-WORKSPACE-GAP-DIVIDERS-035]
// [journey:CHROMIUM-WINDOWS-WORKSPACE-GAP-DIVIDERS-035]

const PRIMARY_ROLE_NAME = "Chromium Entity Role Edited";
const SECONDARY_ROLE_NAME = "Chromium Workspace Gap Secondary Role";
// This journey persists its secondary Role beyond the divider restart. Keep it
// on a built-in Game so the later app-CRUD cleanup can delete its own custom
// Game without inheriting a dependency from this independent journey.
const GAME_NAME = "Flyff Universe";
const WORKSPACE_NAME = "Chromium Workspace Gap Dividers";
const WINDOW_NAME = "Chromium Workspace Gap Divider Window";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the Workspace gap journey`);
  return value;
}

async function preparePhase(): Promise<"macos" | "windows"> {
  const probe = await electronDesktopE2eProbe();
  expect(probe.runtimeTarget).toBe(required("RION_STUDIO_E2E_RUNTIME_TARGET"));
  await ensureEnglishUi();
  await acceptLegalAndSkipFirstRun();
  await installRuntimeTabShellErrorJournal();
  return probe.platform;
}

async function openSection(label: string, route: string): Promise<void> {
  const sidebar = await $(".app-main-sidebar");
  await sidebar.waitForDisplayed({ timeout: 20_000 });
  const button = await sidebar.$(`button*=${label}`);
  await button.waitForClickable({ timeout: 10_000 });
  await button.click();
  await waitForRoute(route);
}

async function findNamed<Value extends { name: string }>(
  list: () => Promise<Value[]>,
  name: string
): Promise<Value> {
  let match: Value | undefined;
  await browser.waitUntil(async () => {
    match = (await list()).find((candidate) => candidate.name === name);
    return match !== undefined;
  }, { timeout: 15_000, timeoutMsg: `Did not find ${name}` });
  return match!;
}

async function clickEntityMenuAction(
  entityId: string,
  labels: readonly string[],
  actionLabel: string
): Promise<void> {
  const entity = await $(`[data-selection-id='${entityId}']`);
  await entity.waitForDisplayed({ timeout: 10_000 });
  await entity.scrollIntoView({ block: "center", inline: "center" });
  await entity.moveTo();
  for (const label of labels) {
    const trigger = await entity.$(`button[aria-label='${label}']`);
    if (!await trigger.isExisting()) continue;
    await trigger.waitForClickable({ timeout: 10_000 });
    await trigger.click();
    const action = await $(`//*[@role='menuitem' and normalize-space(.)='${actionLabel}']`);
    await action.waitForClickable({ timeout: 10_000 });
    await action.click();
    return;
  }
  throw new Error(`Entity ${entityId} has no visible action menu`);
}

async function createSecondaryRole(): Promise<Role> {
  const existing = (await rendererCall("listRoles"))
    .find((role) => role.name === SECONDARY_ROLE_NAME);
  if (existing) return existing;
  const game = await findNamed<Game>(() => rendererCall("listGames"), GAME_NAME);
  await openSection("Games", "/games");
  await clickEntityMenuAction(game.id, ["Game actions"], "Add role");
  await waitForRoute(`/roles/new?gameId=${game.id}`);
  await setEditorName(SECONDARY_ROLE_NAME);
  await submitEditor("/roles");
  return findNamed<Role>(() => rendererCall("listRoles"), SECONDARY_ROLE_NAME);
}

async function createWorkspace(primary: Role, secondary: Role): Promise<LaunchWorkspace> {
  await openSection("Workspaces", "/workspaces");
  await clickWorkspaceCreateAction();
  await waitForRoute("/workspaces/new");
  await setEditorName(WORKSPACE_NAME);
  const layout = await $("#workspace-layout");
  await layout.click();
  await $("[data-workspace-layout-option='main_left_stack_right']").click();

  for (const [slotIndex, role] of [[0, primary], [1, secondary]] as const) {
    await clickWorkspaceSlot(slotIndex);
    await $("#workspace-slot-content").click();
    await $("[role='option']=Role").click();
    await $(`[data-workspace-role-id='${role.id}']`).click();
  }
  await clickWorkspaceSlot(2);
  await $("#workspace-slot-content").click();
  await $("[role='option']=Website").click();
  await submitEditor("/workspaces");

  const workspace = await findNamed<LaunchWorkspace>(
    () => rendererCall("listLaunchWorkspaces"), WORKSPACE_NAME
  );
  expect(workspace.template).toBe("main_left_stack_right");
  expect(workspace.slots).toHaveLength(3);
  return workspace;
}

async function setVisibleWorkspaceGap(gap: 1 | 16): Promise<void> {
  await openSection("Settings", "/settings");
  const settingsSidebar = await $(".settings-mode-sidebar");
  await settingsSidebar.waitForDisplayed({ timeout: 10_000 });
  await settingsSidebar.$("button=Interface settings").click();
  await waitForRoute("/settings?section=interface");
  const control = await $("button[role='combobox'][aria-label='Workspace gap']");
  await control.waitForEnabled({ timeout: 10_000 });
  if (!((await control.getText()).includes(`${gap} px`))) {
    await control.click();
    const option = await $(`[role='option']=${gap} px`);
    await option.waitForClickable({ timeout: 10_000 });
    await option.click();
  }
  await browser.waitUntil(async () => {
    const settings = await rendererCall("getGameBrowserSettings");
    return settings.workspace.gap === gap && await control.isEnabled();
  }, {
    interval: 100,
    timeout: 20_000,
    timeoutMsg: `The visible Workspace gap did not settle at ${gap}px`
  });
  const back = await $(".settings-back");
  await back.waitForClickable({ timeout: 10_000 });
  await back.click();
  await $(".app-main-sidebar").waitForDisplayed({ timeout: 20_000 });
}

async function createSavedWindow(): Promise<GameWindow> {
  await openSection("Windows", "/game-windows");
  const before = new Set(
    (await rendererCall("listGameWindows")).map((window) => window.id)
  );
  await $("button=New game window").click();
  let created: GameWindow | undefined;
  await browser.waitUntil(async () => {
    created = (await rendererCall("listGameWindows"))
      .find((candidate) => !before.has(candidate.id));
    return created !== undefined;
  }, { timeout: 15_000, timeoutMsg: "Visible UI did not create a Game Window" });
  await clickEntityMenuAction(created!.id, ["Game window actions"], "Rename");
  await setInputValue("#rename-game-window-name", WINDOW_NAME);
  const dialog = await $("dialog[open]");
  await dialog.$("button=Save").click();
  return findNamed<GameWindow>(() => rendererCall("listGameWindows"), WINDOW_NAME);
}

async function launchWorkspace(
  workspace: LaunchWorkspace,
  gameWindow: GameWindow,
  roleIds: readonly string[]
): Promise<Readonly<{
  mainWindowHandle: string;
  tabId: string;
  window: EmbeddedRuntimeState["windows"][number];
}>> {
  const mainWindowHandle = await browser.getWindowHandle();
  await openSection("Home", "/dashboard");
  await $("[data-testid='quick-access-trigger']").click();
  await setInputValue(
    "[data-testid='quick-access-palette'][open] input[role='combobox']",
    workspace.name
  );
  await $(`#quick-access-option-workspace-${workspace.id}`).waitForDisplayed({
    timeout: 10_000
  });
  await $(`[data-testid='quick-access-destination-workspace-${workspace.id}']`).click();
  await $(`[data-testid='quick-access-destination-option-window-${gameWindow.id}']`).click();

  let runtime: EmbeddedRuntimeState | undefined;
  let tab: EmbeddedRuntimeState["tabs"][number] | undefined;
  let window: EmbeddedRuntimeState["windows"][number] | undefined;
  await browser.waitUntil(async () => {
    runtime = await rendererCall("getEmbeddedRuntimeState");
    tab = runtime.tabs.find((candidate) =>
      candidate.type === "workspace" && candidate.sourceId === workspace.id &&
      candidate.windowId === gameWindow.id &&
      roleIds.every((roleId) => candidate.roleIds.includes(roleId))
    );
    window = runtime.windows.find((candidate) => candidate.id === gameWindow.id);
    const running = await rendererCall("listRoleStatuses");
    return Boolean(tab && window?.visible) && roleIds.every((roleId) =>
      running.some((status) => status.roleId === roleId && status.state === "running")
    );
  }, {
    interval: 100,
    timeout: 45_000,
    timeoutMsg: "The three-slot Workspace did not reach its visible native host"
  });
  return { mainWindowHandle, tabId: tab!.id, window: window! };
}

function workspaceSurfaces(
  inspection: ElectronDesktopE2eFullscreenToolbarRuntimeInspection,
  tabId: string,
  primaryRoleId: string,
  secondaryRoleId: string
) {
  const surfaces = inspection.surfaces.filter((surface) => surface.tabId === tabId);
  const main = surfaces.find((surface) => surface.id === primaryRoleId);
  const top = surfaces.find((surface) => surface.id === secondaryRoleId);
  const bottom = surfaces.find((surface) => surface.kind === "web");
  if (!main || !top || !bottom || surfaces.length !== 3) {
    throw new Error(`The exact three-slot native surface set is unavailable: ${JSON.stringify(surfaces)}`);
  }
  return { main, top, bottom };
}

function expectExactGap(
  inspection: ElectronDesktopE2eFullscreenToolbarRuntimeInspection,
  tabId: string,
  primaryRoleId: string,
  secondaryRoleId: string,
  gap: number
): void {
  const { main, top, bottom } = workspaceSurfaces(
    inspection, tabId, primaryRoleId, secondaryRoleId
  );
  expect(top.bounds.x - (main.bounds.x + main.bounds.width)).toBe(gap);
  expect(bottom.bounds.x - (main.bounds.x + main.bounds.width)).toBe(gap);
  expect(bottom.bounds.y - (top.bounds.y + top.bounds.height)).toBe(gap);
  for (const surface of [main, top, bottom]) expect(surface.visible).toBe(true);
}

async function waitForExactGap(input: Readonly<{
  gap: number;
  primaryRoleId: string;
  secondaryRoleId: string;
  tabId: string;
  windowId: string;
}>): Promise<ElectronDesktopE2eFullscreenToolbarRuntimeInspection> {
  let inspection: ElectronDesktopE2eFullscreenToolbarRuntimeInspection | undefined;
  await browser.waitUntil(async () => {
    try {
      inspection = await electronDesktopE2eFullscreenToolbarRuntime(input.windowId);
      expectExactGap(
        inspection, input.tabId, input.primaryRoleId, input.secondaryRoleId, input.gap
      );
      return true;
    } catch {
      return false;
    }
  }, {
    interval: 100,
    timeout: 20_000,
    timeoutMsg: `Native Workspace surfaces did not reach an exact ${input.gap}px gap`
  });
  return inspection!;
}

async function dragDivider(input: Readonly<{
  axis: "horizontal" | "vertical";
  dividerIndex: number;
  mainWindowHandle: string;
  platform: "macos" | "windows";
}>): Promise<void> {
  const request = {
    axis: input.axis,
    dividerIndex: input.dividerIndex,
    expectedThickness: 16
  };
  if (input.platform === "macos") {
    await dragMacosVisibleWorkspaceDivider({
      ...request,
      // Remains inside the 960x640 host while crossing Core's 5% snap even
      // when the CI display reports a scaled accessibility coordinate.
      deltaScreenPixels: 192
    });
  } else {
    await dragWindowsVisibleWorkspaceDivider(input.mainWindowHandle, {
      ...request,
      deltaCssPixels: 192
    });
  }
}

async function seedPhase(platform: "macos" | "windows"): Promise<void> {
  const primary = await findNamed<Role>(
    () => rendererCall("listRoles"), PRIMARY_ROLE_NAME
  );
  const secondary = await createSecondaryRole();
  await setVisibleWorkspaceGap(1);
  const workspace = await createWorkspace(primary, secondary);
  const gameWindow = await createSavedWindow();
  const launched = await launchWorkspace(
    workspace, gameWindow, [primary.id, secondary.id]
  );
  const initial = await waitForExactGap({
    gap: 1,
    primaryRoleId: primary.id,
    secondaryRoleId: secondary.id,
    tabId: launched.tabId,
    windowId: gameWindow.id
  });
  const initialPrimary = await electronDesktopE2eRoleSessionRuntime(primary.id);
  const initialSecondary = await electronDesktopE2eRoleSessionRuntime(secondary.id);

  await setVisibleWorkspaceGap(16);
  const updated = await waitForExactGap({
    gap: 16,
    primaryRoleId: primary.id,
    secondaryRoleId: secondary.id,
    tabId: launched.tabId,
    windowId: gameWindow.id
  });
  const updatedPrimary = await electronDesktopE2eRoleSessionRuntime(primary.id);
  const updatedSecondary = await electronDesktopE2eRoleSessionRuntime(secondary.id);
  expect(updated.topologyRevision).toBe(initial.topologyRevision);
  expect(updated.windowGeneration).toBe(initial.windowGeneration);
  for (const [before, after] of [
    [initialPrimary.currentRuntime, updatedPrimary.currentRuntime],
    [initialSecondary.currentRuntime, updatedSecondary.currentRuntime]
  ] as const) {
    expect(after).not.toBeNull();
    expect(before).not.toBeNull();
    expect(after).toMatchObject({
      appKitIdentity: before!.appKitIdentity,
      attemptGeneration: before!.attemptGeneration,
      generation: before!.generation,
      hostKind: before!.hostKind,
      ownerGeneration: before!.ownerGeneration,
      parentNativeHostId: before!.parentNativeHostId,
      tabId: before!.tabId,
      topologyRevision: before!.topologyRevision,
      windowGeneration: before!.windowGeneration,
      windowId: before!.windowId
    });
  }

  const beforeVertical = updated.workspaceTabs.find(
    (tab) => tab.tabId === launched.tabId
  )!;
  await dragDivider({
    axis: "vertical", dividerIndex: 0,
    mainWindowHandle: launched.mainWindowHandle, platform
  });
  let afterVertical: ElectronDesktopE2eFullscreenToolbarRuntimeInspection | undefined;
  await browser.waitUntil(async () => {
    afterVertical = await electronDesktopE2eFullscreenToolbarRuntime(gameWindow.id);
    const coreTab = afterVertical.workspaceTabs.find(
      (tab) => tab.tabId === launched.tabId
    );
    return afterVertical.topologyRevision > updated.topologyRevision &&
      coreTab?.slots[0]?.rect.width !== beforeVertical.slots[0]!.rect.width;
  }, { timeout: 20_000, timeoutMsg: "Vertical divider did not commit its Core slot rect" });

  const revisionAfterVertical = afterVertical!.topologyRevision;
  const slotsAfterVertical = afterVertical!.workspaceTabs.find(
    (tab) => tab.tabId === launched.tabId
  )!.slots;
  await dragDivider({
    axis: "horizontal", dividerIndex: 1,
    mainWindowHandle: launched.mainWindowHandle, platform
  });
  let finalInspection: ElectronDesktopE2eFullscreenToolbarRuntimeInspection | undefined;
  await browser.waitUntil(async () => {
    finalInspection = await electronDesktopE2eFullscreenToolbarRuntime(gameWindow.id);
    const coreTab = finalInspection.workspaceTabs.find(
      (tab) => tab.tabId === launched.tabId
    );
    return finalInspection.topologyRevision > revisionAfterVertical &&
      coreTab?.slots[1]?.rect.height !== slotsAfterVertical[1]!.rect.height;
  }, { timeout: 20_000, timeoutMsg: "Horizontal divider did not commit its Core slot rect" });

  expect(finalInspection!.workspaceTabs.find(
    (tab) => tab.tabId === launched.tabId
  )!.slots).toHaveLength(3);
  expect(await runtimeTabShellErrors()).toEqual([]);
}

async function restartPhase(): Promise<void> {
  const [primary, secondary, workspace, gameWindow] = await Promise.all([
    findNamed<Role>(() => rendererCall("listRoles"), PRIMARY_ROLE_NAME),
    findNamed<Role>(() => rendererCall("listRoles"), SECONDARY_ROLE_NAME),
    findNamed<LaunchWorkspace>(() => rendererCall("listLaunchWorkspaces"), WORKSPACE_NAME),
    findNamed<GameWindow>(() => rendererCall("listGameWindows"), WINDOW_NAME)
  ]);
  expect((await rendererCall("getGameBrowserSettings")).workspace.gap).toBe(16);
  const persistedTab = gameWindow.tabs.find((tab) =>
    tab.tabType === "workspace" && tab.sourceId === workspace.id
  );
  expect(persistedTab?.workspaceSlots).toHaveLength(3);
  expect(persistedTab?.workspaceSlots?.[0]?.rect.width).not.toBe(0.5);
  expect(persistedTab?.workspaceSlots?.[1]?.rect.height).not.toBe(0.5);

  const current = await rendererCall("getEmbeddedRuntimeState");
  if (!current.windows.some((window) => window.id === gameWindow.id && window.visible)) {
    await openSection("Windows", "/game-windows");
    const row = await $(`[data-selection-id='${gameWindow.id}']`);
    await row.$("button[aria-label='Show']").click();
  }
  let tabId = persistedTab!.id;
  await browser.waitUntil(async () => {
    const runtime = await rendererCall("getEmbeddedRuntimeState");
    const tab = runtime.tabs.find((candidate) =>
      candidate.windowId === gameWindow.id && candidate.sourceId === workspace.id
    );
    if (tab) tabId = tab.id;
    return Boolean(tab) && runtime.windows.some((window) =>
      window.id === gameWindow.id && window.visible
    );
  }, { timeout: 45_000, timeoutMsg: "The saved three-slot Workspace did not restore" });
  await waitForExactGap({
    gap: 16,
    primaryRoleId: primary.id,
    secondaryRoleId: secondary.id,
    tabId,
    windowId: gameWindow.id
  });
  expect(await runtimeTabShellErrors()).toEqual([]);
}

describe("Chromium live Workspace gap and paired dividers", () => {
  it("projects a live 1px to 16px update and persists both native divider axes", async () => {
    const platform = await preparePhase();
    const phase = required("RION_STUDIO_E2E_PHASE");
    if (phase === "chromium-workspace-gap-dividers-seed") {
      await seedPhase(platform);
    } else if (phase === "chromium-workspace-gap-dividers-restart") {
      await restartPhase();
    } else {
      throw new Error(`Unexpected Workspace gap journey phase ${phase}`);
    }
  });
});
