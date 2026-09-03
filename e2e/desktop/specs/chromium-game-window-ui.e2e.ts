import { $, browser, expect } from "@wdio/globals";

import type { GameWindow } from "../../../src/shared/types";
import {
  electronDesktopE2eGameWindowRuntime,
  electronDesktopE2eProbe,
  type ElectronDesktopE2eGameWindowRuntimeInspection
} from "../support/electron-driver";
import { rendererCall } from "../support/renderer-bridge";
import {
  acceptLegalAndSkipFirstRun,
  ensureEnglishUi,
  waitForRoute
} from "../support/ui";

// [journey:CHROMIUM-MACOS-APPKIT-GAME-WINDOW-UI-016]
// [journey:CHROMIUM-WINDOWS-GAME-WINDOW-UI-016]

const WINDOW_NAME = "Chromium E2E Game Window";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the Chromium Game Window journey`);
  return value;
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
  await browser.waitUntil(async () => {
    try {
      inspection = await electronDesktopE2eGameWindowRuntime(gameWindow.id);
      return inspection.currentRuntime?.visible === true &&
        inspection.currentRuntime.focused === true;
    } catch {
      return false;
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

describe("Chromium permanent Game Window UI", () => {
  it("creates, renames, shows, and reopens one exact empty native Game Window", async () => {
    const phase = required("RION_STUDIO_E2E_PHASE");
    expect([
      "chromium-game-window-ui-seed",
      "chromium-game-window-ui-restart"
    ]).toContain(phase);
    const platform = await preparePhase();
    await openGameWindowsThroughVisibleUi();

    let gameWindow: GameWindow;
    if (phase === "chromium-game-window-ui-seed") {
      const before = new Set((await rendererCall("listGameWindows")).map((window) => window.id));
      const create = await $("button=New game window");
      await create.waitForClickable({ timeout: 10_000 });
      await create.click();
      gameWindow = await waitForCreatedWindow(before);
      await renameThroughLabeledStandardInput(gameWindow);
      gameWindow = await waitForNamedWindow();
    } else {
      gameWindow = await waitForNamedWindow();
      const row = await $(`[data-selection-id='${gameWindow.id}']`);
      await row.waitForDisplayed({ timeout: 10_000 });
      expect(await row.getText()).toContain(WINDOW_NAME);
      expect(gameWindow.tabs).toEqual([]);
    }

    const inspection = await showThroughVisibleUi(gameWindow);
    expect(inspection.windowId).toBe(gameWindow.id);
    expectExactNativeIdentity(inspection, platform);
  });
});
