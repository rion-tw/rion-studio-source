import { browser, expect } from "@wdio/globals";
import type { Role } from "../../../src/shared/types";
import { openCutoverWorkspace, stopCutoverWindow, waitCutoverWorkspaceTab } from "./chromium-workspace-cutover";
import { electronDesktopE2eFullscreenToolbarRuntime, electronDesktopE2eProbe } from "./electron-driver";
import { pressVisibleMacosApplicationShortcut, pressVisibleWindowsApplicationShortcut } from "./native-application-actions";
import { rendererCall } from "./renderer-bridge";
import { verifyWorkspaceWebNavigation } from "./workspace-web-navigation";

/** Temporary entity fixtures are deterministic preconditions. Launch, navigation,
 * fullscreen and close use visible UI, with Core/native state as evidence only. */
export async function verifyTwoRoleWorkspaceWebRecovery(platform: "macos" | "windows", role: Role): Promise<void> {
  const mainWindowHandle = await browser.getWindowHandle();
  const base = process.env.RION_STUDIO_E2E_FIXTURE_ORIGIN!;
  const second = await rendererCall("createRole", {
    gameId: role.gameId, name: "Web recovery temporary role", launchUrl: `${base}/role/web-recovery-second`
  });
  const workspace = await rendererCall("createLaunchWorkspace", {
    name: "Web recovery two roles", template: "main_left_stack_right",
    slots: [{ web: { lastUrl: `${base}/web-navigation` } }, { roleId: role.id }, { roleId: second.id }]
  });
  await openCutoverWorkspace(workspace, "new-window");
  const tab = await waitCutoverWorkspaceTab(workspace, [
    { roleId: role.id, state: "running" }, { roleId: second.id, state: "running" }
  ]);
  try {
    const { processId } = await electronDesktopE2eProbe();
    const before = await electronDesktopE2eFullscreenToolbarRuntime(tab.windowId);
    if (before.presentation !== "fullscreen") {
      if (platform === "macos") await pressVisibleMacosApplicationShortcut({ command: "toggleFullscreen",
        processId, runtimeWindowId: tab.windowId, targetMode: "focused-runtime" });
      else await pressVisibleWindowsApplicationShortcut({ command: "toggleFullscreen", processId,
        nativeWindowHandle: before.nativeWindowHandle, targetMode: "focused-runtime" });
    }
    await browser.waitUntil(async () =>
      (await electronDesktopE2eFullscreenToolbarRuntime(tab.windowId)).presentation === "fullscreen",
    { timeout: 30_000, timeoutMsg: "Mixed Web workspace did not enter native fullscreen" });
    expect(tab.slots.filter(slot => slot.roleId)).toHaveLength(2);
    const chromeShellUrl = await browser.electron.execute(electron => {
      const shells = electron.webContents.getAllWebContents().filter(contents =>
        contents.getURL().endsWith("/runtime-web-chrome-electron.html"));
      if (shells.length !== 1) throw new Error("Expected one exact mixed-workspace Web toolbar");
      return shells[0].getURL();
    });
    await verifyWorkspaceWebNavigation({ chromeShellUrl, contentUrl: `${base}/web-navigation`,
      mainWindowHandle, roleIds: [role.id, second.id] });
  } finally {
    const current = await electronDesktopE2eFullscreenToolbarRuntime(tab.windowId);
    if (current.presentation === "fullscreen") {
      const { processId } = await electronDesktopE2eProbe();
      if (platform === "macos") await pressVisibleMacosApplicationShortcut({ command: "toggleFullscreen",
        processId, runtimeWindowId: tab.windowId, targetMode: "focused-runtime" });
      else await pressVisibleWindowsApplicationShortcut({ command: "toggleFullscreen", processId,
        nativeWindowHandle: current.nativeWindowHandle, targetMode: "focused-runtime" });
      await browser.waitUntil(async () =>
        (await electronDesktopE2eFullscreenToolbarRuntime(tab.windowId)).presentation === "normal",
      { timeout: 30_000, timeoutMsg: "Mixed Web workspace did not leave native fullscreen" });
    }
    await stopCutoverWindow({ mainWindowHandle, platform, tab });
    await rendererCall("deleteLaunchWorkspace", workspace.id);
    await rendererCall("deleteRole", second.id);
  }
}
