import { verifyTemporaryWindowTitle } from "../support/temporary-window-title";
import { extensionTerminalIds, expectExtensionPassedClassification, verifyExtensionPermissionsAfterRestart } from "../support/extensions-permissions";
import { verifyBusterStoreNavigation } from "../support/extensions-store-navigation";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { captureNativeApplicationObservation } from "../support/native-application-observation";
import { compactExtensionsWindow } from "../support/extensions-layout";
import {
  electronDesktopE2eGameWindowRuntime,
  electronDesktopE2eProbe
} from "../support/electron-driver";
import { selectMacosVisibleRuntimeTabMenuAction } from "../support/macos-appkit-ui";
import {
  closeVisibleRuntimeTab,
  installRuntimeTabShellErrorJournal,
  runtimeTabShellErrors
} from "../support/native-runtime-tabs";
import { rendererCall } from "../support/renderer-bridge";
import { acceptLegalAndSkipFirstRun, clickDialogButton, ensureEnglishUi, setEditorName, setInputValue, submitEditor, waitForRoute } from "../support/ui";

// [journey:CHROMIUM-MACOS-APPKIT-EXTENSIONS-001]
// [journey:CHROMIUM-WINDOWS-EXTENSIONS-001]
const EXTENSION_ID = "gighmmpiobklfepjocnamgkkbiglidom";

function hasTerminalCompatibilityStatus(status: string): boolean {
  return status === "loaded" || status === "degraded";
}

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
      const processId = (await electronDesktopE2eProbe()).processId;
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
      await verifyBusterStoreNavigation(processId, main);
      const search = await $(
        'input[type="search"],input[aria-label*="Search"],input[placeholder*="Search"]'
      );
      await search.waitForClickable({ timeout: 30_000 });
      await search.click();
      await search.setValue("AdBlock");
      await browser.keys("Enter");
      const result = await $(`a[href*="/detail/"][href*="${EXTENSION_ID}"]`);
      await result.waitForClickable({ timeout: 30_000 });
      await result.click();
      await browser.waitUntil(async () => new URL(await browser.getUrl()).pathname.endsWith(`/${EXTENSION_ID}`), { timeout: 30_000 });
      await $("h1*=AdBlock").waitForDisplayed({ timeout: 30_000 });
      await browser.switchToWindow(main);
      const install = await $("button=Install this extension");
      await install.waitForEnabled({
        timeout: 30_000,
        timeoutMsg: "Visible Chrome Web Store selection did not expose the extension action"
      });
      expect((await electronDesktopE2eProbe()).processId).toBe(processId);
      await install.click();
      const confirm = await $("button=Confirm installation");
      // DeadlineBound test boundary: external store failure is a failed journey.
      await confirm.waitForDisplayed({ timeout: 150000 });
      await $("#app-editor-form").$("button=All roles").click();
      await expectEditorFits();
      await browser.saveScreenshot(join(process.env.RION_STUDIO_E2E_ARTIFACT_DIR!, "screenshots", "extensions-confirm.png"));
      await confirm.click();
      await browser.waitUntil(async () => (await rendererCall("extensions", { type: "snapshot" })).snapshot.installed.some(p => p.id === EXTENSION_ID && p.applyToAllRoles), { timeout: 15000 });
      await expectInstalledCardMetadata();
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
      await installRuntimeTabShellErrorJournal();
      await captureNativeApplicationObservation("extensions-before-role-open");
      const initialTerminals = await extensionTerminalIds();
      await $(`[data-selection-id='${future.id}']`)
        .$("button[aria-label='Open']").click();
      try {
        await browser.waitUntil(async () => (await rendererCall("extensions", {
          type: "snapshot"
        })).snapshot.roles.some((role) =>
          role.roleId === future.id &&
          hasTerminalCompatibilityStatus(role.status) &&
          role.extensionIds.includes(EXTENSION_ID)
        ), { timeout: 30000 });
      } finally {
        await captureNativeApplicationObservation("extensions-after-role-open");
      }
      await browser.switchToWindow(main);
      await expectExtensionPassedClassification(future.id, initialTerminals);
      await browser.waitUntil(async () => (await rendererCall("listRoleStatuses")).some(r => r.roleId === future.id && r.state === "running"), { timeout: 30000 });
      const runtime = await rendererCall("getEmbeddedRuntimeState");
      const roleTab = runtime.tabs.find((tab) => tab.sourceId === future.id);
      if (!roleTab) throw new Error("The extension Role did not own an exact runtime tab");
      const probe = await electronDesktopE2eProbe();
      await verifyTemporaryWindowTitle({ platform: probe.platform, processId, windowId: roleTab.windowId });
      if (probe.platform === "macos") {
        await selectMacosVisibleRuntimeTabMenuAction({
          action: "stop",
          tabId: roleTab.id,
          tabName: future.name,
          windowId: roleTab.windowId
        });
      } else {
        await closeVisibleRuntimeTab({
          mainWindowHandle: main,
          platform: "windows",
          tabId: roleTab.id,
          tabName: future.name,
          windowId: roleTab.windowId
        });
      }
      await browser.waitUntil(async () => {
        const [current, statuses, native] = await Promise.all([
          rendererCall("getEmbeddedRuntimeState"),
          rendererCall("listRoleStatuses"),
          electronDesktopE2eGameWindowRuntime(roleTab.windowId)
        ]);
        return !current.tabs.some((tab) => tab.id === roleTab.id) &&
          !statuses.some((status) => status.roleId === future.id) &&
          native.currentRuntime === null;
      }, {
        timeout: 45_000,
        timeoutMsg: "The extension Role did not stop and retire its last native window"
      });
      expect(await runtimeTabShellErrors()).toEqual([]);
      expect((await electronDesktopE2eProbe()).processId).toBe(probe.processId);
      const previousTerminals = await extensionTerminalIds();
      await $(`[data-selection-id='${future.id}']`)
        .$("button[aria-label='Open']").click();
      await browser.waitUntil(async () => {
        const [statuses, extensions] = await Promise.all([
          rendererCall("listRoleStatuses"),
          rendererCall("extensions", { type: "snapshot" })
        ]);
        return statuses.some((status) =>
          status.roleId === future.id && status.state === "running"
        ) && extensions.snapshot.roles.some((role) =>
          role.roleId === future.id && hasTerminalCompatibilityStatus(role.status) &&
          role.extensionIds.includes(EXTENSION_ID)
        );
      }, {
        timeout: 30_000,
        timeoutMsg: "The extension Role did not reopen with compatibility readiness"
      });
      expect(await runtimeTabShellErrors()).toEqual([]);
      await expectExtensionPassedClassification(future.id, previousTerminals);
    } else if (phase === "chromium-extensions-restart") {
      await expect(sidebar.$("button*=Extensions")).toHaveText(/^Extensions\s*1$/);
      const snapshot = (await rendererCall("extensions", { type: "snapshot" })).snapshot;
      const installed = snapshot.installed.find(p => p.id === EXTENSION_ID && !p.removed);
      expect(installed?.applyToAllRoles).toBe(true);
      expect(installed?.enabledRoleIds).toHaveLength(0);
      expect(installed?.description?.trim().length).toBeGreaterThan(0);
      expect(installed?.iconDataUrl?.startsWith("data:image/")).toBe(true);
      expect(installed?.sizeBytes).toBeGreaterThan(0);
      expect(installed?.permissions).toContain("management");
      expect(installed?.requiredApiPermissions).toBeDefined();
      expect(installed?.requiredApiPermissions).not.toContain("management");
      await expectInstalledCardMetadata();
      await browser.saveScreenshot(join(process.env.RION_STUDIO_E2E_ARTIFACT_DIR!, "screenshots", "extensions-installed-dark.png"));
      await verifyExtensionPermissionsAfterRestart();
      await $("button=Manage").click();
      await waitForRoute(`/extensions/${EXTENSION_ID}/edit`);
      await $("#app-editor-form").$("button=Selected roles").click();
      const checkbox = await $("label*=Extensions journey role").$("[role=checkbox]");
      await expect(checkbox).toHaveAttribute("data-state", "checked");
      await expectEditorFits();
      await browser.saveScreenshot(join(process.env.RION_STUDIO_E2E_ARTIFACT_DIR!, "screenshots", "extensions-manage-dark.png"));
      await $("button=Clear selection").click();
      await $("button=Save").click();
      await browser.waitUntil(async () => (await rendererCall("extensions", { type: "snapshot" })).snapshot.installed.find(p => p.id === EXTENSION_ID)?.applyToAllRoles === false);
      await waitForRoute("/extensions");
      await $("button=Manage").click();
      await waitForRoute(`/extensions/${EXTENSION_ID}/edit`);
      await $("#app-editor-form").$("button=Remove").click();
      await clickDialogButton("Cancel");
      expect((await rendererCall("extensions", { type: "snapshot" })).snapshot.installed.some(p => p.id === EXTENSION_ID && !p.removed)).toBe(true);
      expect(await $("#app-editor-form").isExisting()).toBe(true);
      await $("#app-editor-form").$("button=Remove").click();
      await clickDialogButton("Confirm removal");
      await waitForRoute("/extensions");
      await browser.waitUntil(async () => !(await rendererCall("extensions", { type: "snapshot" })).snapshot.installed.some(p => p.id === EXTENSION_ID && !p.removed));
      await expect($("h2=No extensions installed yet.")).toBeDisplayed();
      await expect(sidebar.$("button*=Extensions")).toHaveText(/^Extensions\s*0$/);
    } else throw new Error(`Unexpected Extensions phase: ${phase}`);
  });
});

async function expectInstalledCardMetadata(): Promise<void> {
  const observe = () => browser.execute((extensionId) => {
    const card = document.querySelector<HTMLElement>(`[data-extension-id="${extensionId}"]`);
    const list = card?.closest<HTMLElement>(".collection-grid-extensions");
    const icon = card?.querySelector<HTMLImageElement>("img");
    const description = card?.querySelector<HTMLElement>("[data-extension-description]");
    const size = card?.querySelector<HTMLElement>("[data-extension-size]");
    const id = card?.querySelector<HTMLElement>("[data-extension-record-id]");
    const bounds = list?.getBoundingClientRect();
    return {
      present: !!card && !!list,
      gridTracks: list ? getComputedStyle(list).gridTemplateColumns.split(/\s+/).filter(Boolean).length : 0,
      noHorizontalOverflow: !!list && list.scrollWidth <= list.clientWidth
        && !!bounds && bounds.left >= 0 && bounds.right <= document.documentElement.clientWidth,
      iconRendered: !!icon && icon.complete && icon.naturalWidth > 0,
      description: description?.textContent?.trim() ?? "",
      size: size?.textContent?.trim() ?? "",
      id: id?.textContent?.trim() ?? "",
      idTitle: id?.title ?? ""
    };
  }, EXTENSION_ID);
  await browser.waitUntil(async () => {
    const current = await observe();
    return current.present && current.gridTracks === 3 && current.iconRendered;
  }, { timeout: 10000, timeoutMsg: "Installed extension metadata card did not finish rendering" });
  const observation = await observe();

  expect(observation.present).toBe(true);
  expect(observation.gridTracks).toBe(3);
  expect(observation.noHorizontalOverflow).toBe(true);
  expect(observation.iconRendered).toBe(true);
  expect(observation.description).not.toBe("");
  expect(observation.description).not.toBe("No description provided.");
  expect(observation.size).toMatch(/^\d+(?:\.\d)? (?:B|KB|MB)$/);
  expect(observation.id).toBe(EXTENSION_ID);
  expect(observation.idTitle).toBe(EXTENSION_ID);
}

async function expectEditorFits(): Promise<void> {
  expect(await browser.execute(() => {
    const editor = document.querySelector<HTMLElement>("#app-editor-form");
    const submit = editor?.querySelector<HTMLElement>("button[type='submit']")?.getBoundingClientRect();
    return !!editor && !document.querySelector('[role="dialog"], dialog[open]')
      && !!submit && submit.bottom <= innerHeight && submit.top >= 0 && submit.right <= innerWidth
      && editor.scrollWidth <= editor.clientWidth;
  })).toBe(true);
}
