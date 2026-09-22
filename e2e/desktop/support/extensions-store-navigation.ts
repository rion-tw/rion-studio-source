import { join } from "node:path";
import { appendFile } from "node:fs/promises";
import { $, browser, expect } from "@wdio/globals";
import type {} from "@wdio/electron-service";
import { electronDesktopE2eProbe } from "./electron-driver";
import { observeStore, recordStoreEvidence, storeState } from "./extensions-store-evidence";

const BUSTER = "Buster: Captcha Solver for Humans";
const ID = "mpbjkejclgfgadiemmefgebjfooflfhl";
const SEARCH = 'input[type="search"],input[aria-label*="Search"],input[placeholder*="Search"]';

export function storeDetailLinkSelector(extensionId: string): string {
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error("Invalid store extension ID");
  // A Google sign-in link can embed this detail URL in its continue parameter.
  // Match the destination itself, excluding reviews/report subpaths as well.
  return ["./detail/", "/detail/", "https://chromewebstore.google.com/detail/"].flatMap(prefix => [
    `a[href^="${prefix}"][href$="/${extensionId}"]`,
    `a[href^="${prefix}"][href*="/${extensionId}?"]`
  ]).join(",");
}

/** Both visible paths must render the remote document, not an app-owned selection. */
export async function verifyBusterStoreNavigation(processId: number, mainHandle: string): Promise<void> {
  const storeId = await observeStore();
  try { await verifyNavigation(processId, mainHandle, storeId); }
  catch (error) {
    await recordStoreEvidence(storeId, "failure", true).catch(evidenceError => console.error(evidenceError));
    throw error;
  }
}

async function verifyNavigation(processId: number, mainHandle: string, storeId: number): Promise<void> {
  const storeHandle = await browser.getWindowHandle();
  for (const mode of ["result", "suggestion", "keyboard"] as const) {
    let source: Awaited<ReturnType<typeof storeState>>;
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
      const result = await $(storeDetailLinkSelector(ID));
      await result.waitForClickable({ timeout: 30_000 });
      source = await storeState(storeId);
      await result.click();
    } else {
      const suggestion = await $(`//*[@role="listbox"]//*[@role="option" and contains(., "${BUSTER}")]`);
      await suggestion.waitForDisplayed({ timeout: 30_000 });
      source = await storeState(storeId);
      if (mode === "keyboard") await browser.keys(["ArrowDown", "Enter"]);
      else await suggestion.click();
    }
    await browser.waitUntil(async () => new URL(await browser.getUrl()).pathname.endsWith(`/${ID}`), {
      timeout: 30_000, timeoutMsg: `Buster ${mode} did not load the real detail URL`
    });
    await waitForStoreDocument(storeId);
    await $(`h1=${BUSTER}`).waitForDisplayed({ timeout: 30_000 });
    const detail = await storeState(storeId);
    expect(detail.index).toBe(source.index + 1);
    await recordStoreEvidence(storeId, `${mode}-detail`);
    await browser.saveScreenshot(join(process.env.RION_STUDIO_E2E_ARTIFACT_DIR!, "screenshots", `buster-${mode}-detail.png`));
    if (mode === "result") {
      const priorDocument = await browser.execute(() => performance.timeOrigin);
      await browser.switchToWindow(mainHandle);
      await clickStoreToolbar("Reload", storeId);
      await browser.switchToWindow(storeHandle);
      await browser.waitUntil(async () => (await browser.execute(() => performance.timeOrigin)) !== priorDocument, {
        timeout: 30_000, timeoutMsg: "Store Reload did not replace the remote document"
      });
      await waitForStoreDocument(storeId, detail);
      await $(`h1=${BUSTER}`).waitForDisplayed({ timeout: 30_000 });
      expect((await storeState(storeId)).history).toEqual(detail.history);
      await recordStoreEvidence(storeId, `${mode}-reload`);
    }
    await browser.switchToWindow(mainHandle);
    expect((await electronDesktopE2eProbe()).processId).toBe(processId);
    await clickStoreToolbar("Back", storeId);
    await browser.switchToWindow(storeHandle);
    await waitForStoreDocument(storeId, source);
    expect((await storeState(storeId)).history).toEqual(detail.history);
    if (mode === "result") {
      // Windows uses pageLoadStrategy:none. A committed history URL alone
      // does not prove that the restored search document is ready to leave.
      await $(storeDetailLinkSelector(ID)).waitForDisplayed({ timeout: 30_000 });
      await browser.switchToWindow(mainHandle);
      await clickStoreToolbar("Forward", storeId);
      await browser.switchToWindow(storeHandle);
      await waitForStoreDocument(storeId, detail);
      await $(`h1=${BUSTER}`).waitForDisplayed({ timeout: 30_000 });
      expect((await storeState(storeId)).history).toEqual(detail.history);
      await recordStoreEvidence(storeId, "result-forward");
      await browser.switchToWindow(mainHandle);
      await clickStoreToolbar("Back", storeId);
      await browser.switchToWindow(storeHandle);
      await waitForStoreDocument(storeId, source);
      await $(storeDetailLinkSelector(ID)).waitForDisplayed({ timeout: 30_000 });
    }
    await $(storeDetailLinkSelector(ID)).waitForDisplayed({ timeout: 30_000 });
    await recordStoreEvidence(storeId, `${mode}-back`);
  }
}

async function waitForStoreDocument(id: number, target?: { url: string; index: number }): Promise<void> {
  // A committed history URL can precede replacement of the old DOM. Read the
  // exact store WebContents loading boundary before inspecting its document.
  await browser.waitUntil(async () => {
    const state = await storeState(id);
    return !state.loading && (!target || (state.url === target.url && state.index === target.index));
  }, { timeout: 30_000, timeoutMsg: "The exact store history entry did not finish loading its document" });
  if (target) expect(await browser.getUrl()).toBe(target.url);
}

async function clickStoreToolbar(action: "Back" | "Forward" | "Reload", id: number): Promise<void> {
  const button = await $(`button[aria-label="${action}"]`);
  await button.waitForClickable({ timeout: 30_000 });
  // Observe the visible click in the launcher before switching into its native
  // child view. A successful WebDriver command alone does not prove which
  // document consumed the input on Windows.
  await browser.execute(() => {
    const observed = window as unknown as { __rionE2eToolbarClicks: string[] };
    observed.__rionE2eToolbarClicks = [];
    document.addEventListener("click", event => {
      const target = event.target as Element;
      observed.__rionE2eToolbarClicks.push(
        target.closest("button")?.getAttribute("aria-label") ?? target.tagName
      );
    }, { once: true, capture: true });
  });
  await button.click();
  const clicks = await browser.execute(() =>
    (window as unknown as { __rionE2eToolbarClicks: string[] }).__rionE2eToolbarClicks);
  const after = await storeState(id);
  await appendFile(join(process.env.RION_STUDIO_E2E_ARTIFACT_DIR!, "store-toolbar.jsonl"),
    JSON.stringify({ action, clicks, after }) + "\n");
  expect(clicks).toEqual([action]);
}
