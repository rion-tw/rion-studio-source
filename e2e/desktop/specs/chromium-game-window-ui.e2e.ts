import { $, browser, expect } from "@wdio/globals";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { DisplayTopology, GameWindow } from "../../../src/shared/types";
import {
  electronDesktopE2eGameWindowRuntime,
  electronDesktopE2eFullscreenToolbarRuntime,
  electronDesktopE2eProbe,
  type ElectronDesktopE2eGameWindowRuntimeInspection
} from "../support/electron-driver";
import {
  movePointerToWindowsRuntimeContent,
  movePointerToWindowsRuntimeHostRevealEdge
} from "../support/electron-role-surface";
import { movePointerToMacosFullscreenRevealEdge } from "../support/macos-appkit-ui";
import { pressVisibleMacosApplicationShortcut } from "../support/native-application-actions";
import {
  clickVisibleRuntimeWindowControl,
  closeVisibleRuntimeWindow
} from "../support/native-runtime-tabs";
import { rendererCall } from "../support/renderer-bridge";
import { pressWindowsRuntimeWindowControl } from "../support/windows-runtime-window-control";
import {
  acceptLegalAndSkipFirstRun,
  ensureEnglishUi,
  waitForRoute
} from "../support/ui";

// [journey:CHROMIUM-MACOS-APPKIT-GAME-WINDOW-UI-016]
// [journey:CHROMIUM-WINDOWS-GAME-WINDOW-UI-016]

const WINDOW_NAME = "Chromium E2E Game Window";
type Presentation = GameWindow["placement"]["presentation"];
const presentationStages: unknown[] = [];
const fullscreenShortcutAdmissions: unknown[] = [];
const nativeRecreations: unknown[] = [];
const visibleShowAdmissions: unknown[] = [];

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the Chromium Game Window journey`);
  return value;
}

function transientNativeInspectionError(message: string): boolean {
  return message.includes("has a stale Core/native Chromium fence:") ||
    message.includes("has stale preference, presentation, or native fences:") ||
    message.includes("has divergent Core/browser/native");
}

async function preparePhase(): Promise<"macos" | "windows"> {
  const target = required("RION_STUDIO_E2E_RUNTIME_TARGET");
  const probe = await electronDesktopE2eProbe();
  expect(probe.runtimeTarget).toBe(target);
  expect(probe.driver).toBe("electron");
  expect(probe.packaged).toBe(false);
  await ensureEnglishUi();
  await acceptLegalAndSkipFirstRun();
  return probe.platform;
}

async function openGameWindowsThroughVisibleUi(): Promise<void> {
  const sidebar = await $(".app-main-sidebar");
  await sidebar.waitForDisplayed({ timeout: 20_000 });
  const windows = await sidebar.$("button*=Windows");
  await windows.waitForClickable({ timeout: 10_000 });
  await windows.click();
  await waitForRoute("/game-windows");
}

async function waitForCreatedWindow(beforeIds: ReadonlySet<string>): Promise<GameWindow> {
  let created: GameWindow | undefined;
  await browser.waitUntil(async () => {
    const candidates = (await rendererCall("listGameWindows"))
      .filter((window) => !beforeIds.has(window.id));
    if (candidates.length !== 1) return false;
    created = candidates[0];
    return created.tabs.length === 0;
  }, {
    timeout: 15_000,
    timeoutMsg: "Visible Game Window creation did not persist one exact empty window"
  });
  return created!;
}

async function waitForNamedWindow(): Promise<GameWindow> {
  let gameWindow: GameWindow | undefined;
  await browser.waitUntil(async () => {
    const candidates = (await rendererCall("listGameWindows"))
      .filter((window) => window.name === WINDOW_NAME);
    if (candidates.length !== 1) return false;
    gameWindow = candidates[0];
    return gameWindow.tabs.length === 0;
  }, {
    timeout: 15_000,
    timeoutMsg: `Permanent Game Window ${WINDOW_NAME} was not continuous`
  });
  return gameWindow!;
}

async function renameThroughLabeledStandardInput(gameWindow: GameWindow): Promise<void> {
  const row = await $(`[data-selection-id='${gameWindow.id}']`);
  await row.waitForDisplayed({ timeout: 10_000 });
  await row.scrollIntoView({ block: "center", inline: "center" });
  const actions = await row.$("button[aria-label='Game window actions']");
  await actions.waitForClickable({ timeout: 10_000 });
  await actions.click();
  const menu = await $("[role='menu']");
  await menu.waitForDisplayed({ timeout: 10_000 });
  const rename = await menu.$(".//*[@role='menuitem' and normalize-space(.)='Rename']");
  await rename.waitForClickable({ timeout: 10_000 });
  await rename.click();

  const dialog = await $("dialog[open]");
  await dialog.waitForDisplayed({ timeout: 10_000 });
  const label = await dialog.$("label[for='rename-game-window-name']");
  await expect(label).toHaveText("Name");
  const input = await dialog.$("#rename-game-window-name");
  expect(await input.getTagName()).toBe("input");
  await input.clearValue();
  await input.setValue(WINDOW_NAME);
  const save = await dialog.$("button=Save");
  await save.waitForClickable({ timeout: 10_000 });
  await save.click();
  await dialog.waitForExist({ reverse: true, timeout: 10_000 });
  await waitForNamedWindow();
}

async function showThroughVisibleUi(
  gameWindow: GameWindow
): Promise<ElectronDesktopE2eGameWindowRuntimeInspection> {
  const row = await $(`[data-selection-id='${gameWindow.id}']`);
  await row.waitForDisplayed({ timeout: 10_000 });
  await row.scrollIntoView({ block: "center", inline: "center" });
  const show = await row.$("button[aria-label='Show']");
  await show.waitForClickable({ timeout: 10_000 });
  await show.click();

  let inspection: ElectronDesktopE2eGameWindowRuntimeInspection | undefined;
  let lastInspectionError: string | undefined;
  try {
    await browser.waitUntil(async () => {
      try {
        inspection = await electronDesktopE2eGameWindowRuntime(gameWindow.id);
        return inspection.currentRuntime?.visible === true &&
          inspection.currentRuntime.focused === true &&
          inspection.currentRuntime.nativeDisplay.presentation === gameWindow.placement.presentation;
      } catch (error) {
        lastInspectionError = error instanceof Error ? error.message : String(error);
        if (transientNativeInspectionError(lastInspectionError)) return false;
        throw error;
      }
    }, {
      interval: 100,
      timeout: 20_000,
      timeoutMsg: `Game Window ${gameWindow.id} did not reach exact visible native ownership`
    });
    await browser.waitUntil(async () => (await row.getText()).includes("Visible"), {
      timeout: 10_000,
      timeoutMsg: `Game Window ${gameWindow.id} did not present Visible status`
    });
  } catch (error) {
    const [saved, visibleRow] = await Promise.allSettled([
      rendererCall("listGameWindows"), row.getText()
    ]);
    await writeFile(resolve(required("RION_STUDIO_E2E_ARTIFACT_DIR"),
      "game-window-show-failure.json"), `${JSON.stringify({
      windowId: gameWindow.id, requestedSavedPlacement: gameWindow.placement,
      latestRuntimeInspection: inspection, lastInspectionError,
      waitFailure: error instanceof Error ? error.message : String(error),
      latestSavedWindow: saved.status === "fulfilled"
        ? saved.value.find(({ id }) => id === gameWindow.id) : String(saved.reason),
      visibleRowText: visibleRow.status === "fulfilled" ? visibleRow.value : String(visibleRow.reason)
    }, null, 2)}\n`);
    const detail = lastInspectionError ? ` Last transient inspection error: ${lastInspectionError}` : "";
    throw new Error(`Visible Show failed for Game Window ${gameWindow.id}.${detail}`, { cause: error });
  }
  visibleShowAdmissions.push({ windowId: gameWindow.id,
    requestedPlacement: gameWindow.placement, runtime: inspection!.currentRuntime });
  await writeFile(resolve(required("RION_STUDIO_E2E_ARTIFACT_DIR"),
    "game-window-visible-show-admissions.json"), `${JSON.stringify(visibleShowAdmissions, null, 2)}\n`);
  return inspection!;
}

function expectExactNativeIdentity(
  inspection: ElectronDesktopE2eGameWindowRuntimeInspection,
  platform: "macos" | "windows"
): void {
  const native = inspection.currentRuntime;
  expect(native).not.toBeNull();
  expect(native).toEqual(expect.objectContaining({
    coreTabIds: [],
    focused: true,
    nativeTabIds: [],
    visible: true,
    windowId: inspection.windowId
  }));
  expect(native?.parentNativeHostId).toBeGreaterThan(0);
  expect(native?.topologyRevision).toBeGreaterThan(0);
  expect(native?.windowGeneration).toBeGreaterThan(0);
  if (platform === "macos") {
    expect(native?.hostKind).toBe("appkit-chromium");
    expect(native?.appKitIdentity).toEqual({
      launchGeneration: native?.appKitIdentity?.launchGeneration,
      logicalWindowId: inspection.windowId,
      nativeGeneration: native?.appKitIdentity?.nativeGeneration
    });
    expect(native?.appKitIdentity?.launchGeneration).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
    );
    expect(native?.appKitIdentity?.nativeGeneration).toBeGreaterThan(0);
  } else {
    expect(native?.hostKind).toBe("bundled-chromium");
    expect(native?.appKitIdentity).toBeNull();
  }
}

function expectRetainedDisplayTarget(
  saved: GameWindow,
  initialTargetDisplay: GameWindow["targetDisplay"],
  topology: DisplayTopology
): void {
  const displays = topology.displays.filter(({ id }) => id === initialTargetDisplay.id);
  expect(displays).toHaveLength(1);
  const display = displays[0]!;
  expect(initialTargetDisplay).toEqual({
    id: display.id,
    fingerprint: {
      label: display.label,
      bounds: display.bounds,
      resolution: display.resolution,
      scaleFactor: display.scaleFactor,
      isPrimary: display.isPrimary,
      isInternal: display.isInternal
    }
  });
  expect(saved.targetDisplay).toEqual(initialTargetDisplay);
}

async function recordPresentationStage(
  stage: string,
  saved: GameWindow,
  runtime: ElectronDesktopE2eGameWindowRuntimeInspection["currentRuntime"],
  initialTargetDisplay: GameWindow["targetDisplay"]
): Promise<void> {
  const displayTopology = await rendererCall("getDisplayTopology");
  presentationStages.push({ stage, saved, runtime, initialTargetDisplay, displayTopology });
  await writeFile(resolve(required("RION_STUDIO_E2E_ARTIFACT_DIR"),
    "game-window-presentation-stages.json"), `${JSON.stringify(presentationStages, null, 2)}\n`);
  expectRetainedDisplayTarget(saved, initialTargetDisplay, displayTopology);
}

async function waitForSavedPresentation(input: Readonly<{
  gameWindow: GameWindow;
  initialTargetDisplay: GameWindow["targetDisplay"];
  platform: "macos" | "windows";
  presentation: Presentation;
  stage: string;
}>): Promise<Readonly<{
  saved: GameWindow;
  runtime: NonNullable<ElectronDesktopE2eGameWindowRuntimeInspection["currentRuntime"]>;
}>> {
  let saved: GameWindow | undefined;
  let runtime: ElectronDesktopE2eGameWindowRuntimeInspection["currentRuntime"] = null;
  let lastInspectionError: string | undefined;
  try {
    await browser.waitUntil(async () => {
      try {
        saved = await waitForNamedWindow();
        runtime = (await electronDesktopE2eGameWindowRuntime(input.gameWindow.id)).currentRuntime;
        const coherent = await electronDesktopE2eFullscreenToolbarRuntime(input.gameWindow.id);
        return saved.placement.presentation === input.presentation &&
          runtime?.nativeDisplay.presentation === input.presentation &&
          coherent.presentation === input.presentation && runtime.visible && runtime.focused;
      } catch (error) {
        lastInspectionError = error instanceof Error ? error.message : String(error);
        if (transientNativeInspectionError(lastInspectionError)) return false;
        throw error;
      }
    }, { interval: 100, timeout: 45_000,
      timeoutMsg: `Saved and exact native presentation did not agree at ${input.stage}` });
  } catch (error) {
    await writeFile(resolve(required("RION_STUDIO_E2E_ARTIFACT_DIR"),
      "game-window-presentation-failure.json"), `${JSON.stringify({
      stage: input.stage, expectedPresentation: input.presentation, saved, runtime,
      lastInspectionError
    }, null, 2)}\n`);
    const detail = lastInspectionError ? ` Last inspection error: ${lastInspectionError}` : "";
    throw new Error(`Saved/native presentation failed at ${input.stage}.${detail}`, { cause: error });
  }
  expect(saved!.placement.normalBounds).toEqual(input.gameWindow.placement.normalBounds);
  expectExactNativeIdentity({ currentRuntime: runtime, windowId: input.gameWindow.id }, input.platform);
  await recordPresentationStage(input.stage, saved!, runtime, input.initialTargetDisplay);
  return { saved: saved!, runtime: runtime! };
}

async function toggleVisibleFullscreen(windowId: string, platform: "macos" | "windows") {
  const { processId } = await electronDesktopE2eProbe();
  if (platform === "macos") {
    const inspection = await electronDesktopE2eGameWindowRuntime(windowId);
    expect(inspection.windowId).toBe(windowId);
    expectExactNativeIdentity(inspection, platform);
    fullscreenShortcutAdmissions.push({
      sequence: fullscreenShortcutAdmissions.length + 1,
      processId,
      nativePresentation: inspection.currentRuntime!.nativeDisplay.presentation,
      inspection
    });
    await writeFile(resolve(required("RION_STUDIO_E2E_ARTIFACT_DIR"),
      "game-window-fullscreen-shortcut-admissions.json"),
      `${JSON.stringify(fullscreenShortcutAdmissions, null, 2)}\n`);
    await pressVisibleMacosApplicationShortcut({ command: "toggleFullscreen", processId,
      runtimeWindowId: windowId, targetMode: "focused-runtime" });
  } else {
    const current = await electronDesktopE2eFullscreenToolbarRuntime(windowId);
    if (current.presentation === "fullscreen") {
      await revealVisibleFullscreenControls(windowId, platform);
    }
    const { nativeWindowHandle } = await electronDesktopE2eFullscreenToolbarRuntime(windowId);
    if (!nativeWindowHandle) throw new Error("Exact Game Window HWND is unavailable");
    await pressWindowsRuntimeWindowControl({ command: "toggleFullscreen", processId,
      nativeWindowHandle });
  }
}

async function revealVisibleFullscreenControls(windowId: string, platform: "macos" | "windows") {
  if (platform === "macos") {
    await movePointerToMacosFullscreenRevealEdge(windowId);
  } else {
    await movePointerToWindowsRuntimeContent(windowId);
    await movePointerToWindowsRuntimeHostRevealEdge(windowId);
  }
  await browser.waitUntil(async () => {
    const inspection = await electronDesktopE2eFullscreenToolbarRuntime(windowId);
    // An empty AppKit window has no visible tab strip; its three native
    // traffic lights still reveal and provide the visible close control.
    return inspection.presentation === "fullscreen" && inspection.native.nativeControlsVisible &&
      (platform === "macos" || inspection.native.toolbarVisible);
  }, { timeout: 15_000, timeoutMsg: "Fullscreen window controls did not become visible" });
}

async function closeAndReopenSavedPresentation(input: Readonly<{
  gameWindow: GameWindow;
  initialTargetDisplay: GameWindow["targetDisplay"];
  mainWindowHandle: string;
  platform: "macos" | "windows";
  presentation: Presentation;
}>): Promise<void> {
  const beforeClose = await electronDesktopE2eGameWindowRuntime(input.gameWindow.id);
  expectExactNativeIdentity(beforeClose, input.platform);
  if (input.presentation === "fullscreen") {
    await revealVisibleFullscreenControls(input.gameWindow.id, input.platform);
  }
  await closeVisibleRuntimeWindow({ ...input, windowId: input.gameWindow.id });
  await browser.waitUntil(async () =>
    (await electronDesktopE2eGameWindowRuntime(input.gameWindow.id)).currentRuntime === null,
  { timeout: 20_000, timeoutMsg: "Visible close did not retire the exact native Game Window" });
  const saved = await waitForNamedWindow();
  expect(saved.placement.presentation).toBe(input.presentation);
  expect(saved.placement.normalBounds).toEqual(input.gameWindow.placement.normalBounds);
  await recordPresentationStage(`${input.presentation}-closed`, saved, null, input.initialTargetDisplay);
  await showThroughVisibleUi(saved);
  const reopened = await waitForSavedPresentation({ ...input, stage: `${input.presentation}-reopened` });
  nativeRecreations.push({ presentation: input.presentation,
    beforeClose: beforeClose.currentRuntime, afterReopen: reopened.runtime });
  await writeFile(resolve(required("RION_STUDIO_E2E_ARTIFACT_DIR"),
    "game-window-native-recreations.json"), `${JSON.stringify(nativeRecreations, null, 2)}\n`);
  expect(reopened.runtime.windowGeneration).toBeGreaterThan(beforeClose.currentRuntime!.windowGeneration);
  if (input.platform === "macos") {
    // The new controller applies saved presentation after visible admission;
    // the retired controller cannot satisfy its native placement/layout ACK.
    expect(reopened.runtime.appKitIdentity!.nativeGeneration)
      .toBeGreaterThan(beforeClose.currentRuntime!.appKitIdentity!.nativeGeneration);
  }
}

describe("Chromium permanent Game Window UI", () => {
  it("preserves native presentation through visible close, Show, and clean app restart", async () => {
    const phase = required("RION_STUDIO_E2E_PHASE");
    expect([
      "chromium-game-window-ui-seed",
      "chromium-game-window-ui-restart"
    ]).toContain(phase);
    const platform = await preparePhase();
    const mainWindowHandle = await browser.getWindowHandle();
    await openGameWindowsThroughVisibleUi();

    let gameWindow: GameWindow;
    let initialSavedWindow: GameWindow;
    if (phase === "chromium-game-window-ui-seed") {
      const before = new Set((await rendererCall("listGameWindows")).map((window) => window.id));
      const create = await $("button=New game window");
      await create.waitForClickable({ timeout: 10_000 });
      await create.click();
      gameWindow = await waitForCreatedWindow(before);
      initialSavedWindow = gameWindow;
      await renameThroughLabeledStandardInput(gameWindow);
      gameWindow = await waitForNamedWindow();
    } else {
      gameWindow = await waitForNamedWindow();
      initialSavedWindow = gameWindow;
      const row = await $(`[data-selection-id='${gameWindow.id}']`);
      await row.waitForDisplayed({ timeout: 10_000 });
      expect(await row.getText()).toContain(WINDOW_NAME);
      expect(gameWindow.tabs).toEqual([]);
    }

    const initialTargetDisplay = initialSavedWindow.targetDisplay;
    const displayTopology = await rendererCall("getDisplayTopology");
    await writeFile(resolve(required("RION_STUDIO_E2E_ARTIFACT_DIR"),
      "game-window-display-identity.json"), `${JSON.stringify({
      phase, windowId: gameWindow.id, initialSavedWindow, savedBeforeShow: gameWindow, displayTopology
    }, null, 2)}\n`);
    expectRetainedDisplayTarget(gameWindow, initialTargetDisplay, displayTopology);
    const requestedSavedPlacement = gameWindow.placement;
    const inspection = await showThroughVisibleUi(gameWindow);
    expect(inspection.windowId).toBe(gameWindow.id);
    expectExactNativeIdentity(inspection, platform);
    const baselinePresentation = platform === "windows" ? "maximized" : "fullscreen";
    if (phase === "chromium-game-window-ui-restart") {
      expect(gameWindow.placement.presentation).toBe(baselinePresentation);
      await waitForSavedPresentation({ gameWindow, initialTargetDisplay, platform,
        presentation: baselinePresentation, stage: "restart-restored" });
      return;
    }

    gameWindow = await waitForNamedWindow();
    const baseline = await waitForSavedPresentation({ gameWindow, initialTargetDisplay, platform,
      presentation: "normal", stage: "normal-baseline" });
    await writeFile(resolve(required("RION_STUDIO_E2E_ARTIFACT_DIR"),
      "game-window-initial-show.json"), `${JSON.stringify({
      windowId: gameWindow.id, requestedSavedPlacement, savedWindow: baseline.saved,
      runtime: baseline.runtime
    }, null, 2)}\n`);
    expect(baseline.runtime.nativeDisplay.bounds).toEqual(baseline.saved.placement.normalBounds);
    if ((["x", "y", "width", "height"] as const).some(key =>
      requestedSavedPlacement.normalBounds[key] !== baseline.saved.placement.normalBounds[key])) {
      expect(baseline.runtime.topologyRevision).toBeGreaterThan(1);
    }
    await toggleVisibleFullscreen(gameWindow.id, platform);
    await waitForSavedPresentation({ gameWindow, initialTargetDisplay, platform,
      presentation: "fullscreen", stage: "fullscreen-applied" });
    await closeAndReopenSavedPresentation({ gameWindow, initialTargetDisplay, mainWindowHandle, platform,
      presentation: "fullscreen" });
    await toggleVisibleFullscreen(gameWindow.id, platform);
    await waitForSavedPresentation({ gameWindow, initialTargetDisplay, platform,
      presentation: "normal", stage: "normal-restored" });
    await clickVisibleRuntimeWindowControl({ command: "maximize", mainWindowHandle,
      platform, windowId: gameWindow.id });
    await waitForSavedPresentation({ gameWindow, initialTargetDisplay, platform,
      presentation: "maximized", stage: "maximized-applied" });
    await closeAndReopenSavedPresentation({ gameWindow, initialTargetDisplay, mainWindowHandle, platform,
      presentation: "maximized" });
    if (platform === "macos") {
      await clickVisibleRuntimeWindowControl({ command: "maximize", mainWindowHandle,
        platform, windowId: gameWindow.id });
      await waitForSavedPresentation({ gameWindow, initialTargetDisplay, platform,
        presentation: "normal", stage: "normal-after-maximize" });
      await toggleVisibleFullscreen(gameWindow.id, platform);
      await waitForSavedPresentation({ gameWindow, initialTargetDisplay, platform,
        presentation: "fullscreen", stage: "fullscreen-baseline" });
    }
  });
});
