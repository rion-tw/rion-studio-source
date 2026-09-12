import { $, browser, expect } from "@wdio/globals";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { GameWindow } from "../../../src/shared/types";
import {
  electronDesktopE2eGameWindowRuntime,
  electronDesktopE2eFullscreenToolbarRuntime,
  electronDesktopE2eProbe
} from "../support/electron-driver";
import { submitElectronRoleKeyPhases, submitElectronRolePageFullscreenShortcut } from
  "../support/electron-role-surface";
import { clickMacosVisibleFullscreenControl } from "../support/macos-appkit-ui";
import {
  clickVisibleRuntimeWindowControl,
  dragVisibleRuntimeWindow,
  resizeVisibleRuntimeWindow,
  runtimeWindowIsMinimized
} from "../support/native-runtime-tabs";
import { pressVisibleMacosApplicationShortcut } from
  "../support/native-application-actions";
import { rendererCall } from "../support/renderer-bridge";
import {
  acceptLegalAndSkipFirstRun,
  ensureEnglishUi,
  waitForRoute
} from "../support/ui";

// [journey:CHROMIUM-MACOS-APPKIT-GAME-WINDOWS-NATIVE-001]
// [journey:CHROMIUM-WINDOWS-GAME-WINDOWS-NATIVE-001]
// [journey:CHROMIUM-MACOS-APPKIT-NATIVE-DISPLAY-001]
// [journey:CHROMIUM-WINDOWS-NATIVE-DISPLAY-001]

const WINDOW_NAME = "Chromium Tabs Window";
const nativeStages: unknown[] = [];

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the native display journey`);
  return value;
}

async function openWindows(): Promise<void> {
  const sidebar = await $(".app-main-sidebar");
  await sidebar.waitForDisplayed({ timeout: 20_000 });
  const windows = await sidebar.$("button*=Windows");
  await windows.waitForClickable({ timeout: 10_000 });
  await windows.click();
  await waitForRoute("/game-windows");
}

async function exactWindow(): Promise<GameWindow> {
  const matches = (await rendererCall("listGameWindows"))
    .filter((candidate) => candidate.name === WINDOW_NAME);
  expect(matches).toHaveLength(1);
  expect(matches[0]!.tabs).toHaveLength(3);
  return matches[0]!;
}

async function inspection(windowId: string) {
  return (await electronDesktopE2eGameWindowRuntime(windowId)).currentRuntime;
}

async function waitNative(
  windowId: string,
  predicate: (runtime: NonNullable<Awaited<ReturnType<typeof inspection>>>) => boolean,
  message: string
) {
  let current: Awaited<ReturnType<typeof inspection>> = null;
  await browser.waitUntil(async () => {
    current = await inspection(windowId);
    if (current === null || !predicate(current)) return false;
    // The renderer runtime summary follows native slots; only this inspection
    // also checks the Rust Kernel placement and matching projection revisions.
    const coherent = await electronDesktopE2eFullscreenToolbarRuntime(windowId);
    if (coherent.presentation !== current.nativeDisplay.presentation) return false;
    nativeStages.push({ criterion: message, native: current, coherent });
    return true;
  }, { interval: 100, timeout: 45_000, timeoutMsg: message });
  await writeFile(resolve(required("RION_STUDIO_E2E_ARTIFACT_DIR"), "native-window-control-stages.json"),
    `${JSON.stringify(nativeStages, null, 2)}\n`);
  return current!;
}

describe("Chromium native Game Window and real display parity", () => {
  it("uses visible native controls and a real secondary display", async () => {
    expect(required("RION_STUDIO_E2E_PHASE"))
      .toBe("chromium-native-window-display-extended");
    const probe = await electronDesktopE2eProbe();
    const platform = probe.platform;
    await ensureEnglishUi();
    await acceptLegalAndSkipFirstRun();
    const mainWindowHandle = await browser.getWindowHandle();
    const topology = await rendererCall("getDisplayTopology");
    if (topology.displays.length < 2) {
      throw new Error("BLOCKED: Chromium native display profile requires two real displays");
    }
    const target = topology.displays.find((display) => !display.isPrimary);
    if (!target) throw new Error("BLOCKED: a real secondary display is unavailable");

    await openWindows();
    let gameWindow = await exactWindow();
    const row = await $(`[data-selection-id='${gameWindow.id}']`);
    const actions = await row.$("button[aria-label='Game window actions']");
    await actions.waitForClickable({ timeout: 10_000 });
    await actions.click();
    const menu = await $("[role='menu']");
    const displayMenu = await menu.$(
      ".//*[@role='menuitem' and normalize-space(.)='Target display']"
    );
    await displayMenu.moveTo();
    await browser.keys("ArrowRight");
    const targetItem = await $(
      `.//*[@role='menuitemradio' and starts-with(normalize-space(.), '${target.label}')]`
    );
    await targetItem.waitForDisplayed({ timeout: 10_000 });
    expect(await targetItem.getAttribute("aria-checked")).toBe("false");
    const itemCount = await browser.execute(() =>
      document.querySelectorAll("[role='menuitemradio']").length
    );
    let targetFocused = false;
    for (let index = 0; index < itemCount; index += 1) {
      targetFocused = await browser.execute((target: HTMLElement) =>
        document.activeElement === target, targetItem as unknown as HTMLElement
      );
      if (targetFocused) break;
      await browser.keys("ArrowDown");
    }
    expect(targetFocused).toBe(true);
    await browser.execute((expectedTarget: HTMLElement) => {
      document.documentElement.removeAttribute("data-rion-e2e-display-key");
      document.addEventListener("keydown", (event) => {
        document.documentElement.setAttribute("data-rion-e2e-display-key", JSON.stringify({
          expectedTarget: event.composedPath().includes(expectedTarget),
          targetLabel: (event.target as HTMLElement | null)?.textContent,
          trusted: event.isTrusted,
          key: event.key,
          altKey: event.altKey, ctrlKey: event.ctrlKey,
          metaKey: event.metaKey, shiftKey: event.shiftKey
        }));
      }, { capture: true, once: true });
    }, targetItem as unknown as HTMLElement);
    await browser.keys("Enter");
    const keyReceipt = await browser.execute(() => {
      const value = document.documentElement.getAttribute("data-rion-e2e-display-key");
      document.documentElement.removeAttribute("data-rion-e2e-display-key");
      return value === null ? null : JSON.parse(value);
    });
    await writeFile(resolve(required("RION_STUDIO_E2E_ARTIFACT_DIR"), "display-selection-key.json"),
      `${JSON.stringify({ target, topology, keyReceipt }, null, 2)}\n`);
    expect(keyReceipt).toEqual(expect.objectContaining({
      expectedTarget: true, trusted: true, key: "Enter",
      altKey: false, ctrlKey: false, metaKey: false, shiftKey: false
    }));
    await browser.waitUntil(async () => {
      gameWindow = await exactWindow();
      return gameWindow.targetDisplay.id === target.id &&
        JSON.stringify(gameWindow.placement.savedWorkArea) === JSON.stringify(target.workArea);
    }, { timeout: 15_000, timeoutMsg: "Visible target-display selection did not persist" });

    const show = await row.$("button[aria-label='Show']");
    await show.waitForClickable({ timeout: 10_000 });
    await show.click();
    let native = await waitNative(gameWindow.id, (runtime) =>
      runtime.visible && runtime.focused && runtime.nativeTabIds.length === 3 &&
      runtime.nativeDisplay.displayId === target.id,
    "Native host did not restore on the exact secondary display");
    expect(native.nativeDisplay).toEqual(expect.objectContaining({
      displayId: target.id,
      scaleFactor: target.scaleFactor,
      workArea: target.workArea
    }));

    const initialBounds = native.nativeDisplay.bounds;
    await dragVisibleRuntimeWindow({ mainWindowHandle, platform, windowId: gameWindow.id });
    native = await waitNative(gameWindow.id, (runtime) =>
      runtime.nativeDisplay.bounds.x !== initialBounds.x ||
      runtime.nativeDisplay.bounds.y !== initialBounds.y,
    "Native titlebar drag did not commit new bounds");
    const draggedBounds = native.nativeDisplay.bounds;
    await resizeVisibleRuntimeWindow(platform, gameWindow.id);
    native = await waitNative(gameWindow.id, (runtime) =>
      runtime.nativeDisplay.bounds.width !== draggedBounds.width ||
      runtime.nativeDisplay.bounds.height !== draggedBounds.height,
    "Native edge resize did not commit new bounds");
    expect(native.nativeDisplay.displayId).toBe(target.id);

    await clickVisibleRuntimeWindowControl({ command: "maximize", mainWindowHandle, platform, windowId: gameWindow.id });
    await waitNative(gameWindow.id, (runtime) =>
      runtime.nativeDisplay.presentation === "maximized", "Native maximize did not commit");
    await clickVisibleRuntimeWindowControl({ command: "maximize", mainWindowHandle, platform, windowId: gameWindow.id });
    native = await waitNative(gameWindow.id, (runtime) =>
      runtime.nativeDisplay.presentation === "normal", "Native maximize restore did not commit");

    const activeSourceId = gameWindow.tabs.find(
      (tab) => tab.id === gameWindow.activeTabId
    )!.sourceId;
    const activeRole = (await rendererCall("listRoles")).find(
      (role) => role.id === activeSourceId
    )!;
    const activeRoleUrl = activeRole.launchUrl;
    await submitElectronRoleKeyPhases(activeRoleUrl, mainWindowHandle, [
      { key: "y", phase: "keyDown" },
      { key: "y", phase: "keyUp" }
    ], { windowId: gameWindow.id });
    await waitNative(gameWindow.id, (runtime) =>
      runtime.nativeDisplay.presentation === "normal",
    "A plain Role key unexpectedly changed native window placement");
    if (platform === "macos") {
      await clickMacosVisibleFullscreenControl(gameWindow.id);
    } else {
      await submitElectronRolePageFullscreenShortcut(activeRoleUrl, mainWindowHandle, gameWindow.id);
    }
    await waitNative(gameWindow.id, (runtime) =>
      runtime.nativeDisplay.presentation === "fullscreen", "Native fullscreen did not commit");
    if (platform === "macos") {
      await pressVisibleMacosApplicationShortcut({
        command: "toggleFullscreen",
        processId: probe.processId,
        runtimeTabName: activeRole.name,
        targetMode: "focused-runtime"
      });
    } else {
      await submitElectronRolePageFullscreenShortcut(activeRoleUrl, mainWindowHandle, gameWindow.id);
    }
    await waitNative(gameWindow.id, (runtime) =>
      runtime.nativeDisplay.presentation === "normal", "Native fullscreen exit did not commit");

    await clickVisibleRuntimeWindowControl({ command: "minimize", mainWindowHandle, platform, windowId: gameWindow.id });
    await browser.waitUntil(() => runtimeWindowIsMinimized(platform, gameWindow.id), {
      timeout: 15_000,
      timeoutMsg: "Visible native minimize control did not reach OS minimized state"
    });
    await writeFile(
      resolve(required("RION_STUDIO_E2E_ARTIFACT_DIR"), "chromium-native-display.json"),
      `${JSON.stringify({ gameWindow, native, platform, target, topology }, null, 2)}\n`
    );
  });
});
