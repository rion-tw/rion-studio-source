import { $, browser, expect } from "@wdio/globals";
import { Key } from "webdriverio";
import type {} from "@wdio/electron-service";
import { withWorkspaceWebChromeTarget } from "./electron-role-surface";

/** Visible input is the action; the exact content's navigation event is evidence. */
export async function verifyVisibleWorkspaceWebAddress(input: {
  chromeShellUrl: string;
  contentUrl: string;
  mainWindowHandle: string;
}): Promise<void> {
  const contentId = await browser.electron.execute((electron, contentUrl) => {
    const matches = electron.webContents.getAllWebContents().filter(wc => wc.getURL() === contentUrl);
    if (matches.length !== 1) throw new Error("Expected one exact Web content surface");
    const content = matches[0];
    const evidence: string[] = [];
    const listener = (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
      if (event.isMainFrame) evidence.push(event.url);
    };
    // Bound this E2E search request to the local fixture; no Google availability dependency.
    content.session.webRequest.onBeforeRequest({ urls: ["https://www.google.com/search?*"] },
      (_request, callback) => callback({ redirectURL: contentUrl }));
    const finished = () => {
      if (evidence.length > 0 && content.getURL() === contentUrl) evidence.push("fixture-ready");
    };
    content.on("did-finish-load", finished);
    Object.assign(content, { rionAddressEvidence: { evidence, listener, finished } });
    content.on("did-start-navigation", listener);
    return content.id;
  }, input.contentUrl);
  try {
    await withWorkspaceWebChromeTarget(
      input.chromeShellUrl,
      input.contentUrl,
      input.mainWindowHandle,
      async () => {
        const location = await $("#location");
        await location.waitForDisplayed({ timeout: 10_000 });
        await location.click();
        await expect(location).toHaveValue(input.contentUrl);
        await browser.keys([Key.Ctrl, "a"]);
        await browser.keys("discard this draft");
        await browser.action("key").down(Key.Escape).up(Key.Escape).perform();
        await expect(location).toHaveValue(input.contentUrl.replace(/^https:\/\/(?:www\.)?/u, ""));
        await location.click();
        await expect(location).toHaveValue(input.contentUrl);
        await browser.keys([Key.Ctrl, "a"]);
        await browser.keys("rion 中文 & cats+#");
        await expect(location).toHaveValue("rion 中文 & cats+#");
        await browser.action("key").down(Key.Enter).up(Key.Enter).perform();
      }
    );
    const expected = "https://www.google.com/search?q=rion%20%E4%B8%AD%E6%96%87%20%26%20cats%2B%23";
    await browser.waitUntil(async () => browser.electron.execute((electron, id, url) => {
      const content = electron.webContents.fromId(id) as (Electron.WebContents & {
        rionAddressEvidence?: { evidence: string[] };
      }) | undefined;
      return content?.rionAddressEvidence?.evidence.includes(url) === true &&
        content.rionAddressEvidence.evidence.includes("fixture-ready");
    }, contentId, expected), { timeout: 15_000, timeoutMsg: "Search did not emit the exact main-frame navigation" });
  } catch (error) {
    const observed = await browser.electron.execute((electron, id) => {
      const content = electron.webContents.fromId(id) as (Electron.WebContents & {
        rionAddressEvidence?: { evidence: string[] };
      }) | undefined;
      return { url: content?.getURL(), navigation: content?.rionAddressEvidence?.evidence };
    }, contentId);
    throw new Error(`${String(error)}; observed ${JSON.stringify(observed)}`, { cause: error });
  } finally {
    await browser.electron.execute((electron, id) => {
      const content = electron.webContents.fromId(id) as (Electron.WebContents & {
        rionAddressEvidence?: { listener: (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => void; finished: () => void };
      }) | undefined;
      if (content?.rionAddressEvidence) {
        content.removeListener("did-start-navigation", content.rionAddressEvidence.listener);
        content.removeListener("did-finish-load", content.rionAddressEvidence.finished);
        content.session.webRequest.onBeforeRequest(null);
        delete content.rionAddressEvidence;
      }
    }, contentId);
  }
}
