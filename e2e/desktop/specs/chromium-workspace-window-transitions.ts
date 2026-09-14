import { browser, expect } from "@wdio/globals";
import { electronDesktopE2eFullscreenToolbarRuntime as inspect, electronDesktopE2eProbe } from "../support/electron-driver";
import { clickVisibleRuntimeWindowControl } from "../support/native-runtime-tabs";
import { focusVisibleMacosAppKitRuntime, pressVisibleMacosApplicationShortcut, pressVisibleWindowsApplicationShortcut } from "../support/native-application-actions";
import { expectWorkspacePixels } from "./chromium-workspace-gap-evidence";

export async function exerciseWorkspaceWindowTransitions(input: {
  windowId: string; tabId: string; mainWindowHandle: string; platform: "macos" | "windows";
}): Promise<void> {
  const { processId } = await electronDesktopE2eProbe();
  const baseline = (await inspect(input.windowId)).workspaceTabs.find(t => t.tabId === input.tabId)!.slots;
  const check = async (name: string, presentation: "normal" | "maximized" | "fullscreen") => {
    await browser.waitUntil(async () => (await inspect(input.windowId)).presentation === presentation,
      { timeout: 30_000, timeoutMsg: `Workspace did not enter ${presentation}` });
    const current = await inspect(input.windowId);
    expect(current.workspaceTabs.find(t => t.tabId === input.tabId)!.slots).toEqual(baseline);
    await expectWorkspacePixels({ inspection: current, tabId: input.tabId, name, background: "black" });
  };
  for (const presentation of ["maximized", "normal"] as const) {
    if (input.platform === "macos") await focusVisibleMacosAppKitRuntime({ processId, windowId: input.windowId });
    await clickVisibleRuntimeWindowControl({ ...input, command: "maximize" });
    await check(`after-resize-${presentation}`, presentation);
  }
  for (const presentation of ["fullscreen", "normal"] as const) {
    if (input.platform === "macos") await pressVisibleMacosApplicationShortcut({ command: "toggleFullscreen",
      processId, runtimeWindowId: input.windowId, targetMode: "focused-runtime" });
    else await pressVisibleWindowsApplicationShortcut({ command: "toggleFullscreen", processId,
      nativeWindowHandle: (await inspect(input.windowId)).nativeWindowHandle, targetMode: "focused-runtime" });
    await check(`after-resize-fullscreen-${presentation}`, presentation);
  }
}
