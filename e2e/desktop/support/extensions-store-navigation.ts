import { join } from "node:path";
import { appendFile } from "node:fs/promises";
import { $, browser, expect } from "@wdio/globals";
import type {} from "@wdio/electron-service";
import { electronDesktopE2eProbe } from "./electron-driver";
import { observeStore, recordStoreEvidence, storeState } from "./extensions-store-evidence";
import { setInputValue } from "./ui";

const BUSTER = "Buster: Captcha Solver for Humans";
const ID = "mpbjkejclgfgadiemmefgebjfooflfhl";
const SEARCH = 'input[type="search"],input[aria-label*="Search"],input[placeholder*="Search"]';

/**
 * The store header collapses its search field behind a Search button at
 * narrow widths (720px, seen 2026-11-15 in the embedded store view). Expand it
 * through that visible button only while the field itself is not displayed.
 */
export async function revealStoreSearch(): Promise<WebdriverIO.Element> {
  await browser.waitUntil(async () => {
    // Re-query each pass: the store may replace the field while expanding it.
    const field = $(SEARCH);
    if (await field.isClickable()) return true;
    // Only a collapsed (undisplayed) field is expanded. At wider widths the
    // same-named button submits the query, so a field that is displayed but
    // briefly not clickable is only awaited.
    if (await field.isDisplayed()) return false;
    const expand = $('header[role="banner"] button[aria-label="Search"]');
    if (await expand.isDisplayed()) await expand.click();
    return false;
  }, { timeout: 30_000, interval: 500, timeoutMsg: "The store search field never became clickable" });
  return $(SEARCH).getElement();
}

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
  const category = await storeState(storeId);
  for (const mode of ["result", "suggestion", "keyboard"] as const) {
    let source: { url: string; index: number };
    const page = await storeState(storeId);
    await revealStoreSearch();
    // History Back restores the query text without opening suggestions.
    // Re-enter it through the visible field for each navigation path.
    await setInputValue(SEARCH, BUSTER);
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
      const suggestionSelector = `//*[@role="listbox"]//*[@role="option" and contains(., "${BUSTER}")]`;
      const suggestion = await $(suggestionSelector);
      await suggestion.waitForDisplayed({ timeout: 30_000 });
      source = page;
      if (mode === "keyboard") {
        // Google's bar loads its (hidden) promotion callout once per session.
        // On a narrow header that pops the search field's same-document
        // history entry and takes focus, so the keys reach nothing. Retype
        // through the visible field only after that pop is observed.
        for (let attempt = 1; ; attempt++) {
          await $(suggestionSelector).waitForDisplayed({ timeout: 30_000 });
          const typed = await storeState(storeId);
          await browser.keys(["ArrowDown", "Enter"]);
          const atDetail = async () => new URL(await browser.getUrl()).pathname.endsWith(`/${ID}`);
          let opened = false;
          await browser.waitUntil(async () => {
            if ((opened = await atDetail())) return true;
            if (typed.index > page.index && (await storeState(storeId)).index < typed.index) return true;
            // The pop can precede the keys: focus left the field and its
            // suggestions closed without a navigation.
            const focused = await browser.execute(selector => document.activeElement?.matches(selector) ?? false, SEARCH);
            return !focused && !(await $(suggestionSelector).isDisplayed());
          }, { timeout: 30_000, timeoutMsg: "Buster keyboard selection neither navigated nor lost its search field" });
          if (opened || (await atDetail()) || attempt === 3) break;
          await revealStoreSearch();
          await setInputValue(SEARCH, BUSTER);
        }
      } else await browser.waitUntil(async () => {
        // Live store suggestions replace their option node while results
        // arrive. A stale WebDriver element has not established a click.
        if (new URL(await browser.getUrl()).pathname.endsWith(`/${ID}`)) return true;
        try {
          await $(suggestionSelector).click();
          return true;
        } catch (error) {
          if (String(error).includes("stale element reference")) return false;
          throw error;
        }
      }, { timeout: 30_000, timeoutMsg: "Visible Buster suggestion did not accept a click" });
    }
    await browser.waitUntil(async () => new URL(await browser.getUrl()).pathname.endsWith(`/${ID}`), {
      timeout: 30_000, timeoutMsg: `Buster ${mode} did not load the real detail URL`
    });
    await waitForStoreDocument(storeId);
    await $(`h1=${BUSTER}`).waitForDisplayed({ timeout: 30_000 });
    const detail = await storeState(storeId);
    if (mode !== "result") {
      // A narrow store header opens its search field by pushing a
      // same-document entry for the category URL. A suggestion navigation
      // either replaces that entry or pushes after it, so the detail entry
      // directly follows a category entry one or two steps after the page.
      expect([page.index + 1, page.index + 2]).toContain(detail.index);
      source = { url: detail.history[detail.index - 1]!, index: detail.index - 1 };
      expect(source.url).toBe(page.url);
    }
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
    if (mode === "result") {
      await $(storeDetailLinkSelector(ID)).waitForDisplayed({ timeout: 30_000 });
    } else {
      expect(new URL(await browser.getUrl()).pathname).toBe("/category/extensions");
    }
    await recordStoreEvidence(storeId, `${mode}-back`);
    if (mode === "result") {
      // Suggestions belong to the category search field. A restored results
      // document can retain query text without reopening its suggestion menu.
      await browser.switchToWindow(mainHandle);
      await clickStoreToolbar("Back", storeId);
      await browser.switchToWindow(storeHandle);
      await waitForStoreDocument(storeId, category);
    }
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
