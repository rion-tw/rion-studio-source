import { $, expect } from "@wdio/globals";

const EMPTY_PRIMARY_PAGES: Readonly<Record<string, readonly [string, string]>> = {
  "/roles": ["No roles yet", "Create role"],
  "/workspaces": ["No workspaces yet", "Create workspace"],
  "/macros": ["No macros yet", "Create macro"]
};

/** Seed navigation runs before user-created Roles, Workspaces, or Macros exist. */
export async function assertSeedPrimaryPage(path: string): Promise<void> {
  const page = await $(".app-page");
  await expect(page).toBeDisplayed();
  const empty = EMPTY_PRIMARY_PAGES[path];
  if (empty) {
    await expect(page.$(`h2=${empty[0]}`)).toBeDisplayed();
    await expect(page.$(`button=${empty[1]}`)).toBeDisplayed();
    await expect(page.$(".app-page-header")).not.toExist();
  } else {
    await expect(page.$(".app-page-header")).toBeDisplayed();
  }
  await expect(page.$(".app-page-kicker")).not.toExist();
}
