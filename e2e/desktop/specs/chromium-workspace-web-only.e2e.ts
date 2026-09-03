import { $, browser, expect } from "@wdio/globals";

import type { EmbeddedRuntimeTabSummary, GameWindow, LaunchWorkspace } from
  "../../../src/shared/types";
import {
  electronDesktopE2eProbe,
  electronDesktopE2eWorkspaceWebRuntime
} from "../support/electron-driver";
import { navigateVisibleElectronWorkspaceWebChrome } from
  "../support/electron-role-surface";
import { fixtureCursor, fixtureRequest, waitFixtureEvent } from
  "../support/fixture";
import {
  clickVisibleRuntimeTab,
  closeVisibleRuntimeTab,
  visibleRuntimeTabPhase
} from "../support/native-runtime-tabs";
import { rendererCall } from "../support/renderer-bridge";
import {
  acceptLegalAndSkipFirstRun,
  clickWorkspaceCreateAction,
  ensureEnglishUi,
  setEditorName,
  setInputValue,
  submitEditor,
  waitForRoute
} from "../support/ui";

// [journey:CHROMIUM-MACOS-APPKIT-WORKSPACE-WEB-ONLY-024]
// [journey:CHROMIUM-WINDOWS-WORKSPACE-WEB-ONLY-024]

const WORKSPACE_NAME = "Chromium Web Only Workspace";
const WEB_NAME = "Chromium Web Only App";
const FIXTURE_ID = "chromium-workspace-web-only";
const SESSION_MARKER = "chromium-workspace-web-only-session";
const TERMINAL_NAVIGATION_FAILURE_URL = "http://127.0.0.1:1/rion-navigation-failure";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the Web-only journey`);
  return value;
}

function webUrl(): string {
  const url = new URL(`/role/${FIXTURE_ID}`, required(
    "RION_STUDIO_E2E_FIXTURE_ORIGIN"
  ));
  url.searchParams.set("marker", SESSION_MARKER);
  url.searchParams.set("mode", "seed");
  return url.href;
}

async function openSection(label: string, route: string): Promise<void> {
  const sidebar = await $(".app-main-sidebar");
  await sidebar.waitForDisplayed({ timeout: 20_000 });
  const button = await sidebar.$(`button*=${label}`);
  await button.waitForClickable({ timeout: 10_000 });
  await button.click();
  await waitForRoute(route);
}

async function prepare(): Promise<Readonly<{
  mainWindowHandle: string;
  platform: "macos" | "windows";
}>> {
  const probe = await electronDesktopE2eProbe();
  expect(probe.runtimeTarget).toBe(required("RION_STUDIO_E2E_RUNTIME_TARGET"));
  await ensureEnglishUi();
  await acceptLegalAndSkipFirstRun();
  return Object.freeze({
    mainWindowHandle: await browser.getWindowHandle(),
    platform: probe.platform
  });
}

async function findWorkspace(): Promise<LaunchWorkspace> {
  let workspace: LaunchWorkspace | undefined;
  await browser.waitUntil(async () => {
    workspace = (await rendererCall("listLaunchWorkspaces")).find(
      (candidate) => candidate.name === WORKSPACE_NAME
    );
    return workspace !== undefined;
  }, { timeout: 15_000, timeoutMsg: "The Web-only Workspace is unavailable" });
  return workspace!;
}

async function createWorkspace(): Promise<LaunchWorkspace> {
  await openSection("Workspaces", "/workspaces");
  await clickWorkspaceCreateAction();
  await waitForRoute("/workspaces/new");
  await setEditorName(WORKSPACE_NAME);
  await $("#workspace-layout").click();
  await $("[data-workspace-layout-option='single']").click();
  await $("#workspace-slot-content").click();
  await $("[role='option']=Web app").click();
  await setInputValue("#workspace-web-name", WEB_NAME);
  await setInputValue("#workspace-web-url", webUrl());
  await submitEditor("/workspaces");
  const workspace = await findWorkspace();
  expect(workspace).toEqual(expect.objectContaining({
    name: WORKSPACE_NAME,
    template: "single"
  }));
  expect(workspace.slots).toHaveLength(1);
  expect(workspace.slots[0]).toEqual(expect.objectContaining({
    web: { name: WEB_NAME, startUrl: webUrl() }
  }));
  expect(workspace.slots[0]).not.toHaveProperty("roleId");
  return workspace;
}

async function createSavedWindow(): Promise<GameWindow> {
  await openSection("Windows", "/game-windows");
  const before = new Set(
    (await rendererCall("listGameWindows")).map((window) => window.id)
  );
  const create = await $("button=New game window");
  await create.waitForClickable({ timeout: 10_000 });
  await create.click();
  let created: GameWindow | undefined;
  await browser.waitUntil(async () => {
    created = (await rendererCall("listGameWindows"))
      .find((candidate) => !before.has(candidate.id));
    return created !== undefined;
  }, {
    timeout: 15_000,
    timeoutMsg: "Visible UI did not create a saved Web-only Game Window"
  });
  return created!;
}

async function openWorkspace(
  workspace: LaunchWorkspace,
  gameWindow: GameWindow
): Promise<void> {
  await openSection("Home", "/dashboard");
  const quickAccess = await $("[data-testid='quick-access-trigger']");
  await quickAccess.waitForClickable({ timeout: 10_000 });
  await quickAccess.click();
  const palette = await $("[data-testid='quick-access-palette'][open]");
  await palette.waitForDisplayed({ timeout: 10_000 });
  await setInputValue(
    "[data-testid='quick-access-palette'][open] input[role='combobox']",
    workspace.name
  );
  const option = await $(`#quick-access-option-workspace-${workspace.id}`);
  await option.waitForDisplayed({ timeout: 10_000 });
  const destinations = await $(
    `[data-testid='quick-access-destination-workspace-${workspace.id}']`
  );
  await destinations.waitForClickable({ timeout: 10_000 });
  await destinations.click();
  const savedWindow = await $(
    `[data-testid='quick-access-destination-option-window-${gameWindow.id}']`
  );
  await savedWindow.waitForClickable({ timeout: 10_000 });
  await savedWindow.click();
}

async function openWorkspaceFromCard(workspace: LaunchWorkspace): Promise<void> {
  await openSection("Workspaces", "/workspaces");
  const card = await $(`[data-selection-id='${workspace.id}']`);
  await card.waitForDisplayed({ timeout: 10_000 });
  await card.scrollIntoView({ block: "center", inline: "center" });
  await card.moveTo();
  const open = await card.$("button[aria-label='Open workspace']");
  await open.waitForDisplayed({ timeout: 10_000 });
  await open.waitForClickable({ timeout: 10_000 });
  await open.click();
}

async function showSavedWindow(gameWindow: GameWindow): Promise<void> {
  await openSection("Windows", "/game-windows");
  const show = await $(
    `[data-selection-id='${gameWindow.id}'] button[aria-label='Show']`
  );
  await show.waitForClickable({ timeout: 10_000 });
  await show.click();
}

async function runtimeTab(
  workspace: LaunchWorkspace,
  windowId: string
): Promise<EmbeddedRuntimeTabSummary> {
  let tab: EmbeddedRuntimeTabSummary | undefined;
  await browser.waitUntil(async () => {
    tab = (await rendererCall("getEmbeddedRuntimeState")).tabs.find(
      (candidate) => candidate.type === "workspace" &&
        candidate.sourceId === workspace.id && candidate.windowId === windowId
    );
    return tab !== undefined;
  }, { timeout: 45_000, timeoutMsg: "The Web-only runtime tab is unavailable" });
  return tab!;
}

async function waitFixturePath(path: string): Promise<void> {
  const response = await fetch(
    `${required("RION_STUDIO_E2E_FIXTURE_ORIGIN")}${path}`,
    { signal: AbortSignal.timeout(55_000) }
  );
  if (!response.ok) throw new Error(`Fixture path ${path} failed with ${response.status}`);
}

async function waitInspectionPhase(
  windowId: string,
  phase: "degraded" | "ready"
) {
  let inspection: Awaited<ReturnType<
    typeof electronDesktopE2eWorkspaceWebRuntime
  >> | undefined;
  await browser.waitUntil(async () => {
    try {
      inspection = await electronDesktopE2eWorkspaceWebRuntime(windowId);
      return inspection.phase === phase;
    } catch {
      return false;
    }
  }, {
    interval: 100,
    timeout: 45_000,
    timeoutMsg: `Workspace Web did not reach authoritative ${phase}`
  });
  return inspection!;
}

function expectExactWebOnly(
  inspection: Awaited<ReturnType<typeof electronDesktopE2eWorkspaceWebRuntime>>,
  platform: "macos" | "windows"
): void {
  expect(inspection).toEqual(expect.objectContaining({
    hostKind: platform === "macos" ? "appkit-chromium" : "bundled-chromium",
    role: null,
    visible: true
  }));
  expect(inspection.coreSlots).toEqual([expect.objectContaining({
    roleId: null,
    web: { name: WEB_NAME, startUrl: webUrl() }
  })]);
  expect(inspection.web).toEqual(expect.objectContaining({
    chromeShellSession: "rion-web-chrome-shell:memory",
    chromeShellStoragePath: null,
    contentSession: "global-web-persistent",
    contentSessionStoragePath: inspection.web.contentProfilePath,
    isolatedSessions: true,
    visible: true
  }));
  expect(inspection.web.contentProfilePath.replaceAll("\\", "/").toLowerCase())
    .toMatch(/\/web-profiles\/global-web\/chromium$/u);
  expect(inspection.web.chromeShellUrl)
    .toMatch(/\/runtime-web-chrome-electron\.html$/u);
  if (platform === "macos") {
    expect(inspection.appKitIdentity).toEqual(expect.objectContaining({
      launchGeneration: inspection.attemptGeneration,
      logicalWindowId: inspection.windowId
    }));
  } else {
    expect(inspection.appKitIdentity).toBeNull();
  }
}

async function seed(input: Awaited<ReturnType<typeof prepare>>): Promise<void> {
  const workspace = await createWorkspace();
  const gameWindow = await createSavedWindow();
  const sessionCursor = await fixtureCursor();
  await fixtureRequest("/api/gate", { roleId: FIXTURE_ID });
  const tab = await (async () => {
    try {
      await openWorkspace(workspace, gameWindow);
      await waitFixturePath(`/api/gates/${FIXTURE_ID}/waiting`);
      const pendingTab = await runtimeTab(workspace, gameWindow.id);
      expect(pendingTab.roleIds).toEqual([]);
      expect(pendingTab.slots).toEqual([]);
      expect(await visibleRuntimeTabPhase({
        mainWindowHandle: input.mainWindowHandle,
        platform: input.platform,
        tabId: pendingTab.id,
        tabName: workspace.name,
        windowId: pendingTab.windowId
      })).toBe("loading");
      return pendingTab;
    } finally {
      await fixtureRequest("/api/release", { roleId: FIXTURE_ID });
    }
  })();
  const session = await waitFixtureEvent({
    afterSequence: sessionCursor,
    kind: "session",
    roleId: FIXTURE_ID
  });
  expect(session.session).toMatchObject({
    after: { cookie: SESSION_MARKER, localStorage: SESSION_MARKER },
    marker: SESSION_MARKER,
    mode: "seed"
  });
  const ready = await waitInspectionPhase(tab.windowId, "ready");
  expectExactWebOnly(ready, input.platform);
  expect(await rendererCall("listRoleStatuses")).toEqual([]);

  await openWorkspaceFromCard(workspace);
  const duplicateTabs = (await rendererCall("getEmbeddedRuntimeState")).tabs.filter(
    (candidate) => candidate.sourceId === workspace.id
  );
  expect(duplicateTabs).toEqual([expect.objectContaining({ id: tab.id })]);

  await navigateVisibleElectronWorkspaceWebChrome(
    ready.web.chromeShellUrl,
    input.mainWindowHandle,
    TERMINAL_NAVIGATION_FAILURE_URL
  );
  const degraded = await waitInspectionPhase(tab.windowId, "degraded");
  expectExactWebOnly(degraded, input.platform);
  await closeVisibleRuntimeTab({
    mainWindowHandle: input.mainWindowHandle,
    platform: input.platform,
    tabId: tab.id,
    tabName: workspace.name,
    windowId: tab.windowId
  });
  await browser.waitUntil(async () => !(await rendererCall(
    "getEmbeddedRuntimeState"
  )).tabs.some((candidate) => candidate.id === tab.id), {
    timeout: 30_000,
    timeoutMsg: "The visible native close did not retire the Web-only tab"
  });

  await browser.waitUntil(async () => {
    const saved = (await rendererCall("listGameWindows")).find(
      (candidate) => candidate.id === gameWindow.id
    );
    return saved?.tabs.some((candidate) => candidate.id === tab.id) ?? false;
  }, {
    timeout: 15_000,
    timeoutMsg: "The closed Web-only tab did not become saved dormant topology"
  });
  await showSavedWindow(gameWindow);
  const reopened = await runtimeTab(workspace, gameWindow.id);
  expect(reopened.id).toBe(tab.id);
  const recovered = await waitInspectionPhase(reopened.windowId, "ready");
  expectExactWebOnly(recovered, input.platform);
  expect(recovered.attemptGeneration).not.toBe(degraded.attemptGeneration);
  expect(recovered.web.surfaceId).toBe(degraded.web.surfaceId);
  expect(recovered.web.generation).toBeGreaterThan(degraded.web.generation);
  let saved: GameWindow | undefined;
  await browser.waitUntil(async () => {
    saved = (await rendererCall("listGameWindows")).find(
      (window) => window.id === reopened.windowId
    );
    return saved?.tabs.some((candidate) => candidate.id === reopened.id) ?? false;
  }, {
    timeout: 15_000,
    timeoutMsg: "The recovered Web-only tab was not committed to its saved window"
  });
  expect(saved!.tabs).toEqual([expect.objectContaining({
    id: reopened.id,
    roleSlots: [],
    sourceId: workspace.id,
    workspaceSlots: workspace.slots
  })]);
}

async function restart(input: Awaited<ReturnType<typeof prepare>>): Promise<void> {
  const workspace = await findWorkspace();
  const saved = (await rendererCall("listGameWindows")).find((window) =>
    window.tabs.some((tab) => tab.sourceId === workspace.id)
  );
  const savedTab = saved?.tabs.find((tab) => tab.sourceId === workspace.id);
  if (!saved || !savedTab) throw new Error("The saved Web-only tab was not restored");
  expect(savedTab.roleSlots).toEqual([]);
  expect(savedTab.workspaceSlots).toEqual(workspace.slots);

  const sessionCursor = await fixtureCursor();
  const alreadyVisible = (await rendererCall("getEmbeddedRuntimeState")).windows.some(
    (window) => window.windowId === saved.id && window.visible
  );
  if (!alreadyVisible) await showSavedWindow(saved);
  const restoredTab = await runtimeTab(workspace, saved.id);
  expect(restoredTab.id).toBe(savedTab.id);
  const restored = await waitInspectionPhase(saved.id, "ready");
  expect(restored.tabId).toBe(savedTab.id);
  expectExactWebOnly(restored, input.platform);
  await clickVisibleRuntimeTab({
    mainWindowHandle: input.mainWindowHandle,
    platform: input.platform,
    tabId: savedTab.id,
    tabName: savedTab.name
  });
  const session = await waitFixtureEvent({
    afterSequence: sessionCursor,
    kind: "session",
    roleId: FIXTURE_ID
  });
  expect(session.session?.before).toEqual({
    cookie: SESSION_MARKER,
    localStorage: SESSION_MARKER
  });
}

describe("Chromium Web-only Workspace exact replacement", () => {
  it("keeps empty Role topology, visible failure recovery, and restart persistence exact", async () => {
    const input = await prepare();
    const phase = required("RION_STUDIO_E2E_PHASE");
    if (phase === "chromium-workspace-web-only-seed") await seed(input);
    else if (phase === "chromium-workspace-web-only-restart") await restart(input);
    else throw new Error(`Unexpected Web-only phase ${phase}`);
  });
});
