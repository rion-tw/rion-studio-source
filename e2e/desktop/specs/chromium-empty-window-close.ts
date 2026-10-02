import { $, browser, expect } from "@wdio/globals";
import type {} from "@wdio/electron-service";
import { electronDesktopE2eGameWindowRuntime, electronDesktopE2eProbe } from "../support/electron-driver";
import { closeVisibleRuntimeWindow, runtimeTabShellErrors } from "../support/native-runtime-tabs";
import { pressVisibleMacosApplicationShortcut, pressVisibleWindowsApplicationShortcut } from "../support/native-application-actions";
import { focusWindowsLauncherForVisibleLaunch } from "../support/windows-launcher-foreground";
import { focusWindowsRuntimeNativeWindow } from "../support/windows-runtime-foreground";
import { rendererCall } from "../support/renderer-bridge";

/** A fresh empty host must close before any role/workspace has ever been loaded. */
export async function verifyEmptyWindowClose(): Promise<void> {
  const mainWindowHandle = await browser.getWindowHandle();
  const { platform, processId } = await electronDesktopE2eProbe();
  const saved = (await rendererCall("listGameWindows")).map(window => window.id);
  for (let attempt = 0; attempt < (platform === "windows" ? 3 : 2); attempt++) {
    const before = new Set((await rendererCall("getEmbeddedRuntimeState")).windows.map(window => window.id));
    if (platform === "windows") {
      const launcher = await focusWindowsLauncherForVisibleLaunch();
      await $(".app-main-sidebar").$("button*=Games").click();
      await pressVisibleWindowsApplicationShortcut({ command: "newGameWindow", processId,
        nativeWindowHandle: launcher!.nativeWindowHandle });
    } else {
      await pressVisibleMacosApplicationShortcut({ command: "newGameWindow", processId });
    }
    let windowId = "";
    await browser.waitUntil(async () => {
      const created = (await rendererCall("getEmbeddedRuntimeState")).windows.filter(window => !before.has(window.id));
      expect(created.length).toBeLessThanOrEqual(1);
      if (!created[0]) return false;
      windowId = created[0].id;
      const runtime = (await electronDesktopE2eGameWindowRuntime(windowId)).currentRuntime;
      return !!runtime?.visible && runtime.coreTabIds.length === 0 && runtime.nativeTabIds.length === 0;
    }, { timeout: 20_000, timeoutMsg: "New Window did not create an exact visible zero-tab host" });
    if (platform === "windows" && attempt === 2) {
      const runtime = (await electronDesktopE2eGameWindowRuntime(windowId)).currentRuntime;
      if (!runtime) throw new Error("The empty runtime retired before its native close shortcut");
      const nativeWindowHandle = await browser.electron.execute((electron, nativeId) => {
        const host = electron.BrowserWindow.getAllWindows().find(candidate => candidate.id === nativeId);
        if (!host || host.isDestroyed() || !host.isVisible()) throw new Error("The exact empty runtime is unavailable");
        const handle = host.getNativeWindowHandle();
        return handle.length === 8 ? handle.readBigUInt64LE().toString() : String(handle.readUInt32LE());
      }, runtime.parentNativeHostId);
      await focusWindowsRuntimeNativeWindow({ processId, nativeWindowHandle });
      await pressVisibleWindowsApplicationShortcut({ command: "closeWindow", processId,
        nativeWindowHandle, targetMode: "focused-runtime" });
    } else {
      await closeVisibleRuntimeWindow({ platform, mainWindowHandle, windowId });
    }
    await browser.waitUntil(async () => {
      const logical = (await rendererCall("getEmbeddedRuntimeState")).windows;
      const native = (await electronDesktopE2eGameWindowRuntime(windowId)).currentRuntime;
      return !logical.some(window => window.id === windowId) && native === null;
    }, { timeout: 20_000, timeoutMsg: "Closing a zero-tab host did not retire both Core and its native window" });
  }
  expect((await rendererCall("listGameWindows")).map(window => window.id)).toEqual(saved);
  expect(await runtimeTabShellErrors()).toEqual([]);
}
