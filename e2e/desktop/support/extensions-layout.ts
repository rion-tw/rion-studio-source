import { browser, expect } from "@wdio/globals";
import type {} from "@wdio/electron-service";

/** Only establishes launcher geometry; all extension actions remain visible UI actions. */
export async function compactExtensionsWindow(): Promise<void> {
  const url = await browser.getUrl();
  const resized = await browser.electron.execute((electron, launcherUrl) => {
    const windows = electron.BrowserWindow.getAllWindows().filter(window => window.webContents.getURL() === launcherUrl);
    if (windows.length !== 1) throw new Error("Exact launcher window unavailable");
    windows[0].setSize(960, 640);
    return true;
  }, url);
  expect(resized).toBe(true);
  await browser.waitUntil(async () => browser.execute(() => innerWidth === 960 && innerHeight <= 640), {
    timeout: 10000, timeoutMsg: "Launcher did not reach its compact layout"
  });
}
