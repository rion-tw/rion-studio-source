import { $, $$, browser, expect } from "@wdio/globals";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { DisplayInfo, EmbeddedRuntimeState, GameWindow } from "../../../src/shared/types";
import {
  controlWindow,
  detachTerminatedApplicationSession,
  probe,
  rendererCall,
  requireEnvironment,
  runtimeUiAction,
  shutdown,
  submitWindowControl,
  waitEvent,
  windowSnapshot,
  type DesktopE2eWindowSnapshot,
  type WindowBounds
} from "../support/control";
import { expectBoundsNear, expectPlacement } from "../support/geometry";
import { fixtureCursor, waitFixtureEvent } from "../support/fixture";
import { forceTerminateProcessTree } from "../support/process";
import {
  installRendererEventJournal,
  rendererEventCursor,
  waitForRuntimeProjection
} from "../support/renderer-events";
import { waitForTranscriptEvent } from "../support/transcript";
import { ensureEnglishUi, navigate } from "../support/ui";

// [journey:GAME-WINDOWS-NATIVE-001]
// [journey:GAME-WINDOWS-TABS-001]
// [journey:APP-RECOVERY-001]
// [journey:WINDOW-RECOVERY-UI-007]

const WINDOW_A = "e2e00000-0000-4000-8000-00000000000a";
const WINDOW_B = "e2e00000-0000-4000-8000-00000000000b";
const WINDOW_C = "e2e00000-0000-4000-8000-00000000000c";
const MODE_NORMAL = "e2e00000-0000-4000-8000-000000000010";
const MODE_MAXIMIZED = "e2e00000-0000-4000-8000-000000000011";
const MODE_FULLSCREEN = "e2e00000-0000-4000-8000-000000000012";

const PRESENTATION_LABELS = {
  fullscreen: ["Full screen", "全螢幕", "全屏", "フルスクリーン"],
  maximized: ["Maximized", "最大化"],
  normal: ["Windowed", "視窗化", "窗口化", "ウィンドウ表示"]
} as const;

interface ScenarioState {
  boundsA: Required<WindowBounds>;
  boundsB: Required<WindowBounds>;
  display: DisplayInfo;
  initialBounds: Required<WindowBounds>;
}

function scenarioBounds(display: DisplayInfo): ScenarioState {
  const work = display.workArea;
  const widthA = Math.max(640, Math.min(820, work.width - 120));
  const heightA = Math.max(480, Math.min(600, work.height - 140));
  const widthB = Math.max(640, Math.min(900, work.width - 160));
  const heightB = Math.max(480, Math.min(650, work.height - 180));
  return {
    boundsA: {
      height: heightA,
      width: widthA,
      x: work.x + 35,
      y: work.y + 45
    },
    boundsB: {
      height: heightB,
      width: widthB,
      x: work.x + Math.max(55, work.width - widthB - 70),
      y: work.y + Math.max(65, work.height - heightB - 80)
    },
    display,
    initialBounds: {
      height: Math.max(420, Math.min(540, work.height - 220)),
      width: Math.max(600, Math.min(720, work.width - 220)),
      x: work.x + 15,
      y: work.y + 20
    }
  };
}

async function acceptLegalAndEnableRestore(): Promise<void> {
  const legal = await rendererCall("getLegalAcceptanceStatus");
  const preferences = await rendererCall("getRuntimeWindowPreferences");
  await rendererCall("updateRuntimeWindowPreferences", {
    ...preferences,
    restoreGameWindowsOnStartup: true
  });
  if (legal.isAccepted) return;
  const checkboxes = await $$("button[role='checkbox']");
  expect(checkboxes).toHaveLength(2);
  await checkboxes[0].click();
  await checkboxes[1].click();
  const continueButton = await $("[data-testid='legal-onboarding-continue']");
  await continueButton.click();
  await continueButton.waitForExist({ reverse: true, timeout: 15_000 });
  const skip = await $("[data-testid='onboarding-skip']");
  if (await skip.isExisting()) await skip.click();
}

async function primaryScenario(): Promise<ScenarioState> {
  const topology = await rendererCall("getDisplayTopology");
  const display = topology.displays.find((candidate) => candidate.isPrimary)
    ?? topology.displays[0];
  if (!display) throw new Error("Desktop E2E requires one native display");
  return scenarioBounds(display);
}

async function createWindow(
  id: string,
  name: string,
  state: ScenarioState,
  presentation: "fullscreen" | "maximized" | "normal" = "normal"
): Promise<GameWindow> {
  return rendererCall("createGameWindow", {
    id,
    name,
    placement: {
      normalBounds: state.initialBounds,
      presentation,
      savedWorkArea: state.display.workArea
    },
    targetDisplay: { id: state.display.id }
  });
}

async function showAndWait(windowId: string, minimumGeneration = 1): Promise<DesktopE2eWindowSnapshot> {
  const cursor = (await probe()).latestSequence;
  await rendererCall("showGameWindow", windowId);
  await waitEvent({
    afterSequence: cursor,
    kind: "window-context-initialized",
    minimumGeneration,
    windowId
  });
  return windowSnapshot(windowId);
}

async function closeAndWait(snapshot: DesktopE2eWindowSnapshot): Promise<void> {
  const submitted = await submitWindowControl(snapshot, { action: "close" });
  await waitEvent({
    afterSequence: submitted.sequence,
    kind: "window-destroyed",
    minimumGeneration: snapshot.windowGeneration,
    timeoutMs: 45_000,
    windowId: snapshot.windowId
  });
}

async function moveAndWait(
  snapshot: DesktopE2eWindowSnapshot,
  bounds: Required<WindowBounds>
): Promise<DesktopE2eWindowSnapshot> {
  const submitted = await submitWindowControl(snapshot, { action: "moveResize", ...bounds });
  await waitEvent({
    afterSequence: submitted.sequence,
    kind: "placement-accepted",
    minimumGeneration: snapshot.windowGeneration,
    windowId: snapshot.windowId
  });
  return windowSnapshot(snapshot.windowId);
}

async function expectWindowUnavailable(windowId: string): Promise<void> {
  let unavailable = false;
  try {
    await windowSnapshot(windowId);
  } catch (error) {
    unavailable = String(error).includes("not live");
  }
  expect(unavailable).toBe(true);
}

async function expectModeCell(
  windowId: string,
  presentation: keyof typeof PRESENTATION_LABELS
): Promise<void> {
  await browser.execute(() => {
    window.location.hash = "#/game-windows";
  });
  const cell = await $(`tbody tr[data-selection-id='${windowId}'] td:nth-child(4)`);
  await cell.waitForExist({ timeout: 10_000 });
  await browser.waitUntil(async () => {
    const text = (await cell.getText()).trim();
    return PRESENTATION_LABELS[presentation].some((label) => label === text);
  }, {
    interval: 50,
    timeout: 10_000,
    timeoutMsg: `Mode cell for ${windowId} did not render ${presentation}`
  });
}

async function fixtureRequest(path: string, body: unknown): Promise<unknown> {
  const origin = requireEnvironment("RION_STUDIO_E2E_FIXTURE_ORIGIN");
  const response = await fetch(`${origin}${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
  if (!response.ok) throw new Error(`Fixture ${path} failed with ${response.status}`);
  return response.json();
}

async function waitForFixtureNavigation(roleId: string): Promise<void> {
  const origin = requireEnvironment("RION_STUDIO_E2E_FIXTURE_ORIGIN");
  const response = await fetch(`${origin}/api/gates/${roleId}/waiting`, {
    signal: AbortSignal.timeout(45_000)
  });
  if (!response.ok) throw new Error(`Fixture gate wait failed with ${response.status}`);
  const evidence = await response.json() as { roleId?: string; waiterCount?: number };
  expect(evidence.roleId).toBe(roleId);
  expect(evidence.waiterCount).toBeGreaterThan(0);
}

async function exerciseLaunchingTabs(state: ScenarioState): Promise<void> {
  await createWindow(WINDOW_C, "E2E Three Tabs", state);
  const game = await rendererCall("createGame", {
    defaultLaunchUrl: `${requireEnvironment("RION_STUDIO_E2E_FIXTURE_ORIGIN")}/role/e2e-alpha`,
    name: "E2E Runtime Fixture"
  });
  const roleNames = ["alpha", "beta", "gamma"];
  const roles = [];
  for (const roleName of roleNames) {
    await fixtureRequest("/api/gate", { roleId: `e2e-${roleName}` });
    roles.push(await rendererCall("createRole", {
      gameId: game.id,
      launchUrl: `${requireEnvironment("RION_STUDIO_E2E_FIXTURE_ORIGIN")}/role/e2e-${roleName}`,
      name: `E2E ${roleName}`
    }));
  }
  await showAndWait(WINDOW_C);
  for (const [index, role] of roles.entries()) {
    const cursor = (await probe()).latestSequence;
    await rendererCall("launchRole", role.id, { kind: "game-window", windowId: WINDOW_C });
    const snapshot = await windowSnapshot(WINDOW_C);
    const tab = snapshot.kernel?.tabs.find((candidate) => candidate.sourceId === role.id);
    if (!tab) throw new Error(`Runtime tab was not projected for ${role.id}`);
    await waitEvent({
      afterSequence: cursor,
      kind: `tab-launch-phase:${tab.tabId}:navigating`,
      timeoutMs: 45_000
    });
    await waitForFixtureNavigation(`e2e-${roleNames[index]}`);
    const loading = await windowSnapshot(WINDOW_C);
    expect(loading.kernel?.tabs.find((candidate) => candidate.tabId === tab.tabId)
      ?.launchPhase).toBe("navigating");
  }
  let live = await windowSnapshot(WINDOW_C);
  expect(live.kernel?.tabs).toHaveLength(3);
  const activeTabId = live.kernel?.selectedTabId;
  expect(activeTabId).toBeTruthy();

  for (let round = 0; round < 2; round += 1) {
    const previousGeneration = live.windowGeneration;
    await closeAndWait(live);
    const reopenCursor = (await probe()).latestSequence;
    await showAndWait(WINDOW_C, previousGeneration + 1);
    await waitEvent({
      afterSequence: reopenCursor,
      kind: `tab-launch-phase:${activeTabId}:navigating`,
      minimumGeneration: previousGeneration + 1,
      windowId: WINDOW_C
    });
    live = await windowSnapshot(WINDOW_C);
    expect(live.windowGeneration).toBe(previousGeneration + 1);
    expect(live.kernel?.persistedName).toBe("E2E Three Tabs");
    expect(live.kernel?.tabs).toHaveLength(3);
    expect(live.kernel?.selectedTabId).toBe(activeTabId);
    expect(live.kernel?.surfaceTabIds).toEqual([activeTabId]);
    expect(live.kernel?.tabs.find((tab) => tab.tabId === activeTabId)?.launchPhase)
      .toBe("navigating");
    expect(live.kernel?.tabs.filter((tab) => tab.tabId !== activeTabId)
      .every((tab) => tab.launchPhase === null)).toBe(true);
  }
  await closeAndWait(live);
  for (const roleName of roleNames) {
    await fixtureRequest("/api/release", { roleId: `e2e-${roleName}` });
  }
}

async function verifyModeColumnSemanticSort(): Promise<void> {
  await browser.execute(() => {
    window.location.hash = "#/game-windows";
  });
  const header = await $("thead th:nth-child(4) button");
  await header.waitForExist({ timeout: 10_000 });
  const headerText = (await header.getText()).trim();
  expect(["Window mode", "視窗模式", "窗口模式", "ウインドウモード"]).toContain(headerText);
  await header.click();
  expect(await $("thead th:nth-child(4)").getAttribute("aria-sort")).toBe("ascending");
  const ids = await $$("tbody tr").map((row) => row.getAttribute("data-selection-id"));
  const normalIndex = ids.indexOf(MODE_NORMAL);
  const maximizedIndex = ids.indexOf(MODE_MAXIMIZED);
  const fullscreenIndex = ids.indexOf(MODE_FULLSCREEN);
  expect(normalIndex).toBeGreaterThanOrEqual(0);
  expect(maximizedIndex).toBeGreaterThan(normalIndex);
  expect(fullscreenIndex).toBeGreaterThan(maximizedIndex);
}

async function shutdownAndWaitForFlush(): Promise<void> {
  const control = await probe();
  const requestedAfter = new Date().toISOString();
  await shutdown().catch(() => undefined);
  const event = await waitForTranscriptEvent(
    control.transcriptPath,
    (candidate) => candidate.kind === "application-final-flush-complete"
      && candidate.timestamp >= requestedAfter
  );
  const details = event.details as { complete?: boolean };
  expect(details.complete).toBe(true);
  await writeFile(resolve(
    requireEnvironment("RION_STUDIO_E2E_ARTIFACT_DIR"),
    "clean-shutdown.json"
  ), `${JSON.stringify({
    complete: true,
    eventSequence: event.sequence,
    eventTimestamp: event.timestamp,
    requestedAfter
  }, null, 2)}\n`);
  detachTerminatedApplicationSession();
}

async function seedPhase(): Promise<void> {
  await acceptLegalAndEnableRestore();
  const state = await primaryScenario();
  await createWindow(WINDOW_A, "E2E Window A", state);
  await createWindow(WINDOW_B, "E2E Window B", state);
  await createWindow(MODE_NORMAL, "E2E Mode 1 Normal", state, "normal");
  await createWindow(MODE_MAXIMIZED, "E2E Mode 2 Maximized", state, "maximized");
  await createWindow(MODE_FULLSCREEN, "E2E Mode 3 Fullscreen", state, "fullscreen");

  let liveA = await showAndWait(WINDOW_A);
  liveA = await moveAndWait(liveA, state.boundsA);
  expectPlacement(liveA, state.boundsA, "normal");
  expect(liveA.native.title).toBe("E2E Window A");
  expect(liveA.kernel?.persistedName).toBe("E2E Window A");

  for (let round = 0; round < 3; round += 1) {
    const generation = liveA.windowGeneration;
    await closeAndWait(liveA);
    await expectModeCell(WINDOW_A, "normal");
    liveA = await showAndWait(WINDOW_A, generation + 1);
    expect(liveA.windowGeneration).toBe(generation + 1);
    expect(liveA.native.title).toBe("E2E Window A");
    if (round === 0) liveA = await moveAndWait(liveA, state.boundsB);
    expectPlacement(liveA, state.boundsB, "normal");
  }

  const rapidGeneration = liveA.windowGeneration;
  for (const bounds of [state.boundsA, state.boundsB, state.boundsA, state.boundsB]) {
    await controlWindow(WINDOW_A, { action: "moveResize", ...bounds });
  }
  await controlWindow(WINDOW_A, {
    action: "setPresentation",
    presentation: "maximized"
  });
  await controlWindow(WINDOW_A, { action: "setPresentation", presentation: "normal" });
  await controlWindow(WINDOW_A, { action: "moveResize", ...state.boundsB });
  await closeAndWait(liveA);
  liveA = await showAndWait(WINDOW_A, rapidGeneration + 1);
  expect(liveA.windowGeneration).toBe(rapidGeneration + 1);
  expectPlacement(liveA, state.boundsB, "normal");

  const liveB = await showAndWait(WINDOW_B);
  await closeAndWait(liveB);
  await expectModeCell(WINDOW_B, "normal");
  await exerciseLaunchingTabs(state);
  await verifyModeColumnSemanticSort();
  await shutdownAndWaitForFlush();
}

async function modeTransition(
  snapshot: DesktopE2eWindowSnapshot,
  presentation: "fullscreen" | "maximized" | "normal"
): Promise<DesktopE2eWindowSnapshot> {
  const submitted = await submitWindowControl(snapshot, {
    action: "setPresentation",
    presentation
  });
  await waitEvent({
    afterSequence: submitted.sequence,
    kind: "placement-accepted",
    minimumGeneration: snapshot.windowGeneration,
    presentation,
    timeoutMs: 45_000,
    windowId: snapshot.windowId
  });
  return windowSnapshot(snapshot.windowId);
}

async function restartPhase(): Promise<void> {
  const state = await primaryScenario();
  await waitEvent({ afterSequence: 0, kind: "window-context-initialized", windowId: WINDOW_A });
  let liveA = await windowSnapshot(WINDOW_A);
  expectPlacement(liveA, state.boundsB, "normal");
  expect(liveA.native.title).toBe("E2E Window A");
  await expectWindowUnavailable(WINDOW_B);
  await expectWindowUnavailable(WINDOW_C);

  const liveB = await showAndWait(WINDOW_B);
  expect(liveB.native.title).toBe("E2E Window B");
  await closeAndWait(liveB);

  const normalBounds = liveA.kernel?.placement?.normalBounds;
  if (!normalBounds) throw new Error("Window A normal bounds are unavailable");
  liveA = await modeTransition(liveA, "maximized");
  expectPlacement(liveA, normalBounds, "maximized");
  await expectModeCell(WINDOW_A, "maximized");
  const minimizeSubmitted = await submitWindowControl(liveA, { action: "minimize" });
  await waitEvent({
    afterSequence: minimizeSubmitted.sequence,
    kind: "window-minimized-observed",
    minimumGeneration: liveA.windowGeneration,
    windowId: WINDOW_A
  });
  const minimized = await windowSnapshot(WINDOW_A);
  expect(minimized.native.presentation).toBe("minimized");
  expect(minimized.kernel?.placement?.presentation).toBe("maximized");
  expectBoundsNear(minimized.kernel?.placement?.normalBounds ?? normalBounds, normalBounds);
  await expectModeCell(WINDOW_A, "maximized");
  liveA = await modeTransition(minimized, "normal");
  expectPlacement(liveA, normalBounds, "normal");
  liveA = await modeTransition(liveA, "fullscreen");
  expectPlacement(liveA, normalBounds, "fullscreen");
  await expectModeCell(WINDOW_A, "fullscreen");
  liveA = await modeTransition(liveA, "normal");
  expectPlacement(liveA, normalBounds, "normal");
  await shutdownAndWaitForFlush();
}

async function verifyRecoveredWindowA(): Promise<void> {
  const state = await primaryScenario();
  await waitEvent({ afterSequence: 0, kind: "window-context-initialized", windowId: WINDOW_A });
  const liveA = await windowSnapshot(WINDOW_A);
  expectPlacement(liveA, state.boundsB, "normal");
  await expectWindowUnavailable(WINDOW_B);
  await expectWindowUnavailable(WINDOW_C);
}

function expectSavedWindowState(
  runtime: EmbeddedRuntimeState,
  windowId: string,
  state: "awaiting-recovery" | "dormant"
): void {
  expect(runtime.savedWindows?.find((candidate) => candidate.id === windowId)?.state).toBe(state);
}

async function forceTerminateCurrentProcess(): Promise<void> {
  const control = await probe();
  const markerPath = resolve(
    requireEnvironment("RION_STUDIO_E2E_ARTIFACT_DIR"),
    "forced-termination.json"
  );
  await writeFile(markerPath, `${JSON.stringify({
    pid: control.pid,
    requestedAt: new Date().toISOString(),
    sessionId: control.sessionId
  }, null, 2)}\n`);
  await forceTerminateProcessTree(control.pid);
  detachTerminatedApplicationSession();
}

async function forceTerminatePhase(): Promise<void> {
  await verifyRecoveredWindowA();
  const focusEventCursor = (await probe()).latestSequence;
  await showAndWait(WINDOW_B);
  await showAndWait(WINDOW_C);
  const beforeCrash = await rendererCall("getEmbeddedRuntimeState");
  expect(beforeCrash.windows.map((window) => window.windowId).sort()).toEqual(
    [WINDOW_A, WINDOW_B, WINDOW_C].sort()
  );
  const tabsC = beforeCrash.tabs.filter((tab) => tab.windowId === WINDOW_C);
  expect(tabsC).toHaveLength(3);
  const activeC = tabsC.find((tab) => tab.active);
  const focusedRoleId = activeC?.roleIds[0];
  if (!activeC || !focusedRoleId) throw new Error("Window C active role surface is unavailable");
  const focusCursor = await fixtureCursor();
  let liveC = await windowSnapshot(WINDOW_C);
  const phase = liveC.kernel?.tabs.find((tab) => tab.tabId === activeC.id)?.launchPhase;
  if (!phase || phase === "attaching" || phase === "navigating") {
    await waitEvent({
      afterSequence: focusEventCursor,
      kind: `tab-launch-phase:${activeC.id}:essentialReady`,
      timeoutMs: 25_000,
      windowId: WINDOW_C
    });
    liveC = await windowSnapshot(WINDOW_C);
  }
  await runtimeUiAction(WINDOW_C, {
    action: "focusRole",
    roleId: focusedRoleId,
    tabId: activeC.id,
    windowGeneration: liveC.windowGeneration
  });
  await waitFixtureEvent({
    afterSequence: focusCursor,
    kind: "click",
    roleId: "e2e-gamma"
  });
  await waitEvent({
    afterSequence: focusEventCursor,
    kind: "window-focus-persisted",
    minimumGeneration: liveC.windowGeneration,
    windowId: WINDOW_C
  });
  await forceTerminateCurrentProcess();
}

async function crashRestartPhase(): Promise<void> {
  await ensureEnglishUi();
  await installRendererEventJournal();
  await navigate("/dashboard");
  const awaiting = await rendererCall("getEmbeddedRuntimeState");
  expect(awaiting.recovery).toMatchObject({ windowCount: 3, tabCount: 3 });
  for (const windowId of [WINDOW_A, WINDOW_B, WINDOW_C]) {
    expectSavedWindowState(awaiting, windowId, "awaiting-recovery");
    await expectWindowUnavailable(windowId);
  }
  for (const windowId of [MODE_NORMAL, MODE_MAXIMIZED, MODE_FULLSCREEN]) {
    expectSavedWindowState(awaiting, windowId, "dormant");
  }

  const restoreEventCursor = (await probe()).latestSequence;
  const cursor = await rendererEventCursor();
  const restore = await $("button=Restore session");
  await restore.waitForDisplayed({ timeout: 10_000 });
  await restore.click();
  const restored = await waitForRuntimeProjection({
    afterSequence: cursor,
    recoveryAbsent: true,
    savedWindowStates: [
      { state: "dormant", windowId: MODE_NORMAL },
      { state: "dormant", windowId: MODE_MAXIMIZED },
      { state: "dormant", windowId: MODE_FULLSCREEN }
    ],
    windowIds: [WINDOW_A, WINDOW_B, WINDOW_C]
  });
  expect(restored.tabs.filter((tab) => tab.windowId === WINDOW_C)).toHaveLength(3);
  const state = await primaryScenario();
  const liveA = await windowSnapshot(WINDOW_A);
  expectPlacement(liveA, state.boundsB, "normal");
  expect(liveA.native.title).toBe("E2E Window A");
  await windowSnapshot(WINDOW_B);
  await windowSnapshot(WINDOW_C);
  await waitEvent({
    afterSequence: restoreEventCursor,
    kind: "saved-window-restore-final-focus-started",
    windowId: WINDOW_C
  });
  await waitEvent({
    afterSequence: restoreEventCursor,
    kind: "window-focus-persisted",
    windowId: WINDOW_C
  });
  await forceTerminateCurrentProcess();
}

async function crashDiscardPhase(): Promise<void> {
  await ensureEnglishUi();
  await installRendererEventJournal();
  await navigate("/dashboard");
  const awaiting = await rendererCall("getEmbeddedRuntimeState");
  expect(awaiting.recovery).toMatchObject({ windowCount: 3, tabCount: 3 });
  for (const windowId of [WINDOW_A, WINDOW_B, WINDOW_C]) {
    expectSavedWindowState(awaiting, windowId, "awaiting-recovery");
    await expectWindowUnavailable(windowId);
  }

  const cursor = await rendererEventCursor();
  const discard = await $("button=Discard");
  await discard.waitForDisplayed({ timeout: 10_000 });
  await discard.click();
  const dormant = [
    WINDOW_A,
    WINDOW_B,
    WINDOW_C,
    MODE_NORMAL,
    MODE_MAXIMIZED,
    MODE_FULLSCREEN
  ].map((windowId) => ({ state: "dormant" as const, windowId }));
  const discarded = await waitForRuntimeProjection({
    afterSequence: cursor,
    exactWindowIds: [],
    recoveryAbsent: true,
    savedWindowStates: dormant
  });
  expect(discarded.savedWindows).toHaveLength(6);
  const windowC = (await rendererCall("listGameWindows"))
    .find((candidate) => candidate.id === WINDOW_C);
  expect(windowC?.tabs).toHaveLength(3);
  expect(windowC?.activeTabId).toBe(windowC?.tabs.at(-1)?.id);
  await shutdownAndWaitForFlush();
}

async function recoveryFinalRestartPhase(): Promise<void> {
  await ensureEnglishUi();
  await installRendererEventJournal();
  await navigate("/dashboard");
  const dormant = [
    WINDOW_A,
    WINDOW_B,
    WINDOW_C,
    MODE_NORMAL,
    MODE_MAXIMIZED,
    MODE_FULLSCREEN
  ].map((windowId) => ({ state: "dormant" as const, windowId }));
  const runtime = await waitForRuntimeProjection({
    exactWindowIds: [],
    recoveryAbsent: true,
    savedWindowStates: dormant
  });
  expect(runtime.savedWindows).toHaveLength(6);
  expect(await $("button=Restore session").isExisting()).toBe(false);
  expect(await $("button=Discard").isExisting()).toBe(false);
  await shutdownAndWaitForFlush();
}

describe("permanent Game Window native lifecycle", () => {
  it(`runs ${requireEnvironment("RION_STUDIO_E2E_PHASE")} with revision-fenced evidence`, async () => {
    const phase = requireEnvironment("RION_STUDIO_E2E_PHASE");
    if (phase === "seed") await seedPhase();
    else if (phase === "restart") await restartPhase();
    else if (phase === "force-terminate") await forceTerminatePhase();
    else if (phase === "crash-restart") await crashRestartPhase();
    else if (phase === "crash-discard") await crashDiscardPhase();
    else if (phase === "recovery-final-restart") await recoveryFinalRestartPhase();
    else throw new Error(`Unknown desktop E2E phase: ${phase}`);
  });
});
