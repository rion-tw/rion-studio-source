import { browser } from "@wdio/globals";

/** Corrupt only an exact Role's compatible key receipt after real DOM dispatch. */
export async function compatibleReceiptFault(url: string, action: "arm" | "clear"): Promise<void> {
  await browser.electron.execute((electron, expectedUrl, operation) => {
    const state = globalThis as typeof globalThis & { __rionCompatibleReceiptFault?: () => void };
    if (operation === "clear") { state.__rionCompatibleReceiptFault?.(); return; }
    if (state.__rionCompatibleReceiptFault) throw new Error("A compatible receipt fault is already armed.");
    const matches = electron.webContents.getAllWebContents().filter(contents => contents.getURL() === expectedUrl);
    if (matches.length !== 1) throw new Error("Receipt injection requires one exact Role document.");
    const contents = matches[0]!;
    const original = contents.executeJavaScriptInIsolatedWorld;
    const clear = () => {
      contents.executeJavaScriptInIsolatedWorld = original;
      contents.removeListener("did-start-navigation", clear);
      contents.removeListener("destroyed", clear);
      delete state.__rionCompatibleReceiptFault;
    };
    contents.executeJavaScriptInIsolatedWorld = async function (world, scripts, gesture) {
      const result = await original.call(this, world, scripts, gesture);
      if (scripts.some(script => script.url === "rion-studio://compatible-game-input.js") &&
          result?.eventCount === 1) {
        return { ...result, sequence: -1 };
      }
      return result;
    };
    state.__rionCompatibleReceiptFault = clear;
    contents.once("did-start-navigation", clear);
    contents.once("destroyed", clear);
  }, url, action);
}
