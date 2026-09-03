import { $, browser, expect } from "@wdio/globals";

import type {
  EmbeddedRuntimeState,
  GameWindow,
  LaunchWorkspace,
  LaunchWorkspaceSlot,
  Role,
  RoleStatus
} from "../../../src/shared/types";
import {
  electronDesktopE2eProbe,
  electronDesktopE2eRoleSessionRuntime,
  electronDesktopE2eWorkspaceWebRuntime,
  type ElectronDesktopE2eWorkspaceWebRuntimeInspection
} from "../support/electron-driver";
import { dragWindowsVisibleWorkspaceDivider } from
  "../support/electron-role-surface";
import { fixtureEvents, waitFixtureEvent } from "../support/fixture";
import { dragMacosVisibleWorkspaceDivider } from
  "../support/macos-appkit-ui";
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

// [journey:CHROMIUM-MACOS-APPKIT-WORKSPACE-WEB-SLOT-016]
// [journey:CHROMIUM-WINDOWS-WORKSPACE-WEB-SLOT-016]

const ROLE_NAME = "Chromium Entity Role Edited";
const WORKSPACE_NAME = "Chromium Workspace Web Slot";
const WINDOW_NAME = "Chromium Workspace Web Window";
const WEB_NAME = "Chromium Workspace Web fixture";
const WEB_FIXTURE_ID = "chromium-workspace-web-slot";
const WEB_SESSION_MARKER = "chromium-workspace-web-slot-marker";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the Workspace Web journey`);
  return value;
}

function configuredWebUrl(): string {
  const url = new URL(
    `/role/${WEB_FIXTURE_ID}`,
    required("RION_STUDIO_E2E_FIXTURE_ORIGIN")
  );
  url.searchParams.set("mode", "seed");
  url.searchParams.set("marker", WEB_SESSION_MARKER);
  return url.href;
}

async function preparePhase(): Promise<"macos" | "windows"> {
  const probe = await electronDesktopE2eProbe();
  expect(probe.runtimeTarget).toBe(required("RION_STUDIO_E2E_RUNTIME_TARGET"));
  expect(probe.driver).toBe("electron");
  await ensureEnglishUi();
  await acceptLegalAndSkipFirstRun();
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

async function findRole(): Promise<Role> {
  let role: Role | undefined;
  await browser.waitUntil(async () => {
    role = (await rendererCall("listRoles"))
      .find((candidate) => candidate.name === ROLE_NAME);
    return role !== undefined;
  }, { timeout: 15_000, timeoutMsg: `Did not find dependency Role ${ROLE_NAME}` });
  return role!;
}

async function findWorkspace(): Promise<LaunchWorkspace> {
  let workspace: LaunchWorkspace | undefined;
  await browser.waitUntil(async () => {
    workspace = (await rendererCall("listLaunchWorkspaces"))
      .find((candidate) => candidate.name === WORKSPACE_NAME);
    return workspace !== undefined;
  }, { timeout: 15_000, timeoutMsg: `Did not find Workspace ${WORKSPACE_NAME}` });
  return workspace!;
}

async function findSavedWindow(): Promise<GameWindow> {
  let gameWindow: GameWindow | undefined;
  await browser.waitUntil(async () => {
    gameWindow = (await rendererCall("listGameWindows"))
      .find((candidate) => candidate.name === WINDOW_NAME);
    return gameWindow !== undefined;
  }, {
    timeout: 15_000,
    timeoutMsg: `Did not find saved Game Window ${WINDOW_NAME}`
  });
  return gameWindow!;
}

async function createSavedWindowThroughVisibleUi(): Promise<GameWindow> {
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
    timeoutMsg: "Visible UI did not create a saved Game Window"
  });
  const row = await $(`[data-selection-id='${created!.id}']`);
  await row.waitForDisplayed({ timeout: 10_000 });
  const actions = await row.$("button[aria-label='Game window actions']");
  await actions.waitForClickable({ timeout: 10_000 });
  await actions.click();
  const rename = await $("[role='menuitem']=Rename");
  await rename.waitForClickable({ timeout: 10_000 });
  await rename.click();
  await setInputValue("#rename-game-window-name", WINDOW_NAME);
  const dialog = await $("dialog[open]");
  const save = await dialog.$("button=Save");
  await save.waitForClickable({ timeout: 10_000 });
  await save.click();
  return findSavedWindow();
}

async function createWorkspaceThroughVisibleSlotControls(
  role: Role
): Promise<LaunchWorkspace> {
  await openSection("Workspaces", "/workspaces");
  await clickWorkspaceCreateAction();
  await waitForRoute("/workspaces/new");
  await setEditorName(WORKSPACE_NAME);

  await $("#workspace-slot-content").click();
  await $("[role='option']=Web app").click();
  const preset = await $("[data-workspace-web-preset-select]");
  await preset.waitForClickable({ timeout: 10_000 });
  await preset.click();
  const youtube = await $("[role='option'][data-workspace-web-preset='youtube']");
  await youtube.waitForDisplayed({ timeout: 10_000 });
  await youtube.click();
  await browser.waitUntil(async () =>
    await $("#workspace-web-name").getValue() === "YouTube" &&
    await $("#workspace-web-url").getValue() === "https://www.youtube.com/" &&
    await preset.getText() === "YouTube", {
    timeout: 10_000,
    timeoutMsg: "The visible popular-site menu did not apply the YouTube preset"
  });
  await setInputValue("#workspace-web-name", WEB_NAME);
  await setInputValue("#workspace-web-url", configuredWebUrl());

  await $("[data-workspace-slot-index='1']").click();
  await $("#workspace-slot-content").click();
  await $("[role='option']=Role").click();
  await $(`[data-workspace-role-id='${role.id}']`).click();
  await submitEditor("/workspaces");
  const workspace = await findWorkspace();
  expect(workspace.slots).toHaveLength(2);
  expect(workspace.slots).toEqual(expect.arrayContaining([
    expect.objectContaining({ web: { name: WEB_NAME, startUrl: configuredWebUrl() } }),
    expect.objectContaining({ roleId: role.id })
  ]));
  return workspace;
}

async function launchWorkspaceThroughVisibleUi(
  workspace: LaunchWorkspace,
  role: Role,
  gameWindow: GameWindow
): Promise<Readonly<{ mainWindowHandle: string; tabId: string; windowId: string }>> {
  const mainWindowHandle = await browser.getWindowHandle();
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

  let runtime: EmbeddedRuntimeState | undefined;
  let status: RoleStatus | undefined;
  let tab: EmbeddedRuntimeState["tabs"][number] | undefined;
  await browser.waitUntil(async () => {
    status = (await rendererCall("listRoleStatuses"))
      .find((candidate) => candidate.roleId === role.id);
    runtime = await rendererCall("getEmbeddedRuntimeState");
    tab = runtime.tabs.find((candidate) =>
      candidate.type === "workspace" && candidate.sourceId === workspace.id &&
      candidate.roleIds.includes(role.id) && candidate.windowId === gameWindow.id
    );
    return status?.state === "running" && Boolean(tab) &&
      runtime.windows.some((window) => window.id === tab?.windowId && window.visible);
  }, {
    interval: 100,
    timeout: 45_000,
    timeoutMsg: "The mixed Workspace did not reach its visible Chromium host"
  });
  expect(status?.resolvedEngine).toBe("chromium");
  expect(tab?.windowId).toBe(gameWindow.id);
  return { mainWindowHandle, tabId: tab!.id, windowId: tab!.windowId };
}

async function showSavedWorkspaceThroughVisibleUi(
  workspace: LaunchWorkspace,
  role: Role,
  gameWindow: GameWindow
): Promise<Readonly<{ mainWindowHandle: string; tabId: string; windowId: string }>> {
  const mainWindowHandle = await browser.getWindowHandle();
  const current = await rendererCall("getEmbeddedRuntimeState");
  const alreadyVisible = current.windows.some(
    (window) => window.id === gameWindow.id && window.visible
  );
  if (!alreadyVisible) {
    await openSection("Windows", "/game-windows");
    const row = await $(`[data-selection-id='${gameWindow.id}']`);
    await row.waitForDisplayed({ timeout: 10_000 });
    const show = await row.$("button[aria-label='Show']");
    await show.waitForClickable({ timeout: 10_000 });
    await show.click();
  }
  let tab: EmbeddedRuntimeState["tabs"][number] | undefined;
  await browser.waitUntil(async () => {
    const [statuses, runtime] = await Promise.all([
      rendererCall("listRoleStatuses"),
      rendererCall("getEmbeddedRuntimeState")
    ]);
    tab = runtime.tabs.find((candidate) =>
      candidate.type === "workspace" && candidate.sourceId === workspace.id &&
      candidate.roleIds.includes(role.id) && candidate.windowId === gameWindow.id
    );
    const status = statuses.find((candidate) => candidate.roleId === role.id);
    return status?.state === "running" && Boolean(tab) &&
      runtime.windows.some((window) =>
        window.id === gameWindow.id && window.visible
      );
  }, {
    interval: 100,
    timeout: 45_000,
    timeoutMsg: "The saved mixed Workspace did not restore into its Game Window"
  });
  return { mainWindowHandle, tabId: tab!.id, windowId: gameWindow.id };
}

function expectExactPlatformHost(
  inspection: ElectronDesktopE2eWorkspaceWebRuntimeInspection,
  platform: "macos" | "windows"
): void {
  expect(inspection.hostKind).toBe(
    platform === "macos" ? "appkit-chromium" : "bundled-chromium"
  );
  expect(inspection.parentNativeHostId).toBeGreaterThan(0);
  expect(inspection.windowGeneration).toBeGreaterThan(0);
  expect(inspection.topologyRevision).toBeGreaterThan(0);
  expect(inspection.visible).toBe(true);
  if (platform === "macos") {
    expect(inspection.appKitIdentity).toEqual({
      launchGeneration: inspection.attemptGeneration,
      logicalWindowId: inspection.windowId,
      nativeGeneration: inspection.appKitIdentity?.nativeGeneration
    });
    expect(inspection.appKitIdentity?.nativeGeneration).toBeGreaterThan(0);
  } else {
    expect(inspection.appKitIdentity).toBeNull();
  }
}

async function expectExactSessionsAndLayout(input: Readonly<{
  inspection: ElectronDesktopE2eWorkspaceWebRuntimeInspection;
  platform: "macos" | "windows";
  role: Role;
  slots: readonly LaunchWorkspaceSlot[];
}>): Promise<void> {
  const { inspection, platform, role, slots } = input;
  expectExactPlatformHost(inspection, platform);
  expect(inspection.web).toEqual(expect.objectContaining({
    chromeShellSession: "rion-web-chrome-shell:memory",
    chromeShellStoragePath: null,
    contentSession: "global-web-persistent",
    contentSessionStoragePath: inspection.web.contentProfilePath,
    contentUrl: configuredWebUrl(),
    isolatedSessions: true,
    tabId: inspection.tabId,
    visible: true
  }));
  expect(inspection.web.contentProfilePath.replaceAll("\\", "/"))
    .toMatch(/\/web-profiles\/global-web\/chromium$/u);
  expect(inspection.web.chromeShellUrl)
    .toMatch(/\/runtime-web-chrome-electron\.html$/u);
  expect(inspection.web.chromeBounds.height + inspection.web.contentBounds.height)
    .toBe(inspection.web.slotBounds.height);
  expect(inspection.web.contentBounds.y)
    .toBe(inspection.web.chromeBounds.y + inspection.web.chromeBounds.height);
  expect(inspection.coreSlots).toEqual(expect.arrayContaining([
    expect.objectContaining({
      id: inspection.web.slotId,
      web: { name: WEB_NAME, startUrl: configuredWebUrl() }
    }),
    expect.objectContaining({ roleId: role.id, web: null })
  ]));
  for (const persisted of slots) {
    const authoritative = inspection.coreSlots.find((slot) => slot.id === persisted.id);
    expect(authoritative).toBeDefined();
    expect(authoritative!.rect.x).toBeCloseTo(persisted.rect.x, 12);
    expect(authoritative!.rect.y).toBeCloseTo(persisted.rect.y, 12);
    expect(authoritative!.rect.width).toBeCloseTo(persisted.rect.width, 12);
    expect(authoritative!.rect.height).toBeCloseTo(persisted.rect.height, 12);
    expect(authoritative?.roleId).toBe(persisted.roleId ?? null);
    expect(authoritative?.web).toEqual(persisted.web ?? null);
  }

  const roleRuntime = await electronDesktopE2eRoleSessionRuntime(role.id);
  expect(roleRuntime.currentRuntime).toEqual(expect.objectContaining({
    tabId: inspection.tabId,
    windowId: inspection.windowId
  }));
  expect(roleRuntime.latestSessionEnsure.sessionStoragePath)
    .not.toBe(inspection.web.contentProfilePath);
  expect(roleRuntime.latestSessionEnsure.sessionStoragePath.replaceAll("\\", "/")
    .toLowerCase()).toMatch(
    new RegExp(`/roles/${role.id}/browser/chromium$`, "u")
  );
}

async function waitForWebSession(expectedBefore: string | null): Promise<void> {
  const session = await waitFixtureEvent({
    afterSequence: 0,
    kind: "session",
    roleId: WEB_FIXTURE_ID
  });
  expect(session.session).toEqual({
    after: { cookie: WEB_SESSION_MARKER, localStorage: WEB_SESSION_MARKER },
    before: { cookie: expectedBefore, localStorage: expectedBefore },
    marker: WEB_SESSION_MARKER,
    mode: "seed"
  });
}

async function dragVisibleNativeDivider(input: Readonly<{
  before: ElectronDesktopE2eWorkspaceWebRuntimeInspection;
  mainWindowHandle: string;
  platform: "macos" | "windows";
}>): Promise<ElectronDesktopE2eWorkspaceWebRuntimeInspection> {
  if (input.platform === "macos") {
    await dragMacosVisibleWorkspaceDivider();
  } else {
    await dragWindowsVisibleWorkspaceDivider(input.mainWindowHandle);
  }
  let after: ElectronDesktopE2eWorkspaceWebRuntimeInspection | undefined;
  const beforeWebSlot = input.before.coreSlots.find((slot) => slot.web !== null)!;
  await browser.waitUntil(async () => {
    try {
      const candidate = await electronDesktopE2eWorkspaceWebRuntime(input.before.windowId);
      const webSlot = candidate.coreSlots.find((slot) => slot.web !== null);
      if (!webSlot || candidate.topologyRevision <= input.before.topologyRevision ||
          webSlot.rect.width <= beforeWebSlot.rect.width + 0.03 ||
          candidate.web.slotBounds.width <= input.before.web.slotBounds.width + 20) {
        return false;
      }
      after = candidate;
      return true;
    } catch {
      return false;
    }
  }, {
    interval: 100,
    timeout: 20_000,
    timeoutMsg: "The real native divider drag did not advance authoritative layout"
  });
  return after!;
}

async function waitForPersistedGameWindowLayout(
  inspection: ElectronDesktopE2eWorkspaceWebRuntimeInspection,
  windowId: string
): Promise<Readonly<{
  gameWindow: GameWindow;
  inspection: ElectronDesktopE2eWorkspaceWebRuntimeInspection;
  slots: readonly LaunchWorkspaceSlot[];
}>> {
  let settledInspection = inspection;
  let gameWindow: GameWindow | undefined;
  let slots: readonly LaunchWorkspaceSlot[] | undefined;
  try {
    await browser.waitUntil(async () => {
      const candidateWindow = (await rendererCall("listGameWindows"))
        .find((candidate) => candidate.id === windowId);
      const candidateTab = candidateWindow?.tabs.find(
        (tab) => tab.id === inspection.tabId
      );
      if (!candidateWindow || !candidateTab?.workspaceSlots) return false;
      const candidateInspection = await electronDesktopE2eWorkspaceWebRuntime(
        inspection.windowId
      );
      gameWindow = candidateWindow;
      slots = candidateTab.workspaceSlots;
      settledInspection = candidateInspection;
      return candidateTab.workspaceSlots.length === candidateInspection.coreSlots.length &&
        candidateTab.workspaceSlots.every((persisted) => {
          const authoritative = candidateInspection.coreSlots.find(
            (slot) => slot.id === persisted.id
          );
          return authoritative !== undefined &&
            Math.abs(authoritative.rect.x - persisted.rect.x) <= 1e-12 &&
            Math.abs(authoritative.rect.y - persisted.rect.y) <= 1e-12 &&
            Math.abs(authoritative.rect.width - persisted.rect.width) <= 1e-12 &&
            Math.abs(authoritative.rect.height - persisted.rect.height) <= 1e-12 &&
            authoritative.roleId === (persisted.roleId ?? null) &&
            authoritative.web?.name === persisted.web?.name &&
            authoritative.web?.startUrl === persisted.web?.startUrl;
        });
    }, {
      interval: 100,
      timeout: 20_000,
      timeoutMsg: "The native divider end did not persist its exact saved-window layout"
    });
  } catch {
    throw new Error(
      "The native divider end did not persist an exact saved-window layout: " +
      `saved=${JSON.stringify(slots)} core=${JSON.stringify(settledInspection.coreSlots)}`
    );
  }
  return {
    gameWindow: gameWindow!,
    inspection: settledInspection,
    slots: slots!
  };
}

async function seedPhase(platform: "macos" | "windows"): Promise<void> {
  const role = await findRole();
  const workspace = await createWorkspaceThroughVisibleSlotControls(role);
  const gameWindow = await createSavedWindowThroughVisibleUi();
  const launched = await launchWorkspaceThroughVisibleUi(
    workspace,
    role,
    gameWindow
  );
  await waitForWebSession(null);
  const before = await electronDesktopE2eWorkspaceWebRuntime(launched.windowId);
  expect(before.tabId).toBe(launched.tabId);
  await expectExactSessionsAndLayout({
    inspection: before,
    platform,
    role,
    slots: workspace.slots
  });
  const after = await dragVisibleNativeDivider({
    before,
    mainWindowHandle: launched.mainWindowHandle,
    platform
  });
  const settled = await waitForPersistedGameWindowLayout(after, gameWindow.id);
  await expectExactSessionsAndLayout({
    inspection: settled.inspection,
    platform,
    role,
    slots: settled.slots
  });
}

async function restartPhase(platform: "macos" | "windows"): Promise<void> {
  const role = await findRole();
  const workspace = await findWorkspace();
  const gameWindow = await findSavedWindow();
  const persistedTab = gameWindow.tabs.find((tab) =>
    tab.tabType === "workspace" && tab.sourceId === workspace.id
  );
  const persistedSlots = persistedTab?.workspaceSlots;
  const webSlot = persistedSlots?.find((slot) => slot.web !== undefined);
  expect(webSlot?.web).toEqual({ name: WEB_NAME, startUrl: configuredWebUrl() });
  expect(webSlot?.rect.width).toBeGreaterThan(0.53);
  expect(persistedTab?.id).toBeTruthy();
  const launched = await showSavedWorkspaceThroughVisibleUi(
    workspace,
    role,
    gameWindow
  );
  await browser.waitUntil(async () => {
    const sessions = (await fixtureEvents({ afterSequence: 0, roleId: WEB_FIXTURE_ID }))
      .filter((event) => event.kind === "session" && event.session?.mode === "seed");
    return sessions.some((event) =>
      event.session?.before?.cookie === WEB_SESSION_MARKER &&
      event.session.before.localStorage === WEB_SESSION_MARKER
    );
  }, {
    interval: 100,
    timeout: 20_000,
    timeoutMsg: "The persistent global-Web Chromium session was not restored"
  });
  const restored = await electronDesktopE2eWorkspaceWebRuntime(launched.windowId);
  await expectExactSessionsAndLayout({
    inspection: restored,
    platform,
    role,
    slots: persistedSlots!
  });
  expect(restored.coreSlots.find((slot) => slot.web !== null)?.rect.width)
    .toBeGreaterThan(0.53);
}

describe("Chromium Workspace Web slot exact replacement", () => {
  it("keeps paired Web sessions, native divider layout, and restart persistence exact", async () => {
    const platform = await preparePhase();
    const phase = required("RION_STUDIO_E2E_PHASE");
    if (phase === "chromium-workspace-web-slot-seed") await seedPhase(platform);
    else if (phase === "chromium-workspace-web-slot-restart") {
      await restartPhase(platform);
    } else {
      throw new Error(`Unexpected Workspace Web journey phase ${phase}`);
    }
  });
});
