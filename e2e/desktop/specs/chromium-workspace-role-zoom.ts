import { browser, expect } from "@wdio/globals";
import type { Role } from "../../../src/shared/types";
import { electronDesktopE2eApplicationShortcutRuntime, electronDesktopE2eFullscreenToolbarRuntime, electronDesktopE2eProbe } from "../support/electron-driver";
import { readVisibleElectronPageElementPoint } from "../support/electron-role-surface";
import { clickMacosVisibleRoleControl } from "../support/macos-appkit-ui";
import { pressVisibleMacosApplicationShortcut, pressVisibleWindowsApplicationShortcut } from "../support/native-application-actions";
import { focusWindowsRuntimeNativeWindow } from "../support/windows-runtime-foreground";
import { fixtureCursor, waitFixtureEvent } from "../support/fixture";

export async function verifyWorkspaceRoleZoom(input: {
  platform: "macos" | "windows"; mainWindowHandle: string; windowId: string;
  tabName: string; roles: readonly Role[]; otherWindowId: string;
}): Promise<void> {
  const initial = await electronDesktopE2eApplicationShortcutRuntime(input.windowId);
  const other = await electronDesktopE2eApplicationShortcutRuntime(input.otherWindowId);
  const { processId } = await electronDesktopE2eProbe();
  for (const role of input.roles) {
    for (const [command, delta] of [["zoomIn", 0.05], ["zoomOut", 0], ["zoomReset", 0]] as const) {
      if (input.platform === "windows") {
        const point = await readVisibleElectronPageElementPoint(role.launchUrl, input.mainWindowHandle, "#qa-target");
        const host = await electronDesktopE2eFullscreenToolbarRuntime(input.windowId);
        const { nativeWindowHandle } = host;
        const surfaces = host.surfaces.filter(surface => surface.kind === "role" && surface.id === role.id && surface.visible);
        if (!nativeWindowHandle || surfaces.length !== 1) throw new Error("The workspace Role has no exact native geometry");
        const bounds = surfaces[0]!.bounds;
        const afterSequence = await fixtureCursor();
        await focusWindowsRuntimeNativeWindow({ processId, nativeWindowHandle, pointerTarget: "content-click",
          contentPoint: { x: bounds.x + point.x * bounds.width / point.viewport.width,
            y: bounds.y + point.y * bounds.height / point.viewport.height } });
        const click = await waitFixtureEvent({ afterSequence, kind: "click", roleId: new URL(role.launchUrl).pathname.split("/").at(-1)! });
        expect(click.targetId).toBe("qa-target");
        expect(click.isTrusted).toBe(true);
        await pressVisibleWindowsApplicationShortcut({ command, processId, nativeWindowHandle, targetMode: "focused-runtime" });
      } else {
        const point = await readVisibleElectronPageElementPoint(role.launchUrl, input.mainWindowHandle, "#qa-target");
        await clickMacosVisibleRoleControl(input.windowId, role.id, point);
        await pressVisibleMacosApplicationShortcut({ command, processId, targetMode: "focused-runtime",
          runtimeWindowId: input.windowId, runtimeTabName: input.tabName });
      }
      await browser.switchToWindow(input.mainWindowHandle);
      await browser.waitUntil(async () => {
        const current = await electronDesktopE2eApplicationShortcutRuntime(input.windowId);
        return current.roleSurfaces.find(surface => surface.roleId === role.id)?.baseZoomFactor === 1 + delta;
      }, { timeout: 20_000, timeoutMsg: `Focused workspace Role ${role.name} did not receive ${command}` });
      const current = await electronDesktopE2eApplicationShortcutRuntime(input.windowId);
      expect(current.nativeWindow.windowZoomFactor).toBe(initial.nativeWindow.windowZoomFactor);
      expect(current.mainWindow).toEqual(initial.mainWindow);
      expect(current.zoomJournal).toEqual(initial.zoomJournal);
      for (const surface of current.roleSurfaces) {
        const base = surface.roleId === role.id ? 1 + delta : 1;
        expect(surface.baseZoomFactor).toBe(base);
        expect(surface.appliedZoomFactor).toBe(base * initial.nativeWindow.windowZoomFactor);
      }
      expect((await electronDesktopE2eApplicationShortcutRuntime(input.otherWindowId)).roleSurfaces).toEqual(other.roleSurfaces);
    }
  }
}
