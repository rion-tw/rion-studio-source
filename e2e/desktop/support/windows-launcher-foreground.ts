import { browser } from "@wdio/globals";
import type {} from "@wdio/electron-service";
import { focusWindowsRuntimeNativeWindow } from "./windows-runtime-foreground";

/** Native foreground precondition for the exact launcher, including with live Roles. */
export async function focusWindowsLauncherForVisibleLaunch(): Promise<{
  processId: number; nativeWindowHandle: string;
} | undefined> {
  if (process.platform !== "win32") return;
  const launcherUrl = await browser.getUrl();
  const identity = await browser.electron.execute((electron, expectedUrl) => {
    const windows = electron.BrowserWindow.getAllWindows().filter((window) =>
      window.webContents.getURL() === expectedUrl
    );
    if (windows.length !== 1) throw new Error("Exact session launcher unavailable");
    const handle = windows[0].getNativeWindowHandle();
    return { processId: process.pid, nativeWindowHandle: handle.length === 8
      ? handle.readBigUInt64LE().toString() : String(handle.readUInt32LE()) };
  }, launcherUrl);
  await focusWindowsRuntimeNativeWindow(identity);
  return identity;
}
