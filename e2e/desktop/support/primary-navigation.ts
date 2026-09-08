import { $, browser, expect } from "@wdio/globals";

const EMPTY_PRIMARY_PAGES: Readonly<Record<string, readonly [string, string]>> = {
  "/roles": ["No roles yet", "Create role"],
  "/workspaces": ["No workspaces yet", "Create workspace"],
  "/macros": ["No macros yet", "Create macro"]
};

/** Seed navigation runs before user-created Roles, Workspaces, or Macros exist. */
export async function assertSeedPrimaryPage(path: string): Promise<void> {
  await expect($(".app-page")).toBeDisplayed();
  const empty = EMPTY_PRIMARY_PAGES[path];
  if (empty) {
    // WebView2 can return null repeatedly for an obsolete heading instead of a
    // stale-element error. Requery on every observation of the lazy route,
    // within the existing assertion boundary; wrong text still fails.
    await browser.waitUntil(async () => {
      const heading = await $(".app-page h2");
      return await heading.isExisting() && await heading.getText() === empty[0];
    }, {
      timeout: browser.options.waitforTimeout,
      interval: 100,
      timeoutMsg: `The current ${path} heading did not equal ${empty[0]}`
    });
    await expect($(".app-page h2")).toBeDisplayed();
    await expect($(`//section[contains(concat(' ', normalize-space(@class), ' '), ' app-page ')]//button[normalize-space(.)='${empty[1]}']`)).toBeDisplayed();
    await expect($(".app-page .app-page-header")).not.toExist();
  } else {
    await expect($(".app-page .app-page-header")).toBeDisplayed();
  }
  await expect($(".app-page .app-page-kicker")).not.toExist();
}
