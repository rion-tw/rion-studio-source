import { $, browser, expect } from "@wdio/globals";

import type {
  EmbeddedRuntimeTabSummary,
  LaunchWorkspace
} from "../../../src/shared/types";
import {
  probe,
  rendererCall,
  requireEnvironment,
  runtimeUiAction,
  waitEvent,
  windowSnapshot
} from "../support/control";
import { fixtureCursor, waitFixtureEvent } from "../support/fixture";
import {
  navigate,
  setEditorName,
  submitEditor,
  waitForRoute
} from "../support/ui";

export const WEB_ONLY_WORKSPACE_NAME = "E2E Web Only Workspace";
export const WEB_SESSION_MARKER = "e2e-global-web-session";

const WEB_ONLY_FIXTURE_ID = "e2e-workspace-web-only";

function webOnlyUrl(): string {
  return `${requireEnvironment("RION_STUDIO_E2E_FIXTURE_ORIGIN")}/role/${WEB_ONLY_FIXTURE_ID}?mode=seed&marker=${WEB_SESSION_MARKER}`;
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

async function waitForFixturePath(path: string): Promise<void> {
  const response = await fetch(
    `${requireEnvironment("RION_STUDIO_E2E_FIXTURE_ORIGIN")}${path}`,
    { signal: AbortSignal.timeout(45_000) }
  );
  if (!response.ok) throw new Error(`Fixture ${path} failed with ${response.status}`);
}

async function waitForFixtureNavigation(roleId: string): Promise<void> {
  await waitForFixturePath(`/api/gates/${roleId}/waiting`);
}

async function waitForWindowsTabStatus(
  afterSequence: number,
  presentation: "hidden" | "loading",
  windowId: string
): Promise<void> {
  if (process.platform !== "win32") return;
  await waitEvent({
    afterSequence,
    kind: `runtime-tab-status-presentation:${presentation}`,
    timeoutMs: 45_000,
    windowId
  });
}

export async function createWebOnlyWorkspace(): Promise<LaunchWorkspace> {
  await navigate("/workspaces");
  const create = await $("button=New workspace");
  await create.waitForClickable({ timeout: 10_000 });
  await create.click();
  await waitForRoute("/workspaces/new");
  await setEditorName(WEB_ONLY_WORKSPACE_NAME);
  await $("#workspace-layout").click();
  const singleLayout = await $("[data-workspace-layout-option='single']");
  await singleLayout.waitForDisplayed({ timeout: 10_000 });
  await singleLayout.click();
  await $("#workspace-slot-content").click();
  const webOption = await $("[role='option']=Web app");
  await webOption.waitForDisplayed({ timeout: 10_000 });
  await webOption.click();
  await $("#workspace-web-name").setValue("E2E Web Only App");
  await $("#workspace-web-url").setValue(webOnlyUrl());
  await submitEditor("/workspaces");

  let workspace: LaunchWorkspace | undefined;
  await browser.waitUntil(async () => {
    workspace = (await rendererCall("listLaunchWorkspaces"))
      .find((candidate) => candidate.name === WEB_ONLY_WORKSPACE_NAME);
    return Boolean(workspace);
  }, {
    timeout: 15_000,
    timeoutMsg: "The Web-only workspace was not persisted"
  });
  return workspace as LaunchWorkspace;
}

export function expectWebOnlyWorkspaceDefinition(workspace: LaunchWorkspace): void {
  expect(workspace.template).toBe("single");
  expect(workspace.slots).toHaveLength(1);
  expect(workspace.slots[0]?.roleId).toBeUndefined();
  expect(workspace.slots[0]?.web).toEqual({
    name: "E2E Web Only App",
    startUrl: webOnlyUrl()
  });
}

async function waitForWebOnlyRuntimeTab(
  workspace: LaunchWorkspace
): Promise<EmbeddedRuntimeTabSummary> {
  let matching: EmbeddedRuntimeTabSummary | undefined;
  await browser.waitUntil(async () => {
    matching = (await rendererCall("getEmbeddedRuntimeState")).tabs.find((candidate) =>
      candidate.type === "workspace" && candidate.sourceId === workspace.id
    );
    return Boolean(matching);
  }, {
    interval: 100,
    timeout: 45_000,
    timeoutMsg: "The Web-only workspace did not project a runtime tab"
  });
  return matching as EmbeddedRuntimeTabSummary;
}

async function expectWebOnlyWorkspaceRuntime(
  workspace: LaunchWorkspace,
  tab: EmbeddedRuntimeTabSummary,
  phase: "degraded" | "navigating" | "ready",
  requireActivationRecord = false
): Promise<Awaited<ReturnType<typeof windowSnapshot>>> {
  expect(tab.type).toBe("workspace");
  expect(tab.sourceId).toBe(workspace.id);
  expect(tab.roleIds).toEqual([]);
  expect(tab.slots).toEqual([]);

  const snapshot = await windowSnapshot(tab.windowId);
  const kernelTab = snapshot.kernel?.tabs.find((candidate) => candidate.tabId === tab.id);
  const webSlots = kernelTab?.workspaceSlots.filter((slot) => slot.web !== undefined) ?? [];
  const roleSlots = kernelTab?.workspaceSlots.filter((slot) => slot.roleId !== undefined) ?? [];
  if (!kernelTab) throw new Error("The Web-only workspace has no Kernel tab projection");
  expect(kernelTab.launchPhase).toBe(phase);
  const expectedActivationPhase = phase === "navigating" ? "loading" : phase;
  if (requireActivationRecord) {
    expect(kernelTab.activationPhase).toBe(expectedActivationPhase);
  } else {
    // Directly-created live tabs do not require an on-demand activation record. When one is
    // present, it must agree with presentation so Failed/Degraded divergence cannot hide here.
    expect([null, expectedActivationPhase]).toContain(kernelTab.activationPhase);
  }
  expect(roleSlots).toEqual([]);
  expect(webSlots).toHaveLength(1);
  expect(webSlots[0]).toEqual(expect.objectContaining({
    id: workspace.slots[0]?.id,
    rect: workspace.slots[0]?.rect,
    web: workspace.slots[0]?.web
  }));

  const webviews = snapshot.native.roleWebviews?.filter(
    (surface) => surface.url?.includes(`/role/${WEB_ONLY_FIXTURE_ID}`)
  ) ?? [];
  expect(webviews).toHaveLength(1);
  const webSurfaceId = webviews[0]?.roleId;
  if (!webSurfaceId) throw new Error("The Web-only workspace has no native surface identity");
  expect((await rendererCall("listRoleStatuses"))
    .some((status) => status.roleId === webSurfaceId)).toBe(false);

  if (phase === "navigating") {
    expect(snapshot.native.tabStatusPresentation).toBe("loading");
    return snapshot;
  }

  const persistedWindow = (await rendererCall("listGameWindows"))
    .find((candidate) => candidate.id === tab.windowId);
  const persistedTab = persistedWindow?.tabs.find((candidate) => candidate.id === tab.id);
  if (!persistedTab) throw new Error("The Web-only workspace has no saved Game Window tab");
  expect(persistedTab.roleSlots).toEqual([]);
  expect(persistedTab.workspaceSlots).toEqual(workspace.slots);

  if (phase === "degraded") {
    expect(snapshot.native.tabStatusPresentation).toBe("hidden");
    return snapshot;
  }

  expect(snapshot.native.tabStatusPresentation).toBe("hidden");
  const content = snapshot.native.roleSurfaces?.find(
    (surface) => surface.roleId === webSurfaceId
  );
  const chrome = snapshot.native.workspaceWebChromeSurfaces?.find(
    (surface) => surface.roleId === webSurfaceId
  );
  if (!webSurfaceId || !content || !chrome) {
    throw new Error("The Web-only workspace lost its content or Rion-owned chrome surface");
  }
  expect(content.hostBounds.width).toBeGreaterThan(0);
  expect(content.hostBounds.height).toBeGreaterThan(0);
  expect(chrome.bounds.height).toBeGreaterThan(0);
  expect(chrome).toEqual(expect.objectContaining({ fullscreen: false, visible: true }));
  expectWithinCssPixel(chrome.bounds.x, content.hostBounds.x);
  expectWithinCssPixel(chrome.bounds.width, content.hostBounds.width);
  return snapshot;
}

async function closeRuntimeTabThroughVisibleControl(
  tab: Pick<EmbeddedRuntimeTabSummary, "id" | "windowId">
): Promise<void> {
  let snapshot = await windowSnapshot(tab.windowId);
  if (snapshot.kernel?.selectedTabId !== tab.id) {
    const activationCursor = (await probe()).latestSequence;
    await runtimeUiAction(tab.windowId, {
      action: "activateTab",
      tabId: tab.id,
      windowGeneration: snapshot.windowGeneration
    });
    const activation = await waitEvent({
      afterSequence: activationCursor,
      kind: "runtime-tab-activation-terminal",
      timeoutMs: 55_000,
      windowId: tab.windowId
    });
    expect(activation.details).toMatchObject({ error: null, status: "completed", tabId: tab.id });
    snapshot = await windowSnapshot(tab.windowId);
  }
  const closesWindow = snapshot.kernel?.tabs.length === 1;
  const closeCursor = (await probe()).latestSequence;
  await runtimeUiAction(tab.windowId, {
    action: "closeTab",
    tabId: tab.id,
    windowGeneration: snapshot.windowGeneration
  });
  const terminal = await waitEvent({
    afterSequence: closeCursor,
    kind: "runtime-tab-close-terminal",
    timeoutMs: 55_000,
    windowId: tab.windowId
  });
  expect(terminal.details).toMatchObject({ error: null, status: "completed", tabId: tab.id });
  if (closesWindow) {
    await waitEvent({
      afterSequence: closeCursor,
      kind: "window-destroyed",
      timeoutMs: 55_000,
      windowId: tab.windowId
    });
  } else {
    expect((await windowSnapshot(tab.windowId)).kernel?.tabs
      .some((candidate) => candidate.tabId === tab.id)).toBe(false);
  }
}

async function openWorkspaceFromVisibleUi(workspace: LaunchWorkspace): Promise<void> {
  await navigate("/workspaces");
  const open = await $(`[data-selection-id='${workspace.id}'] button[aria-label='Open workspace']`);
  await open.waitForEnabled({ timeout: 15_000 });
  await open.click();
}

async function showSavedGameWindow(windowId: string): Promise<void> {
  await navigate("/game-windows");
  const show = await $(`[data-selection-id='${windowId}'] button[aria-label='Show']`);
  await show.waitForClickable({ timeout: 15_000 });
  const cursor = (await probe()).latestSequence;
  await show.click();
  await waitEvent({
    afterSequence: cursor,
    kind: "window-context-initialized",
    timeoutMs: 55_000,
    windowId
  });
}

function expectWebOnlySession(
  event: Awaited<ReturnType<typeof waitFixtureEvent>>,
  before: string | null
): void {
  expect(event.session).toMatchObject({
    after: { cookie: WEB_SESSION_MARKER, localStorage: WEB_SESSION_MARKER },
    marker: WEB_SESSION_MARKER,
    mode: "seed"
  });
  if (before === null) {
    expect([null, WEB_SESSION_MARKER]).toContain(event.session?.before.cookie);
    expect([null, WEB_SESSION_MARKER]).toContain(event.session?.before.localStorage);
    return;
  }
  expect(event.session?.before).toMatchObject({ cookie: before, localStorage: before });
}

export async function exerciseWebOnlyWorkspace(
  workspace: LaunchWorkspace,
  savedWindowId: string
): Promise<void> {
  expectWebOnlyWorkspaceDefinition(workspace);
  const firstControlCursor = (await probe()).latestSequence;
  const firstSessionCursor = await fixtureCursor();
  await fixtureRequest("/api/gate", { roleId: WEB_ONLY_FIXTURE_ID });
  await openWorkspaceFromVisibleUi(workspace);
  await waitForFixtureNavigation(WEB_ONLY_FIXTURE_ID);
  const firstTab = await waitForWebOnlyRuntimeTab(workspace);
  expect(firstTab.windowId).toBe(savedWindowId);
  const navigating = await waitEvent({
    afterSequence: firstControlCursor,
    kind: `tab-launch-phase:${firstTab.id}:navigating`,
    timeoutMs: 55_000,
    windowId: firstTab.windowId
  });
  await waitForWindowsTabStatus(navigating.sequence, "loading", firstTab.windowId);
  await expectWebOnlyWorkspaceRuntime(workspace, firstTab, "navigating");
  await fixtureRequest("/api/release", { roleId: WEB_ONLY_FIXTURE_ID });
  const [firstSession] = await Promise.all([
    waitFixtureEvent({
      afterSequence: firstSessionCursor,
      kind: "session",
      roleId: WEB_ONLY_FIXTURE_ID
    }),
    waitEvent({
      afterSequence: firstControlCursor,
      kind: `tab-launch-phase:${firstTab.id}:ready`,
      timeoutMs: 55_000,
      windowId: firstTab.windowId
    })
  ]);
  expectWebOnlySession(firstSession, null);
  await expectWebOnlyWorkspaceRuntime(workspace, firstTab, "ready");

  const beforeDuplicate = await rendererCall("getEmbeddedRuntimeState");
  const duplicateControlCursor = (await probe()).latestSequence;
  await openWorkspaceFromVisibleUi(workspace);
  const duplicateTerminal = await waitEvent({
    afterSequence: duplicateControlCursor,
    kind: "runtime-launch-intent-terminal",
    timeoutMs: 55_000
  });
  expect(duplicateTerminal.details).toMatchObject({
    sourceId: workspace.id,
    sourceType: "workspace",
    status: "applied"
  });
  const afterDuplicate = await rendererCall("getEmbeddedRuntimeState");
  expect(afterDuplicate.tabs.filter((candidate) => candidate.sourceId === workspace.id))
    .toEqual([expect.objectContaining({ id: firstTab.id, windowId: firstTab.windowId })]);
  expect(afterDuplicate.tabs).toHaveLength(beforeDuplicate.tabs.length);
  expect((await windowSnapshot(firstTab.windowId)).kernel?.selectedTabId).toBe(firstTab.id);

  await closeRuntimeTabThroughVisibleControl(firstTab);
  expect((await rendererCall("getEmbeddedRuntimeState")).tabs
    .some((candidate) => candidate.sourceId === workspace.id)).toBe(false);

  await fixtureRequest("/api/navigation-failure", {
    enabled: true,
    roleId: WEB_ONLY_FIXTURE_ID
  });
  let failedTab: EmbeddedRuntimeTabSummary | undefined;
  try {
    await showSavedGameWindow(savedWindowId);
    const failureControlCursor = (await probe()).latestSequence;
    await openWorkspaceFromVisibleUi(workspace);
    await waitForFixturePath(`/api/navigation-failures/${WEB_ONLY_FIXTURE_ID}/attempted`);
    failedTab = await waitForWebOnlyRuntimeTab(workspace);
    const degraded = await waitEvent({
      afterSequence: failureControlCursor,
      kind: `tab-launch-phase:${failedTab.id}:degraded`,
      timeoutMs: 60_000,
      windowId: failedTab.windowId
    });
    await waitForWindowsTabStatus(degraded.sequence, "hidden", failedTab.windowId);
    expect(failedTab.windowId).toBe(savedWindowId);
    await expectWebOnlyWorkspaceRuntime(workspace, failedTab, "degraded");
    await closeRuntimeTabThroughVisibleControl(failedTab);
  } finally {
    await fixtureRequest("/api/navigation-failure", {
      enabled: false,
      roleId: WEB_ONLY_FIXTURE_ID
    });
  }
  if (!failedTab) throw new Error("The failed Web-only workspace did not create a runtime tab");
  expect((await rendererCall("getEmbeddedRuntimeState")).tabs
    .some((candidate) => candidate.id === failedTab?.id)).toBe(false);

  const recoveryControlCursor = (await probe()).latestSequence;
  const recoverySessionCursor = await fixtureCursor();
  await showSavedGameWindow(savedWindowId);
  await openWorkspaceFromVisibleUi(workspace);
  const recoverySession = await waitFixtureEvent({
    afterSequence: recoverySessionCursor,
    kind: "session",
    roleId: WEB_ONLY_FIXTURE_ID
  });
  const recoveredTab = await waitForWebOnlyRuntimeTab(workspace);
  expect(recoveredTab.windowId).toBe(savedWindowId);
  await waitEvent({
    afterSequence: recoveryControlCursor,
    kind: `tab-launch-phase:${recoveredTab.id}:ready`,
    timeoutMs: 55_000,
    windowId: recoveredTab.windowId
  });
  expectWebOnlySession(recoverySession, WEB_SESSION_MARKER);
  await expectWebOnlyWorkspaceRuntime(workspace, recoveredTab, "ready");
}

export async function verifyRestoredWebOnlyWorkspace(
  windowId: string,
  workspace: LaunchWorkspace
): Promise<void> {
  expectWebOnlyWorkspaceDefinition(workspace);
  const dormant = await windowSnapshot(windowId);
  const dormantTab = dormant.kernel?.tabs.find((candidate) =>
    candidate.sourceId === workspace.id && candidate.tabType === "workspace"
  );
  if (!dormantTab) throw new Error("The restarted Game Window lost its Web-only tab");
  expect(dormantTab.launchPhase).toBeNull();
  expect(dormantTab.workspaceSlots.filter((slot) => slot.roleId !== undefined)).toEqual([]);
  expect(dormantTab.workspaceSlots.filter((slot) => slot.web !== undefined)).toHaveLength(1);

  const persistedWindow = (await rendererCall("listGameWindows"))
    .find((candidate) => candidate.id === windowId);
  const persistedTab = persistedWindow?.tabs.find((candidate) => candidate.id === dormantTab.tabId);
  if (!persistedTab) throw new Error("The saved Web-only Game Window tab is unavailable");
  expect(persistedTab.roleSlots).toEqual([]);
  expect(persistedTab.workspaceSlots).toEqual(workspace.slots);

  await fixtureRequest("/api/gate", { roleId: WEB_ONLY_FIXTURE_ID });
  const controlCursor = (await probe()).latestSequence;
  const sessionCursor = await fixtureCursor();
  await runtimeUiAction(windowId, {
    action: "activateTab",
    tabId: dormantTab.tabId,
    windowGeneration: dormant.windowGeneration
  });
  await waitForFixtureNavigation(WEB_ONLY_FIXTURE_ID);
  const navigating = await waitEvent({
    afterSequence: controlCursor,
    kind: `tab-launch-phase:${dormantTab.tabId}:navigating`,
    timeoutMs: 55_000,
    windowId
  });
  await waitForWindowsTabStatus(navigating.sequence, "loading", windowId);
  const runtimeTab = await waitForWebOnlyRuntimeTab(workspace);
  expect(runtimeTab.id).toBe(dormantTab.tabId);
  await expectWebOnlyWorkspaceRuntime(workspace, runtimeTab, "navigating", true);
  await fixtureRequest("/api/release", { roleId: WEB_ONLY_FIXTURE_ID });
  const [session, activation] = await Promise.all([
    waitFixtureEvent({
      afterSequence: sessionCursor,
      kind: "session",
      roleId: WEB_ONLY_FIXTURE_ID
    }),
    waitEvent({
      afterSequence: controlCursor,
      kind: "runtime-tab-activation-terminal",
      timeoutMs: 55_000,
      windowId
    }),
    waitEvent({
      afterSequence: controlCursor,
      kind: `tab-launch-phase:${dormantTab.tabId}:ready`,
      timeoutMs: 55_000,
      windowId
    })
  ]);
  expect(activation.details).toMatchObject({
    error: null,
    status: "completed",
    tabId: dormantTab.tabId
  });
  expectWebOnlySession(session, WEB_SESSION_MARKER);
  const ready = await expectWebOnlyWorkspaceRuntime(workspace, runtimeTab, "ready", true);
  expect(ready.kernel?.selectedTabId).toBe(dormantTab.tabId);
}
