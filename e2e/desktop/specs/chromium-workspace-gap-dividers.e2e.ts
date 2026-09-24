import { captureWorkspaceTransitionFrames } from "../support/workspace-transition-frames";
import { armFirstWorkspaceHost, exerciseFirstWorkspaceHost } from "./chromium-workspace-first-host";
import { resizeWorkspaceWithLoadingSibling, resizeActiveWebsiteTab } from "./chromium-workspace-tab-resize";
import { exerciseWorkspaceWindowTransitions } from "./chromium-workspace-window-transitions";
import { captureWorkspaceWebsiteHandles, exerciseWorkspaceTransparency } from "./chromium-workspace-transparency-evidence";
import { exerciseWorkspaceResize } from "./chromium-workspace-resize-evidence";
import { expectWorkspacePixels, paintWorkspaceTargets } from "./chromium-workspace-gap-evidence";
import { fixtureRequest } from "../support/fixture";
import { activateWindowsRuntimeTabWhileLoading } from "../support/windows-runtime-tab-close";
import { clickVisibleRuntimeTab } from "../support/native-runtime-tabs";
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
import { dragMacosVisibleWorkspaceDivider, movePointerToMacosRuntimeContent, readMacosVisibleRuntimeTabPoint } from
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

async function setVisibleWorkspaceGap(gap: 1 | 16, background: "material" | "black" = "material"): Promise<void> {
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
  const backgroundControl = await $(`button=${background === "black" ? "Solid black" : "Transparent material"}`);
  await backgroundControl.waitForClickable({ timeout: 10_000 });
  await backgroundControl.click();
  await browser.waitUntil(async () => (await rendererCall("getGameBrowserSettings")).workspace.background === background,
    { timeout: 20_000 });
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
  roleIds: readonly string[],
  whileLoading?: (tabId: string) => Promise<void>
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
    if (!tab || !window?.visible) return false;
    if (whileLoading || roleIds.length === 0) return true;
    const running = await rendererCall("listRoleStatuses");
    return roleIds.every((roleId) => running.some((status) =>
      status.roleId === roleId && status.state === "running"));
  }, {
    interval: 100,
    timeout: 90_000,
    timeoutMsg: `Workspace ${workspace.name} did not reach its visible native host`
  });
  if (whileLoading) await whileLoading(tab!.id);
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
  whileDragging?: () => Promise<void>;
  gap?: number;
  delta?: number;
  axis: "horizontal" | "vertical";
  dividerIndex: number;
  mainWindowHandle: string;
  platform: "macos" | "windows";
  windowId: string;
}>): Promise<void> {
  const request = {
    whileDragging: input.whileDragging,
    axis: input.axis,
    dividerIndex: input.dividerIndex,
    expectedThickness: input.gap ?? 16
  };
  if (input.platform === "macos") {
    await dragMacosVisibleWorkspaceDivider({
      ...request,
      // Remains inside the 960x640 host while crossing Core's 5% snap even
      // when the CI display reports a scaled accessibility coordinate.
      deltaScreenPixels: input.delta ?? 192,
      windowId: input.windowId
    });
    await movePointerToMacosRuntimeContent(input.windowId);
  } else {
    const current = await electronDesktopE2eFullscreenToolbarRuntime(input.windowId);
    const bounds = current.surfaces.filter(surface => surface.visible).map(surface => surface.bounds);
    if (bounds.length === 0) throw new Error("The divider has no visible Workspace geometry");
    const extent = input.axis === "horizontal"
      ? Math.max(...bounds.map(b => b.y + b.height)) - Math.min(...bounds.map(b => b.y))
      : Math.max(...bounds.map(b => b.x + b.width)) - Math.min(...bounds.map(b => b.x));
    await dragWindowsVisibleWorkspaceDivider(input.mainWindowHandle, {
      ...request,
      // Earlier native resize cases may leave a minimum-height host. Keep the
      // Website document below its toolbar and labels available for pixel proof.
      deltaCssPixels: input.delta ?? Math.round(extent * 0.15),
      windowId: input.windowId
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
  // Saved-placement precondition keeps every native border clear of the Dock.
  await rendererCall("updateGameWindow", gameWindow.id, { placement: { ...gameWindow.placement,
    normalBounds: { ...gameWindow.placement.normalBounds, width: 960, height: 640 } } });
  await armFirstWorkspaceHost(gameWindow.id);
  const firstMainHandle = await browser.getWindowHandle();
  const launched = await captureWorkspaceTransitionFrames(platform, "first-host-opening", () => launchWorkspace(
    workspace, gameWindow, [primary.id, secondary.id], async () => undefined
  ));
  await exerciseFirstWorkspaceHost({windowId:gameWindow.id, tabId:launched.tabId,
    mainWindowHandle:firstMainHandle, platform, setAppearance:setVisibleWorkspaceGap});
  const initial = await waitForExactGap({
    gap: 1,
    primaryRoleId: primary.id,
    secondaryRoleId: secondary.id,
    tabId: launched.tabId,
    windowId: gameWindow.id
  });
  const websiteHandles = await captureWorkspaceWebsiteHandles(launched.mainWindowHandle);
  await paintWorkspaceTargets(launched.mainWindowHandle, "rgb(240,0,240)");
  await expectWorkspacePixels({ inspection: initial, tabId: launched.tabId, name: "gap-1-material", background: "material" });
  await setVisibleWorkspaceGap(1, "black");
  await expectWorkspacePixels({ inspection: await waitForExactGap({ gap: 1, primaryRoleId: primary.id,
    secondaryRoleId: secondary.id, tabId: launched.tabId, windowId: gameWindow.id }),
    tabId: launched.tabId, name: "gap-1-black", background: "black" });
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

  await expectWorkspacePixels({ inspection: updated, tabId: launched.tabId, name: "gap-16-material", background: "material" });
  await setVisibleWorkspaceGap(16, "black");
  const whileDragging = (axis: "horizontal" | "vertical") => async () => {
    await expectWorkspacePixels({ inspection: await electronDesktopE2eFullscreenToolbarRuntime(gameWindow.id),
      tabId: launched.tabId, name: `drag-${axis}`, background: "black", indicators: axis });
  };
  const beforeVertical = updated.workspaceTabs.find(
    (tab) => tab.tabId === launched.tabId
  )!;
  await dragDivider({
    whileDragging: whileDragging("vertical"),
    axis: "vertical", dividerIndex: 0,
    mainWindowHandle: launched.mainWindowHandle, platform, windowId: gameWindow.id
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
    whileDragging: whileDragging("horizontal"),
    axis: "horizontal", dividerIndex: 1,
    mainWindowHandle: launched.mainWindowHandle, platform, windowId: gameWindow.id
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

  await expectWorkspacePixels({ inspection: finalInspection!, tabId: launched.tabId, name: "gap-after-drag", background: "black" });
  // A separate website-only B fills A's gaps with a different color before native A → B → A.
  const beforeB = new Set(await browser.getWindowHandles());
  await openSection("Workspaces", "/workspaces");
  await clickWorkspaceCreateAction();
  await setEditorName("Chromium Gap Paint B");
  await clickWorkspaceSlot(0);
  await $("#workspace-slot-content").click();
  await $("[role='option']=Website").click();
  await submitEditor("/workspaces");
  let workspaceB = await findNamed<LaunchWorkspace>(() => rendererCall("listLaunchWorkspaces"), "Chromium Gap Paint B");
  const fixtureId = "workspace-gap-loading-b";
  const fixtureOrigin = required("RION_STUDIO_E2E_FIXTURE_ORIGIN");
  // A controlled fixture navigation is the precondition, while launch and tab activation remain visible UI.
  workspaceB = await rendererCall("updateLaunchWorkspace", workspaceB.id, {
    slots: workspaceB.slots.map(slot => ({ ...slot, web: { lastUrl: `${fixtureOrigin}/role/${fixtureId}` } }))
  });
  await fixtureRequest("/api/gate", { roleId: fixtureId });
  let launchedB: Awaited<ReturnType<typeof launchWorkspace>>;
  let resizedWhileLoadingWidth = 0;
  try {
    launchedB = await launchWorkspace(workspaceB, gameWindow, [], async loadingTabId => {
      const waiting = await fetch(`${fixtureOrigin}/api/gates/${fixtureId}/waiting`, { signal: AbortSignal.timeout(30_000) });
      expect(waiting.ok).toBe(true);
      if (platform === "macos") await browser.waitUntil(async () => {
        try {
          await readMacosVisibleRuntimeTabPoint({ windowId: gameWindow.id,
            tabId: loadingTabId, tabName: workspaceB.name });
          return true;
        } catch { return false; }
      }, { timeout: 20_000, timeoutMsg: "Loading tab did not appear in the native tab strip" });
      for (const selected of [loadingTabId, launched.tabId]) {
        if (platform === "macos") {
          await clickVisibleRuntimeTab({ mainWindowHandle: launched.mainWindowHandle, platform,
            tabId: selected, tabName: selected === loadingTabId ? workspaceB.name : WORKSPACE_NAME });
        } else {
          await activateWindowsRuntimeTabWhileLoading({ processId: (await electronDesktopE2eProbe()).processId,
            loadingTabName: workspaceB.name, selectedTabName: selected === loadingTabId ? workspaceB.name : WORKSPACE_NAME });
        }
        await browser.waitUntil(async () => (await rendererCall("getEmbeddedRuntimeState")).windows
          .find(window => window.id === gameWindow.id)?.activeTabId === selected,
        { timeout: 20_000, timeoutMsg: `The loading-sibling switch did not select exact tab ${selected}` });
      }
      resizedWhileLoadingWidth = await resizeWorkspaceWithLoadingSibling(gameWindow.id, launched.tabId);
      expect((await rendererCall("getEmbeddedRuntimeState")).windows.find(w => w.id === gameWindow.id)?.activeTabId).toBe(launched.tabId);
    });
  } catch (error) {
    console.error("Loading tab shell errors", await runtimeTabShellErrors());
    throw error;
  } finally { await fixtureRequest("/api/release", { roleId: fixtureId }); }
  await browser.waitUntil(async () => (await electronDesktopE2eFullscreenToolbarRuntime(gameWindow.id)).surfaces
    .some(surface => surface.tabId === launchedB.tabId), { timeout: 30_000 });
  expect((await rendererCall("getEmbeddedRuntimeState")).windows.find(w => w.id === gameWindow.id)?.activeTabId).toBe(launched.tabId);
  await clickVisibleRuntimeTab({ mainWindowHandle: launched.mainWindowHandle, platform, tabId: launchedB.tabId, tabName: workspaceB.name });
  await paintWorkspaceTargets(launched.mainWindowHandle, "rgb(0,240,240)",
    new Set((await browser.getWindowHandles()).filter(h => !beforeB.has(h))));
  await resizeActiveWebsiteTab(gameWindow.id, launchedB.tabId, resizedWhileLoadingWidth);
  for (const selected of [launched.tabId, launchedB.tabId, launched.tabId]) {
    await clickVisibleRuntimeTab({ mainWindowHandle: launched.mainWindowHandle, platform, tabId: selected,
      tabName: selected === launched.tabId ? WORKSPACE_NAME : workspaceB.name });
    await browser.waitUntil(async () => (await rendererCall("getEmbeddedRuntimeState")).windows
      .find(w => w.id === gameWindow.id)?.activeTabId === selected, { timeout: 20_000 });
  }
  const afterSwitch = await electronDesktopE2eFullscreenToolbarRuntime(gameWindow.id);
  expect(afterSwitch.surfaces.filter(s => s.tabId === launchedB.tabId).every(s => !s.visible)).toBe(true);
  await expectWorkspacePixels({ inspection: afterSwitch, tabId: launched.tabId, name: "gap-a-b-a", background: "black" });
  // Exercise both real drag axes and A → B → A for every gap/background pair.
  for (const [gap, background, delta] of [
    [1, "material", -96], [1, "black", 96],
    [16, "material", -96], [16, "black", 96]
  ] as const) {
    await setVisibleWorkspaceGap(gap, background);
    await waitForExactGap({ gap, primaryRoleId: primary.id, secondaryRoleId: secondary.id,
      tabId: launched.tabId, windowId: gameWindow.id });
    await exerciseWorkspaceResize({ windowId: gameWindow.id, tabId: launched.tabId, gap, background });
    for (const axis of ["vertical", "horizontal"] as const) {
      const before = await electronDesktopE2eFullscreenToolbarRuntime(gameWindow.id);
      await dragDivider({ axis, dividerIndex: axis === "vertical" ? 0 : 1, gap, delta,
        mainWindowHandle: launched.mainWindowHandle, platform, windowId: gameWindow.id,
        whileDragging: async () => {
          let held: ElectronDesktopE2eFullscreenToolbarRuntimeInspection | undefined;
          const beforeSlots = before.workspaceTabs.find(tab => tab.tabId === launched.tabId)!.slots;
          await browser.waitUntil(async () => {
            held = await electronDesktopE2eFullscreenToolbarRuntime(gameWindow.id);
            const slots = held.workspaceTabs.find(tab => tab.tabId === launched.tabId)?.slots;
            return held.topologyRevision > before.topologyRevision &&
              (axis === "vertical" ? slots?.[0]?.rect.width !== beforeSlots[0]!.rect.width
                : slots?.[1]?.rect.height !== beforeSlots[1]!.rect.height);
          }, { timeout: 20_000, timeoutMsg: `${axis} divider did not project its held Core slot rect` });
          await expectWorkspacePixels({ inspection: held!, tabId: launched.tabId,
            name: `matrix-${gap}-${background}-${axis}-held`, background, indicators: axis });
        } });
      await browser.waitUntil(async () => (await electronDesktopE2eFullscreenToolbarRuntime(gameWindow.id))
        .topologyRevision > before.topologyRevision, { timeout: 20_000 });
      await expectWorkspacePixels({ inspection: await electronDesktopE2eFullscreenToolbarRuntime(gameWindow.id),
        tabId: launched.tabId, name: `matrix-${gap}-${background}-${axis}-ended`, background });
    }
    for (const selected of [launchedB.tabId, launched.tabId]) {
      await clickVisibleRuntimeTab({ mainWindowHandle: launched.mainWindowHandle, platform,
        tabId: selected, tabName: selected === launched.tabId ? WORKSPACE_NAME : workspaceB.name });
      await browser.waitUntil(async () => (await rendererCall("getEmbeddedRuntimeState")).windows
        .find(w => w.id === gameWindow.id)?.activeTabId === selected, { timeout: 20_000 });
    }
    await expectWorkspacePixels({ inspection: await electronDesktopE2eFullscreenToolbarRuntime(gameWindow.id),
      tabId: launched.tabId, name: `matrix-${gap}-${background}-a-b-a`, background });
  }
  await exerciseWorkspaceWindowTransitions({ windowId: gameWindow.id, tabId: launched.tabId,
    mainWindowHandle: launched.mainWindowHandle, platform });
  await exerciseWorkspaceTransparency({ windowId: gameWindow.id, tabId: launched.tabId,
    mainWindowHandle: launched.mainWindowHandle, fixtureOrigin, handles: websiteHandles, platform,
    background: mode => setVisibleWorkspaceGap(16, mode) });
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
  expect(gameWindow.activeTabId).toBe(persistedTab!.id);

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
    // A mounts before the rest of the saved cohort. The restore operation then
    // admits B and finally restores A's saved selection; A's first geometry is
    // not the completion boundary for the whole window.
    const window = runtime.windows.find(candidate => candidate.id === gameWindow.id);
    const tabs = runtime.tabs.filter(candidate => candidate.windowId === gameWindow.id);
    return Boolean(tab) && window?.visible === true && window.activeTabId === tabId &&
      !window.projectionPending && tabs.length === gameWindow.tabs.length &&
      gameWindow.tabs.every(saved => tabs.some(live => live.id === saved.id)) &&
      !runtime.savedWindows?.some(saved => saved.id === gameWindow.id && saved.state === "restoring");
  }, { timeout: 45_000, timeoutMsg: "The saved Workspace cohort and active selection did not restore" });
  const restored = await waitForExactGap({
    gap: 16,
    primaryRoleId: primary.id,
    secondaryRoleId: secondary.id,
    tabId,
    windowId: gameWindow.id
  });
  await expectWorkspacePixels({ inspection: restored, tabId, name: "gap-restart", background: "black" });
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
