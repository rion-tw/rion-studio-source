import { $, expect } from "@wdio/globals";

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
    // Resolve from the document: a lazy route can replace the page between
    // assertions. A retained parent handle can keep searching the old subtree.
    await expect($(".app-page h2")).toHaveText(empty[0]);
    await expect($(".app-page h2")).toBeDisplayed();
    await expect($(`//section[contains(concat(' ', normalize-space(@class), ' '), ' app-page ')]//button[normalize-space(.)='${empty[1]}']`)).toBeDisplayed();
    await expect($(".app-page .app-page-header")).not.toExist();
  } else {
    await expect($(".app-page .app-page-header")).toBeDisplayed();
  }
  await expect($(".app-page .app-page-kicker")).not.toExist();
}
