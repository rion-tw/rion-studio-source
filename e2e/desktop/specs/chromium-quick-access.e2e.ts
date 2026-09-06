import { $, browser, expect } from "@wdio/globals";
import { Key } from "webdriverio";

import type { Role } from "../../../src/shared/types";
import {
  electronDesktopE2eProbe,
  electronDesktopE2eRoleSessionRuntime
} from "../support/electron-driver";
import { submitElectronRolePageQuickAccessShortcut } from
  "../support/electron-role-surface";
import { fixtureCursor, fixtureEvents } from "../support/fixture";
import {
  focusVisibleMacosAppKitRuntime,
  pressVisibleMacosApplicationShortcut
} from
  "../support/native-application-actions";
import { rendererCall } from "../support/renderer-bridge";
import {
  acceptLegalAndSkipFirstRun,
  clickDialogButton,
  ensureEnglishUi,
  waitForRoute
} from "../support/ui";

// [journey:CHROMIUM-MACOS-APPKIT-QUICK-ACCESS-015]
// [journey:CHROMIUM-WINDOWS-QUICK-ACCESS-015]

const ROLE_NAME = "Chromium Entity Role Edited";
const ROLE_FIXTURE_ID = "chromium-entity";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the Chromium Quick Access journey`);
  return value;
}

function platform(): "macos" | "windows" {
  const target = required("RION_STUDIO_E2E_RUNTIME_TARGET");
  if (target === "chromium-v23-macos-appkit") return "macos";
  if (target === "chromium-v23-windows") return "windows";
  throw new Error(`Unsupported Chromium Quick Access runtime target ${target}`);
}

async function openSection(label: string, route: string): Promise<void> {
  const sidebar = await $(".app-main-sidebar");
  await sidebar.waitForDisplayed({ timeout: 20_000 });
  await sidebar.$(`button*=${label}`).click();
  await waitForRoute(route);
}

async function findRole(): Promise<Role> {
  let role: Role | undefined;
  await browser.waitUntil(async () => {
    role = (await rendererCall("listRoles"))
      .find((candidate) => candidate.name === ROLE_NAME);
    return role !== undefined;
  }, { timeout: 15_000, timeoutMsg: `Did not find ${ROLE_NAME}` });
  return role as Role;
}

async function openPaletteFromSidebar(): Promise<void> {
  await $("[data-testid='quick-access-trigger']").click();
  const palette = await $("[data-testid='quick-access-palette'][open]");
  await palette.waitForDisplayed({ timeout: 10_000 });
}

async function closePaletteWithEscape(): Promise<void> {
  const palette = await $("[data-testid='quick-access-palette'][open]");
  await browser.keys(Key.Escape);
  await palette.waitForExist({ reverse: true, timeout: 10_000 });
}

async function submitMainWindowShortcut(): Promise<void> {
  const modifier = platform() === "macos" ? Key.Command : Key.Ctrl;
  await browser.action("key")
    .down(modifier)
    .down("k")
    .up("k")
    .up(modifier)
    .perform();
}

async function clickEntityMenuAction(
  entityId: string,
  triggerLabels: readonly string[],
  actionLabel: string
): Promise<void> {
  const entity = await $(`[data-selection-id='${entityId}']`);
  await entity.waitForDisplayed({ timeout: 10_000 });
  await entity.scrollIntoView({ block: "center", inline: "center" });
  await entity.moveTo();
  let actionTrigger;
  for (const label of triggerLabels) {
    const candidate = await entity.$(`button[aria-label='${label}']`);
    if (await candidate.isExisting()) {
      actionTrigger = candidate;
      break;
    }
  }
  if (!actionTrigger) {
    throw new Error(`Entity ${entityId} has no visible action trigger`);
  }
  // The cover action fades in after hover. Presence identifies the exact
  // localized control; clickability is the authoritative visible-UI fence.
  await actionTrigger.waitForClickable({ timeout: 10_000 });
  await actionTrigger.click();
  const action = await $(`//*[@role='menuitem' and normalize-space(.)='${actionLabel}']`);
  await action.waitForClickable({ timeout: 10_000 });
  await action.click();
}

async function readRuntime(role: Role) {
  await rendererCall("getAppSnapshot");
  return electronDesktopE2eRoleSessionRuntime(role.id);
}

async function waitForRuntimeFocus(role: Role, focused: boolean): Promise<void> {
  await browser.waitUntil(async () => (
    await readRuntime(role)
  ).currentRuntime?.focused === focused, {
    timeout: 20_000,
    timeoutMsg: `Role ${role.id} did not reach native focused=${focused}`
  });
}

async function expectManagedPageDidNotReceiveK(afterSequence: number): Promise<void> {
  const events = await fixtureEvents({ afterSequence, roleId: ROLE_FIXTURE_ID });
  expect(events.some((event) => event.code === "KeyK" && event.kind === "keydown"))
    .toBe(false);
}

async function openManagedPageQuickAccess(
  role: Role,
  mainWindowHandle: string,
  processId: number
): Promise<number> {
  const afterSequence = await fixtureCursor();
  const runtime = (await readRuntime(role)).currentRuntime;
  if (!runtime) {
    throw new Error(`Role ${role.id} has no visible native runtime to focus`);
  }
  if (platform() === "macos") {
    // ChromeDriver's launcher-side diagnostic read can make the launcher main.
    // Restore the exact Core-projected AppKit host before the physical shortcut.
    await focusVisibleMacosAppKitRuntime({
      processId,
      runtimeTabName: role.name,
      windowId: runtime.windowId
    });
    await pressVisibleMacosApplicationShortcut({
      command: "quickAccess",
      processId,
      runtimeTabName: role.name,
      targetMode: "focused-runtime"
    });
  } else {
    await submitElectronRolePageQuickAccessShortcut(
      role.launchUrl,
      mainWindowHandle,
      runtime.windowId
    );
  }
  try {
    await $("[data-testid='quick-access-palette'][open]")
      .waitForDisplayed({ timeout: 10_000 });
  } catch (error) {
    const diagnostic = await browser.execute(() => ({
      activeElement: document.activeElement?.outerHTML.slice(0, 400) ?? null,
      focused: document.hasFocus(),
      palette: document.querySelector("[data-testid='quick-access-palette']")
        ?.outerHTML.slice(0, 800) ?? null
    }));
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; ` +
      `Quick Access diagnostic ${JSON.stringify(diagnostic)}`,
      { cause: error }
    );
  }
  await expectManagedPageDidNotReceiveK(afterSequence);
  await waitForRuntimeFocus(role, false);
  return afterSequence;
}

async function seedPhase(mainWindowHandle: string, processId: number): Promise<void> {
  const role = await findRole();
  await openSection("Home", "/dashboard");

  await openPaletteFromSidebar();
  await closePaletteWithEscape();
  await submitMainWindowShortcut();
  await $("[data-testid='quick-access-palette'][open]")
    .waitForDisplayed({ timeout: 10_000 });
  await closePaletteWithEscape();

  await openSection("Roles", "/roles");
  await clickEntityMenuAction(
    role.id,
    ["Role actions", "Click for actions or drag to reorder"],
    "Delete"
  );
  await $("dialog[open]").waitForDisplayed({ timeout: 10_000 });
  await submitMainWindowShortcut();
  expect(await $("[data-testid='quick-access-palette'][open]").isExisting()).toBe(false);
  await clickDialogButton("Cancel");

  await openSection("Home", "/dashboard");
  await openPaletteFromSidebar();
  const palette = await $("[data-testid='quick-access-palette'][open]");
  const search = await palette.$("input[role='combobox']");
  await search.setValue(role.name);
  const option = await $(`#quick-access-option-role-${role.id}`);
  await option.waitForDisplayed({ timeout: 10_000 });
  await $(`button[aria-label='Pin ${role.name}']`).click();
  await $(`button[aria-label='Unpin ${role.name}']`)
    .waitForDisplayed({ timeout: 10_000 });
  await option.click();
  await browser.waitUntil(async () => (await readRuntime(role)).currentRuntime !== null, {
    timeout: 45_000,
    timeoutMsg: `Quick Access did not launch managed Chromium Role ${role.id}`
  });

  await openManagedPageQuickAccess(role, mainWindowHandle, processId);
  await closePaletteWithEscape();
  await waitForRuntimeFocus(role, true);

  await openManagedPageQuickAccess(role, mainWindowHandle, processId);
  await $("#quick-access-option-route-settings").click();
  await waitForRoute("/settings");
  await waitForRuntimeFocus(role, false);
  expect(await browser.execute(() => document.hasFocus())).toBe(true);

  const preferences = (await rendererCall("getAppSnapshot")).quickAccessPreferences;
  expect(preferences.pinnedItems).toContainEqual({ kind: "role", id: role.id });
  expect(preferences.recentItems).toContainEqual({ kind: "role", id: role.id });
}

async function restartPhase(): Promise<void> {
  const role = await findRole();
  await openSection("Home", "/dashboard");
  await openPaletteFromSidebar();
  const pinned = await $(`[data-quick-access-group='pinned'] #quick-access-option-role-${role.id}`);
  await pinned.waitForDisplayed({ timeout: 10_000 });
  await $(`button[aria-label='Unpin ${role.name}']`).click();
  const recent = await $(`[data-quick-access-group='recent'] #quick-access-option-role-${role.id}`);
  await recent.waitForDisplayed({ timeout: 10_000 });
  await closePaletteWithEscape();

  await openSection("Settings", "/settings");
  const clearRecent = await $("button=Clear recent");
  await clearRecent.waitForEnabled({ timeout: 10_000 });
  await clearRecent.click();
  await clearRecent.waitForEnabled({ reverse: true, timeout: 10_000 });
  await $("button=Back to app").click();
  await waitForRoute("/dashboard");
  await openPaletteFromSidebar();
  expect(await $(`#quick-access-option-role-${role.id}`).isExisting()).toBe(false);

  const preferences = (await rendererCall("getAppSnapshot")).quickAccessPreferences;
  expect(preferences).toEqual({ pinnedItems: [], recentItems: [] });
}

describe("Chromium Quick Access parity", () => {
  it("uses visible main and managed-page actions with persistent preferences", async () => {
    const probe = await electronDesktopE2eProbe();
    expect(probe.runtimeTarget).toBe(required("RION_STUDIO_E2E_RUNTIME_TARGET"));
    await ensureEnglishUi();
    await acceptLegalAndSkipFirstRun();
    const mainWindowHandle = await browser.getWindowHandle();

    const phase = required("RION_STUDIO_E2E_PHASE");
    if (phase === "chromium-quick-access-seed") {
      await seedPhase(mainWindowHandle, probe.processId);
    }
    else if (phase === "chromium-quick-access-restart") await restartPhase();
    else throw new Error(`Unexpected Chromium Quick Access phase ${phase}`);
  });
});
