import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { electronDesktopE2eProbe } from "./electron-driver";

const BUSTER = "Buster: Captcha Solver for Humans";
const ID = "mpbjkejclgfgadiemmefgebjfooflfhl";
const SEARCH = 'input[type="search"],input[aria-label*="Search"],input[placeholder*="Search"]';

/** Both visible paths must render the remote document, not an app-owned selection. */
export async function verifyBusterStoreNavigation(processId: number, mainHandle: string): Promise<void> {
  const storeHandle = await browser.getWindowHandle();
  for (const mode of ["result", "suggestion", "keyboard"] as const) {
    let sourcePath: string;
    const search = await $(SEARCH);
    await search.waitForClickable({ timeout: 30_000 });
    await search.click();
    if ((await search.getValue()) !== BUSTER) {
      await expect(search).toHaveValue("");
      await search.addValue(BUSTER);
    }
    if (mode === "result") {
      await browser.keys("Enter");
      await browser.waitUntil(async () => new URL(await browser.getUrl()).pathname.startsWith("/search/"), {
        timeout: 30_000, timeoutMsg: "The visible search did not commit its results document"
      });
      const result = await $(`a[href*="/detail/"][href*="${ID}"]`);
      await result.waitForClickable({ timeout: 30_000 });
      sourcePath = new URL(await browser.getUrl()).pathname;
      await result.click();
    } else {
      const suggestion = await $(`//*[@role="listbox"]//*[@role="option" and contains(., "${BUSTER}")]`);
      await suggestion.waitForDisplayed({ timeout: 30_000 });
      sourcePath = new URL(await browser.getUrl()).pathname;
      if (mode === "keyboard") await browser.keys(["ArrowDown", "Enter"]);
      else await suggestion.click();
    }
    await browser.waitUntil(async () => new URL(await browser.getUrl()).pathname.endsWith(`/${ID}`), {
      timeout: 30_000, timeoutMsg: `Buster ${mode} did not load the real detail URL`
    });
    await $(`h1=${BUSTER}`).waitForDisplayed({ timeout: 30_000 });
    await browser.saveScreenshot(join(process.env.RION_STUDIO_E2E_ARTIFACT_DIR!, "screenshots", `buster-${mode}-detail.png`));
    if (mode === "result") {
      const priorDocument = await browser.execute(() => performance.timeOrigin);
      await browser.switchToWindow(mainHandle);
      await clickStoreToolbar("Reload");
      await browser.switchToWindow(storeHandle);
      await browser.waitUntil(async () => (await browser.execute(() => performance.timeOrigin)) !== priorDocument, {
        timeout: 30_000, timeoutMsg: "Store Reload did not replace the remote document"
      });
      await $(`h1=${BUSTER}`).waitForDisplayed({ timeout: 30_000 });
      expect(new URL(await browser.getUrl()).pathname.endsWith(`/${ID}`)).toBe(true);
    }
    await browser.switchToWindow(mainHandle);
    expect((await electronDesktopE2eProbe()).processId).toBe(processId);
    await clickStoreToolbar("Back");
    await browser.switchToWindow(storeHandle);
    await browser.waitUntil(async () => new URL(await browser.getUrl()).pathname === sourcePath, {
      timeout: 30_000, timeoutMsg: "Store Back did not restore the originating document"
    });
    if (mode === "result") {
      await browser.switchToWindow(mainHandle);
      await clickStoreToolbar("Forward");
      await browser.switchToWindow(storeHandle);
      await $(`h1=${BUSTER}`).waitForDisplayed({ timeout: 30_000 });
      expect(new URL(await browser.getUrl()).pathname.endsWith(`/${ID}`)).toBe(true);
      await browser.switchToWindow(mainHandle);
      await clickStoreToolbar("Back");
      await browser.switchToWindow(storeHandle);
      await browser.waitUntil(async () => new URL(await browser.getUrl()).pathname === sourcePath, {
        timeout: 30_000, timeoutMsg: "Store Back after Forward did not restore search"
      });
    }
  }
}

async function clickStoreToolbar(action: "Back" | "Forward" | "Reload"): Promise<void> {
  const button = await $(`button[aria-label="${action}"]`);
  await button.waitForEnabled({ timeout: 30_000 });
  await button.click();
}
