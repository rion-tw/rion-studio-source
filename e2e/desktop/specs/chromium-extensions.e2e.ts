import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { compactExtensionsWindow } from "../support/extensions-layout";
import { rendererCall } from "../support/renderer-bridge";
import { acceptLegalAndSkipFirstRun, ensureEnglishUi, setEditorName, setInputValue, submitEditor, waitForRoute } from "../support/ui";

// [journey:CHROMIUM-MACOS-APPKIT-EXTENSIONS-001]
// [journey:CHROMIUM-WINDOWS-EXTENSIONS-001]
const EXTENSION_ID = "ddkjiahejlhfcafbddmgiahcphecmpfh";

describe("Extensions store and per-role configuration", () => {
  it("installs through visible Rion confirmation and manages persisted role assignments", async () => {
    await ensureEnglishUi();
    await acceptLegalAndSkipFirstRun();
    const phase = process.env.RION_STUDIO_E2E_PHASE;
    await compactExtensionsWindow();
    await $(".app-main-sidebar").$("button*=Settings").click();
    await waitForRoute("/settings");
    await $(".settings-mode-sidebar").$("button=Preferences").click();
    await $(phase === "chromium-extensions-seed" ? "button=Light" : "button=Dark").click();
    await $("button=Back to app").click();
    const sidebar = await $(".app-main-sidebar");
    await sidebar.$("button*=Extensions").click();
    await waitForRoute("/extensions");
    if (phase === "chromium-extensions-seed") {
      await expect(sidebar.$("button*=Extensions")).toHaveText(/^Extensions\s*0$/);
      // This role is a deterministic precondition; extension mutations below use visible UI.
      const games = await rendererCall("listGames");
      await rendererCall("createRole", { gameId: games[0].id, name: "Extensions journey role", launchUrl: `${process.env.RION_STUDIO_E2E_FIXTURE_ORIGIN}/role/extensions-role` });
      // Many and long role names are layout preconditions, not the future-role action under test.
      for (let index = 0; index < 12; index += 1) {
        await rendererCall("createRole", { gameId: games[0].id, name: `Layout role ${index} — long role name for compact dialog layout`, launchUrl: `${process.env.RION_STUDIO_E2E_FIXTURE_ORIGIN}/role/layout-${index}` });
      }
      await $("button=Add extension").click();
      const main = await browser.getWindowHandle();
      let storeHandle: string | undefined;
      await browser.waitUntil(async () => {
        for (const handle of await browser.getWindowHandles()) {
          if (handle === main) continue;
          await browser.switchToWindow(handle);
          if ((await browser.getUrl()).startsWith("https://chromewebstore.google.com/")) { storeHandle = handle; return true; }
        }
        return false;
      }, { timeout: 30000, timeoutMsg: "The isolated Chrome Web Store view did not become available" });
      if (!storeHandle) throw new Error("Store view missing");
      const entry = new URL(await browser.getUrl());
      expect(entry.pathname).toBe("/category/extensions");
      expect(entry.searchParams.get("hl")).toBe("en");
      await browser.waitUntil(async () => browser.execute(() =>
        document.documentElement.scrollWidth <= document.documentElement.clientWidth
        && document.body.getBoundingClientRect().width <= innerWidth
        && [...document.querySelectorAll("header, main")].every(e => e.getBoundingClientRect().width <= innerWidth)
      ), { timeout: 10000, timeoutMsg: "Chrome Web Store must fit the embedded viewport without horizontal scrolling" });
      const chromePromotion = await $('header[role="banner"] > [role="dialog"][jscontroller="h4ilFc"]');
      await chromePromotion.waitForExist({ timeout: 10000 });
      await expect(chromePromotion).not.toBeDisplayed();
      await browser.saveScreenshot(join(process.env.RION_STUDIO_E2E_ARTIFACT_DIR!, "screenshots", "extensions-store-width.png"));
      // Select a known public package as a navigation precondition; installation stays in Rion UI.
      await browser.url(`https://chromewebstore.google.com/detail/ublock-origin-lite/${EXTENSION_ID}`);
      await browser.switchToWindow(main);
      const install = await $("button=Install this extension");
      await install.waitForEnabled({ timeout: 30000 });
      await install.click();
      const confirm = await $("button=Confirm installation");
      // DeadlineBound test boundary: external store failure is a failed journey.
      await confirm.waitForDisplayed({ timeout: 75000 });
      await $('[role="dialog"]').$("button=All roles").click();
      await expectDialogFits();
      await browser.saveScreenshot(join(process.env.RION_STUDIO_E2E_ARTIFACT_DIR!, "screenshots", "extensions-confirm.png"));
      await confirm.click();
      await browser.waitUntil(async () => (await rendererCall("extensions", { type: "snapshot" })).snapshot.installed.some(p => p.id === EXTENSION_ID && p.applyToAllRoles), { timeout: 15000 });
      await expect($("button=Manage")).toBeDisplayed();
      await expect(sidebar.$("button*=Extensions")).toHaveText(/^Extensions\s*1$/);
      await browser.saveScreenshot(join(process.env.RION_STUDIO_E2E_ARTIFACT_DIR!, "screenshots", "extensions-installed.png"));
      await sidebar.$("button*=Roles").click();
      await waitForRoute("/roles");
      await $("button=New role").click();
      await waitForRoute("/roles/new");
      await setEditorName("Future extensions role");
      await setInputValue("#role-launch-url", `${process.env.RION_STUDIO_E2E_FIXTURE_ORIGIN}/role/future-extensions`);
      await submitEditor("/roles");
      const future = (await rendererCall("listRoles")).find(candidate => candidate.name === "Future extensions role");
      if (!future) throw new Error("The visible role creation did not persist");
      const card = await $(`[data-selection-id='${future.id}']`);
      await card.moveTo();
      await card.$("button[aria-label='Open']").click();
      await browser.waitUntil(async () => (await rendererCall("extensions", { type: "snapshot" })).snapshot.roles.some(r => r.roleId === future.id && r.status === "loaded" && r.extensionIds.includes(EXTENSION_ID)), { timeout: 30000 });
      await browser.switchToWindow(main);
      await browser.waitUntil(async () => (await rendererCall("listRoleStatuses")).some(r => r.roleId === future.id && r.state === "running"), { timeout: 30000 });
    } else if (phase === "chromium-extensions-restart") {
      await expect(sidebar.$("button*=Extensions")).toHaveText(/^Extensions\s*1$/);
      const snapshot = (await rendererCall("extensions", { type: "snapshot" })).snapshot;
      const installed = snapshot.installed.find(p => p.id === EXTENSION_ID && !p.removed);
      expect(installed?.applyToAllRoles).toBe(true);
      expect(installed?.enabledRoleIds).toHaveLength(0);
      await $("button=Manage").click();
      await $('[role="dialog"]').$("button=Selected roles").click();
      const checkbox = await $("label*=Extensions journey role").$("[role=checkbox]");
      await expect(checkbox).toHaveAttribute("data-state", "checked");
      await expectDialogFits();
      await browser.saveScreenshot(join(process.env.RION_STUDIO_E2E_ARTIFACT_DIR!, "screenshots", "extensions-manage-dark.png"));
      await $("button=Clear selection").click();
      await $("button=Save").click();
      await browser.waitUntil(async () => (await rendererCall("extensions", { type: "snapshot" })).snapshot.installed.find(p => p.id === EXTENSION_ID)?.applyToAllRoles === false);
      await $("button=Manage").click();
      await $("button=Remove").click();
      await $('[role="dialog"]').$("button=Cancel").click();
      expect((await rendererCall("extensions", { type: "snapshot" })).snapshot.installed.some(p => p.id === EXTENSION_ID && !p.removed)).toBe(true);
      await $('[role="dialog"]').$("button=Remove").click();
      await $("button=Confirm removal").click();
      await browser.waitUntil(async () => !(await rendererCall("extensions", { type: "snapshot" })).snapshot.installed.some(p => p.id === EXTENSION_ID && !p.removed));
      await expect($("h2=No extensions installed yet.")).toBeDisplayed();
      await expect(sidebar.$("button*=Extensions")).toHaveText(/^Extensions\s*0$/);
    } else throw new Error(`Unexpected Extensions phase: ${phase}`);
  });
});

async function expectDialogFits(): Promise<void> {
  expect(await browser.execute(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const footer = dialog?.querySelector("footer")?.getBoundingClientRect();
    return !!dialog && !!footer && footer.bottom <= innerHeight && footer.top >= 0
      && dialog.scrollWidth <= dialog.clientWidth;
  })).toBe(true);
}
