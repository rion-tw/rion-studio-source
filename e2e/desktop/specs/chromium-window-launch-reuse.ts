import { clickConfirmation, clickEntityMenuAction, waitForRoute } from "../support/ui";
import { $, browser, expect } from "@wdio/globals";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { GameWindow, Role } from "../../../src/shared/types";
import { electronDesktopE2eApplicationShortcutRuntime, electronDesktopE2eFullscreenToolbarRuntime, electronDesktopE2eGameWindowRuntime } from "../support/electron-driver";
import { pressVisibleMacosApplicationShortcut, pressVisibleWindowsApplicationShortcut } from "../support/native-application-actions";
import { macosNativeWindowControl } from "../support/macos-native-window-controls";
import { selectMacosVisibleRuntimeLauncherRole } from "../support/macos-appkit-ui";
import { clickVisibleRuntimeTab, clickVisibleRuntimeWindowControl, closeVisibleRuntimeTab, runtimeTabShellErrors } from "../support/native-runtime-tabs";
import { rendererCall } from "../support/renderer-bridge";

/** Reuses one exact host through a visible presentation change and consecutive launches. */
export async function exerciseWindowLaunchReuse(input: {
  mainWindowHandle: string;
  platform: "macos" | "windows";
  processId: number;
  window: GameWindow;
  roles: readonly Role[];
  launchRole: (role: Role, window: GameWindow) => Promise<string>;
}): Promise<void> {
  const roles = input.roles.slice(0, 3);
  const windowId = input.window.id;
  const tabIds = [await input.launchRole(roles[0]!, input.window)];
  const before = await electronDesktopE2eGameWindowRuntime(windowId);
  await clickVisibleRuntimeTab({ ...input, tabId: tabIds[0]!, tabName: roles[0]!.name });
  await clickVisibleRuntimeWindowControl({ ...input, windowId, tabId: tabIds[0]!, command: "maximize" });
  await browser.waitUntil(async () => (await rendererCall("getEmbeddedRuntimeState")).windows
    .find(window => window.id === windowId)?.presentation === "maximized", { timeout: 20_000 });
  for (const expected of [1.05, 1.1]) {
    if (input.platform === "macos") await pressVisibleMacosApplicationShortcut({
      command: "zoomIn", processId: input.processId, runtimeWindowId: windowId,
      targetMode: "focused-runtime"
    });
    else await pressVisibleWindowsApplicationShortcut({
      command: "zoomIn", processId: input.processId, targetMode: "focused-runtime",
      nativeWindowHandle: (await electronDesktopE2eFullscreenToolbarRuntime(windowId)).nativeWindowHandle
    });
    await browser.waitUntil(async () => (await electronDesktopE2eApplicationShortcutRuntime(windowId))
      .nativeWindow.windowZoomFactor === expected, { timeout: 20_000 });
  }
  if (input.platform === "macos") {
    await clickVisibleRuntimeWindowControl({ ...input, windowId, tabId: tabIds[0]!, command: "maximize" });
    await browser.waitUntil(async () => (await rendererCall("getEmbeddedRuntimeState")).windows
      .find(window => window.id === windowId)?.presentation === "normal", { timeout: 20_000 });
    const geometry = (await electronDesktopE2eGameWindowRuntime(windowId)).currentRuntime!.nativeDisplay;
    await macosNativeWindowControl("drag", windowId, {
      x: geometry.workArea.x - geometry.bounds.x - 120, y: 0
    });
    await browser.waitUntil(async () => {
      const native = (await electronDesktopE2eGameWindowRuntime(windowId)).currentRuntime!.nativeDisplay;
      return native.bounds.x < native.workArea.x;
    }, { timeout: 20_000, timeoutMsg: "The physical drag did not cross the display work-area edge" });
  }
  const evidence: unknown[] = [{ stage: "before-presentation-change", before }];
  for (const role of roles.slice(1)) {
    if (input.platform === "macos") {
      await selectMacosVisibleRuntimeLauncherRole({ windowId, roleName: role.name });
      await browser.waitUntil(async () => {
        expect(await runtimeTabShellErrors()).toEqual([]);
        return (await rendererCall("listRoleStatuses")).some(status => status.roleId === role.id && status.state === "running");
      }, { timeout: 30_000, timeoutMsg: "Existing window rejected a consecutive native launcher action" });
      const tab = (await rendererCall("getEmbeddedRuntimeState")).tabs.find(tab => tab.sourceId === role.id && tab.windowId === windowId);
      expect(tab).toBeDefined();
      tabIds.push(tab!.id);
    } else tabIds.push(await input.launchRole(role, input.window));
    const after = await electronDesktopE2eGameWindowRuntime(windowId);
    expect(after.currentRuntime!.coreTabIds).toEqual(tabIds);
    expect(after.currentRuntime!.nativeTabIds).toEqual(tabIds);
    expect(after.currentRuntime!.windowGeneration).toBe(before.currentRuntime!.windowGeneration);
    expect(after.currentRuntime!.parentNativeHostId).toBe(before.currentRuntime!.parentNativeHostId);
    expect(after.currentRuntime!.appKitIdentity).toEqual(before.currentRuntime!.appKitIdentity);
    const zoom = await electronDesktopE2eApplicationShortcutRuntime(windowId);
    expect(zoom.nativeWindow.windowZoomFactor).toBe(1.1);
    expect(zoom.roleSurfaces).toHaveLength(tabIds.length);
    for (const surface of zoom.roleSurfaces) {
      expect(surface.appliedZoomFactor).toBe(surface.baseZoomFactor * 1.1);
    }
    expect(await runtimeTabShellErrors()).toEqual([]);
    evidence.push({ stage: "consecutive-launch", roleId: role.id, after });
  }
  await writeFile(resolve(process.env.RION_STUDIO_E2E_ARTIFACT_DIR!, "window-launch-reuse-evidence.json"), JSON.stringify(evidence, null, 2));
  // Return the fixture to normal geometry before the shared tab-close helper.
  await clickVisibleRuntimeTab({ ...input, tabId: tabIds.at(-1)!, tabName: roles.at(-1)!.name });
  if (input.platform === "windows") await clickVisibleRuntimeWindowControl({
    ...input, windowId, tabId: tabIds.at(-1)!, command: "maximize"
  });
  await browser.waitUntil(async () => (await rendererCall("getEmbeddedRuntimeState")).windows
    .find(window => window.id === windowId)?.presentation === "normal", { timeout: 20_000 });
  for (let index = tabIds.length - 1; index >= 0; index--) {
    await closeVisibleRuntimeTab({ ...input, windowId, tabId: tabIds[index]!, tabName: roles[index]!.name });
    await browser.waitUntil(async () => !(await rendererCall("getEmbeddedRuntimeState")).tabs.some(tab => tab.id === tabIds[index]), { timeout: 20_000 });
  }
  await $(".app-main-sidebar").$("button*=Windows").click();
  await waitForRoute("/game-windows");
  await clickEntityMenuAction(windowId, "Game window actions", "Delete window");
  await clickConfirmation("Delete");
  await browser.waitUntil(async () => !(await rendererCall("listGameWindows")).some(window => window.id === windowId), { timeout: 20_000 });
}
