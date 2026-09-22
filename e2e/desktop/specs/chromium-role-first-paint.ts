import { $, browser, expect } from "@wdio/globals";
import type { GameWindow, Role } from "../../../src/shared/types";
import { electronDesktopE2eFullscreenToolbarRuntime, electronDesktopE2eGameWindowRuntime } from "../support/electron-driver";
import { closeVisibleRuntimeTab, runtimeTabShellErrors } from "../support/native-runtime-tabs";
import { rendererCall } from "../support/renderer-bridge";
import { clickConfirmation, clickEntityMenuAction, waitForRoute } from "../support/ui";
import { captureWorkspacePixels } from "../support/workspace-pixels";

/** Screen observation must not focus, resize, or select a tab to make it paint. */
export async function expectRolePaint(windowId: string, tabId: string,
  color: "green" | "blue", name: string): Promise<void> {
  const inspection = await electronDesktopE2eFullscreenToolbarRuntime(windowId);
  const surface = inspection.surfaces.find(candidate => candidate.tabId === tabId)!;
  expect(surface.visible).toBe(true);
  expect(inspection.surfaces.filter(candidate => candidate.visible)).toHaveLength(1);
  const { x, y, width, height } = surface.bounds;
  const evidence = await captureWorkspacePixels({ inspection, observeOnly: true, windowEdges: true,
    name, reference: surface.bounds, region: surface.bounds,
    points: [{ x: x + 5, y: y + height / 2 }, { x: x + width - 5, y: y + height / 2 }] });
  for (const [r, g, b] of evidence.samples) {
    expect(color === "green" ? g! > 175 && g! > r! + 60 && g! > b! + 60
      : b! > 175 && b! > r! + 60 && b! > g! + 60).toBe(true);
  }
}

async function setBackground(background: "material" | "black"): Promise<void> {
  await $(".app-main-sidebar").$("button*=Settings").click();
  await waitForRoute("/settings");
  await $(".settings-mode-sidebar").$("button=Interface settings").click();
  await waitForRoute("/settings?section=interface");
  const control = await $(`button=${background === "black" ? "Solid black" : "Transparent material"}`);
  await control.waitForClickable({ timeout: 10_000 });
  await control.click();
  await browser.waitUntil(async () => (await rendererCall("getGameBrowserSettings")).workspace.background === background,
    { timeout: 20_000 });
  await $(".settings-back").click();
  await $(".app-main-sidebar").waitForDisplayed({ timeout: 20_000 });
}

export async function exerciseRoleFirstPaint(input: {
  mainWindowHandle: string;
  platform: "macos" | "windows";
  roles: readonly Role[];
  createWindow: (name: string) => Promise<GameWindow>;
  launchRole: (role: Role, window: GameWindow) => Promise<string>;
}): Promise<void> {
  const previousBackground = (await rendererCall("getGameBrowserSettings")).workspace.background;
  for (const background of ["black", "material"] as const) {
    await setBackground(background);
    const window = await input.createWindow(`Role first paint ${background}`);
    const roles = input.roles.slice(0, 2);
    const tabIds: string[] = [];
    let initialBounds: unknown;
    for (const [index, role] of roles.entries()) {
      const tabId = await input.launchRole(role, window);
      tabIds.push(tabId);
      await expectRolePaint(window.id, tabId, index === 0 ? "green" : "blue", `first-paint-${background}-${index}`);
      const bounds = (await electronDesktopE2eGameWindowRuntime(window.id)).currentRuntime!.nativeDisplay.bounds;
      if (index === 0) initialBounds = bounds;
      else expect(bounds).toEqual(initialBounds);
    }
    await closeVisibleRuntimeTab({ ...input, windowId: window.id, tabId: tabIds[1]!, tabName: roles[1]!.name });
    await browser.waitUntil(async () => !(await rendererCall("getEmbeddedRuntimeState")).tabs.some(tab => tab.id === tabIds[1]),
      { timeout: 20_000 });
    await expectRolePaint(window.id, tabIds[0]!, "green", `first-paint-${background}-surviving-role`);
    const reopened = await input.launchRole(roles[1]!, window);
    expect(reopened).toBe(tabIds[1]);
    await expectRolePaint(window.id, reopened, "blue", `first-paint-${background}-reopened`);
    expect((await electronDesktopE2eGameWindowRuntime(window.id)).currentRuntime!.nativeDisplay.bounds).toEqual(initialBounds);
    for (let index = tabIds.length - 1; index >= 0; index--) {
      await closeVisibleRuntimeTab({ ...input, windowId: window.id, tabId: tabIds[index]!, tabName: roles[index]!.name });
      await browser.waitUntil(async () => !(await rendererCall("getEmbeddedRuntimeState")).tabs.some(tab => tab.id === tabIds[index]),
        { timeout: 20_000 });
    }
    await $(".app-main-sidebar").$("button*=Windows").click();
    await waitForRoute("/game-windows");
    await clickEntityMenuAction(window.id, "Game window actions", "Delete window");
    await clickConfirmation("Delete");
    await browser.waitUntil(async () => !(await rendererCall("listGameWindows")).some(candidate => candidate.id === window.id),
      { timeout: 20_000 });
    expect(await runtimeTabShellErrors()).toEqual([]);
  }
  await setBackground(previousBackground);
}
