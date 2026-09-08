import { $, browser } from "@wdio/globals";

const EMPTY_PRIMARY_PAGES: Readonly<Record<string, readonly [string, string]>> = {
  "/roles": ["No roles yet", "Create role"],
  "/workspaces": ["No workspaces yet", "Create workspace"],
  "/macros": ["No macros yet", "Create macro"]
};

async function assertCurrentElement(
  selector: string,
  condition: "displayed" | "absent" | "text",
  text?: string
): Promise<void> {
  // WebView2 can return null/false for an obsolete handle without a stale-element
  // error. Every observation uses the current route's DOM within the unchanged
  // assertion boundary; hidden controls, wrong text and forbidden chrome fail.
  await browser.waitUntil(async () => {
    const element = await $(selector);
    const exists = await element.isExisting();
    if (condition === "absent") return !exists;
    if (!exists) return false;
    return condition === "displayed"
      ? element.isDisplayed()
      : await element.getText() === text;
  }, {
    timeout: browser.options.waitforTimeout,
    interval: 100,
    timeoutMsg: `Current primary-page element ${selector} did not satisfy ${condition}${text ? `: ${text}` : ""}`
  });
}

/** Seed navigation runs before user-created Roles, Workspaces, or Macros exist. */
export async function assertSeedPrimaryPage(path: string): Promise<void> {
  await assertCurrentElement(".app-page", "displayed");
  const empty = EMPTY_PRIMARY_PAGES[path];
  if (empty) {
    await assertCurrentElement(".app-page h2", "text", empty[0]);
    await assertCurrentElement(".app-page h2", "displayed");
    await assertCurrentElement(`//section[contains(concat(' ', normalize-space(@class), ' '), ' app-page ')]//button[normalize-space(.)='${empty[1]}']`, "displayed");
    await assertCurrentElement(".app-page .app-page-header", "absent");
  } else {
    await assertCurrentElement(".app-page .app-page-header", "displayed");
  }
  await assertCurrentElement(".app-page .app-page-kicker", "absent");
}
