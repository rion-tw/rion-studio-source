import { browser } from "@wdio/globals";
import type {} from "@wdio/electron-service";

/** Only establishes launcher geometry; all extension actions remain visible UI actions. */
export async function compactExtensionsWindow(): Promise<void> {
  await resizeElectronLauncherWindow(960, 640);
}

/** Exact Electron launcher geometry; Chromium does not expose Browser.getWindowForTarget. */
export async function resizeElectronLauncherWindow(
  width: number,
  height: number
): Promise<{ width: number; height: number }> {
  const url = await browser.getUrl();
  const original = await browser.electron.execute((electron, launcherUrl, size) => {
    const windows = electron.BrowserWindow.getAllWindows().filter(window => window.webContents.getURL() === launcherUrl);
    if (windows.length !== 1) throw new Error("Exact launcher window unavailable");
    const [priorWidth, priorHeight] = windows[0].getSize();
    windows[0].setSize(size.width, size.height);
    return { width: priorWidth, height: priorHeight };
  }, url, { width, height });
  await browser.waitUntil(async () => browser.execute((expected) =>
    innerWidth === expected.width && innerHeight <= expected.height, { width, height }), {
    timeout: 10000, timeoutMsg: "Launcher did not reach its requested layout"
  });
  return original;
}
