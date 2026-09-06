import { $, browser, expect } from "@wdio/globals";

import type { Role, RoleStatus } from "../../../src/shared/types";
import {
  electronDesktopE2eArmApplicationShortcutFullscreenExit,
  electronDesktopE2eFullscreenToolbarRuntime,
  electronDesktopE2eProbe,
  electronDesktopE2eRoleSessionRuntime,
  type ElectronDesktopE2eFullscreenToolbarRuntimeInspection
} from "../support/electron-driver";
import {
  readElectronDesktopE2eTerminalJson,
  waitForElectronDesktopE2eTerminalNativeQuit
} from "../support/electron-terminal-native-quit";
import {
  clickVisibleElectronRolePageButton,
  movePointerToWindowsRuntimeHostRevealEdge,
  submitElectronRolePageFullscreenShortcut
} from "../support/electron-role-surface";
import { fixtureCursor, fixtureEvents } from "../support/fixture";
import {
  clickMacosFullscreenToolbarViewMenuItem,
  clickMacosVisibleFullscreenControl,
  movePointerToMacosFullscreenRevealEdge,
  movePointerToMacosRuntimeContent
} from "../support/macos-appkit-ui";
import { pressVisibleMacosApplicationShortcut } from
  "../support/native-application-actions";
import { rendererCall } from "../support/renderer-bridge";
import {
  acceptLegalAndSkipFirstRun,
  ensureEnglishUi,
  waitForRoute
} from "../support/ui";

// [journey:CHROMIUM-MACOS-APPKIT-FULLSCREEN-TOOLBAR-012]
// [journey:CHROMIUM-WINDOWS-FULLSCREEN-TOOLBAR-012]

const ROLE_NAME = "Chromium Entity Role Edited";
const ROLE_FIXTURE_ID = "chromium-entity";
const PREFERENCE_LABEL = "Always show the toolbar in full screen";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the fullscreen-toolbar journey`);
  return value;
}

async function openSection(label: string, route: string): Promise<void> {
  const sidebar = await $(".app-main-sidebar");
  await sidebar.waitForDisplayed({ timeout: 20_000 });
  const button = await sidebar.$(`button*=${label}`);
  await button.waitForClickable({ timeout: 10_000 });
  await button.click();
  await waitForRoute(route);
}

async function findRole(): Promise<Role> {
  let role: Role | undefined;
  await browser.waitUntil(async () => {
    role = (await rendererCall("listRoles"))
      .find((candidate) => candidate.name === ROLE_NAME);
    return role !== undefined;
  }, { timeout: 15_000, timeoutMsg: `Did not find ${ROLE_NAME}` });
  return role!;
}

async function launchRole(role: Role): Promise<Readonly<{
  tabId: string;
  windowId: string;
}>> {
  await openSection("Roles", "/roles");
  const card = await $(`[data-selection-id='${role.id}']`);
  await card.waitForDisplayed({ timeout: 10_000 });
  await card.scrollIntoView({ block: "center", inline: "center" });
  await card.moveTo();
  const existing = (await rendererCall("listRoleStatuses"))
    .find((status) => status.roleId === role.id && status.state === "running");
  if (!existing) {
    const open = await card.$("button[aria-label='Open']");
    await open.waitForClickable({ timeout: 20_000 });
    await open.click();
  }
  let status: RoleStatus | undefined;
  let runtime: Awaited<
    ReturnType<typeof electronDesktopE2eRoleSessionRuntime>
  > | undefined;
  await browser.waitUntil(async () => {
    status = (await rendererCall("listRoleStatuses"))
      .find((candidate) => candidate.roleId === role.id);
    if (status?.state !== "running") return false;
    runtime = await electronDesktopE2eRoleSessionRuntime(role.id);
    return runtime.currentRuntime !== null;
  }, {
    timeout: 45_000,
    timeoutMsg: `Role ${role.id} did not reach a live native Chromium runtime`
  });
  expect(status?.resolvedEngine).toBe("chromium");
  expect(runtime?.currentRuntime).not.toBeNull();
  return {
    tabId: runtime!.currentRuntime!.tabId,
    windowId: runtime!.currentRuntime!.windowId
  };
}

async function waitForToolbar(
  windowId: string,
  predicate: (inspection: ElectronDesktopE2eFullscreenToolbarRuntimeInspection) => boolean,
  message: string
): Promise<ElectronDesktopE2eFullscreenToolbarRuntimeInspection> {
  let inspection: ElectronDesktopE2eFullscreenToolbarRuntimeInspection | undefined;
  let stableSamples = 0;
  await browser.waitUntil(async () => {
    try {
      inspection = await electronDesktopE2eFullscreenToolbarRuntime(windowId);
      stableSamples = predicate(inspection) ? stableSamples + 1 : 0;
      return stableSamples >= 3;
    } catch {
      stableSamples = 0;
      return false;
    }
  }, { interval: 100, timeout: 20_000, timeoutMsg: message });
  return inspection!;
}

function roleSurface(
  inspection: ElectronDesktopE2eFullscreenToolbarRuntimeInspection,
  roleId: string
) {
  const surface = inspection.surfaces.find((candidate) =>
    candidate.kind === "role" && candidate.id === roleId
  );
  expect(surface).toEqual(expect.objectContaining({ visible: true }));
  return surface!;
}

async function setWindowsPreference(alwaysShow: boolean): Promise<void> {
  await openSection("Settings", "/settings");
  const sidebar = await $(".settings-mode-sidebar");
  const preferences = await sidebar.$("button=Preferences");
  if (await preferences.isExisting()) {
    await preferences.waitForClickable({ timeout: 10_000 });
    await preferences.click();
    await waitForRoute("/settings?section=preferences");
  }
  const toggle = await $(`button[role='switch'][aria-label='${PREFERENCE_LABEL}']`);
  await toggle.waitForDisplayed({ timeout: 10_000 });
  const expected = alwaysShow ? "checked" : "unchecked";
  if ((await toggle.getAttribute("data-state")) !== expected) {
    await toggle.waitForEnabled({ timeout: 10_000 });
    await toggle.click();
  }
  await browser.waitUntil(async () =>
    (await toggle.getAttribute("data-state")) === expected &&
    (await rendererCall("getRuntimeWindowPreferences"))
      .alwaysShowToolbarInFullScreen === alwaysShow, {
    timeout: 15_000,
    timeoutMsg: `Windows fullscreen-toolbar preference did not become ${expected}`
  });
}

async function setPreference(
  platform: "macos" | "windows",
  alwaysShow: boolean
): Promise<void> {
  const current = (await rendererCall("getRuntimeWindowPreferences"))
    .alwaysShowToolbarInFullScreen;
  if (platform === "windows") {
    await setWindowsPreference(alwaysShow);
    return;
  }
  if (current !== alwaysShow) await clickMacosFullscreenToolbarViewMenuItem();
  await browser.waitUntil(async () =>
    (await rendererCall("getRuntimeWindowPreferences"))
      .alwaysShowToolbarInFullScreen === alwaysShow, {
    timeout: 15_000,
    timeoutMsg: `AppKit View-menu preference did not become ${alwaysShow}`
  });
}

async function enterFullscreen(input: Readonly<{
  mainWindowHandle: string;
  platform: "macos" | "windows";
  role: Role;
  windowId: string;
}>): Promise<number | null> {
  if (input.platform === "macos") {
    await clickVisibleElectronRolePageButton(input.role.launchUrl, input.mainWindowHandle);
    await movePointerToMacosRuntimeContent(input.windowId);
    await clickMacosVisibleFullscreenControl(input.windowId);
    return null;
  }
  const afterSequence = await fixtureCursor();
  await submitElectronRolePageFullscreenShortcut(
    input.role.launchUrl,
    input.mainWindowHandle,
    input.windowId
  );
  return afterSequence;
}

async function exitFullscreen(input: Readonly<{
  mainWindowHandle: string;
  platform: "macos" | "windows";
  role: Role;
  windowId: string;
}>): Promise<ElectronDesktopE2eFullscreenToolbarRuntimeInspection> {
  if (input.platform === "windows") {
    await submitElectronRolePageFullscreenShortcut(
      input.role.launchUrl,
      input.mainWindowHandle,
      input.windowId
    );
    return waitForToolbar(
      input.windowId,
      (inspection) => inspection.presentation === "normal" &&
        !inspection.native.fullscreen,
      "Visible fullscreen exit did not reach the exact native normal event"
    );
  }
  await movePointerToMacosFullscreenRevealEdge(input.windowId);
  await waitForToolbar(input.windowId, (inspection) =>
    inspection.presentation === "fullscreen" &&
    inspection.native.nativeControlsVisible && inspection.native.toolbarVisible,
  "The AppKit fullscreen control did not become visibly revealed");
  await electronDesktopE2eArmApplicationShortcutFullscreenExit(input.windowId);
  process.env.RION_STUDIO_E2E_TERMINAL_NATIVE_QUIT = "1";
  await pressVisibleMacosApplicationShortcut({
    command: "toggleFullscreen",
    processId: (await electronDesktopE2eProbe()).processId,
    runtimeTabName: input.role.name,
    targetMode: "focused-runtime"
  });
  await waitForElectronDesktopE2eTerminalNativeQuit();
  const candidates = await readElectronDesktopE2eTerminalJson(
    "electron-fullscreen-toolbar-observations.json"
  );
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error("The AppKit toolbar terminal observation is missing");
  }
  const candidate = candidates.at(-1) as Partial<
    ElectronDesktopE2eFullscreenToolbarRuntimeInspection
  > | undefined;
  if (
    !candidate || candidate.windowId !== input.windowId ||
    candidate.presentation !== "normal" || candidate.native?.fullscreen !== false ||
    candidate.native.alwaysShowToolbarInFullScreen !== false
  ) {
    throw new Error("The AppKit toolbar terminal observation is stale");
  }
  return candidate as ElectronDesktopE2eFullscreenToolbarRuntimeInspection;
}

function hiddenToolbar(
  inspection: ElectronDesktopE2eFullscreenToolbarRuntimeInspection,
  platform: "macos" | "windows"
): boolean {
  const common = inspection.presentation === "fullscreen" &&
    inspection.native.fullscreen &&
    !inspection.native.alwaysShowToolbarInFullScreen &&
    !inspection.native.toolbarVisible &&
    !inspection.native.nativeControlsVisible &&
    inspection.native.nativeWindowControlCount === 0;
  if (!common || inspection.hostKind !== (platform === "macos" ? "appkit" : "windows")) {
    return false;
  }
  return platform === "windows" || (
    inspection.native.appKit?.fullscreenHostReady === true &&
    inspection.native.appKit.presentationAutoHideToolbar &&
    !inspection.native.appKit.accessoryOnScreen &&
    !inspection.native.appKit.tabStripOnScreen &&
    !inspection.native.appKit.toolbarPinned &&
    inspection.native.appKit.visibleTrafficLightCount === 0
  );
}

async function proveHiddenAndExit(input: Readonly<{
  mainWindowHandle: string;
  platform: "macos" | "windows";
  role: Role;
  windowId: string;
}>): Promise<void> {
  const shortcutCursor = await enterFullscreen(input);
  const hidden = await waitForToolbar(
    input.windowId,
    (inspection) => hiddenToolbar(inspection, input.platform),
    "Live Role content did not reach exact fullscreen auto-hide"
  );
  roleSurface(hidden, input.role.id);
  if (shortcutCursor !== null) {
    const events = await fixtureEvents({
      afterSequence: shortcutCursor,
      roleId: ROLE_FIXTURE_ID
    });
    expect(events.some((event) => event.code === "F11")).toBe(false);
  }
  await exitFullscreen(input);
}

async function seedPhase(input: Readonly<{
  mainWindowHandle: string;
  platform: "macos" | "windows";
  role: Role;
  tabId: string;
  windowId: string;
}>): Promise<void> {
  await setPreference(input.platform, false);
  await clickVisibleElectronRolePageButton(input.role.launchUrl, input.mainWindowHandle);
  const normal = await waitForToolbar(input.windowId, (inspection) =>
    inspection.presentation === "normal" && inspection.native.toolbarVisible &&
    inspection.native.nativeWindowControlCount === 3, "Toolbar baseline is unavailable");
  expect(normal.tabIds).toContain(input.tabId);
  const normalRole = roleSurface(normal, input.role.id);

  const shortcutCursor = await enterFullscreen(input);
  let hidden = await waitForToolbar(
    input.windowId,
    (inspection) => hiddenToolbar(inspection, input.platform),
    "Live Role content did not expand under the auto-hidden tab row"
  );
  const hiddenRole = roleSurface(hidden, input.role.id);
  if (input.platform === "windows") {
    expect(hiddenRole.bounds.y).toBe(2);
    expect(normalRole.bounds.y).toBe(40);
  }
  if (shortcutCursor !== null) {
    const events = await fixtureEvents({
      afterSequence: shortcutCursor,
      roleId: ROLE_FIXTURE_ID
    });
    expect(events.some((event) => event.code === "F11")).toBe(false);
  }

  if (input.platform === "macos") {
    await movePointerToMacosFullscreenRevealEdge(input.windowId);
  } else {
    await movePointerToWindowsRuntimeHostRevealEdge(input.mainWindowHandle);
  }
  const revealed = await waitForToolbar(input.windowId, (inspection) =>
    inspection.presentation === "fullscreen" && inspection.native.revealed &&
    inspection.native.toolbarVisible && inspection.native.nativeControlsVisible &&
    inspection.native.nativeWindowControlCount === 3 &&
    (input.platform === "windows" || (
      inspection.native.appKit?.accessoryOnScreen === true &&
      inspection.native.appKit.tabStripOnScreen &&
      inspection.native.appKit.visibleTrafficLightCount === 3
    )), "Real screen-edge pointer motion did not reveal native controls");
  if (input.platform === "windows") {
    const surface = roleSurface(revealed, input.role.id);
    expect(surface.bounds.y).toBe(40);
    expect(hiddenRole.bounds.height - surface.bounds.height).toBe(38);
    expect(surface.bounds.width).toBe(hiddenRole.bounds.width);
    expect(surface.bounds.y + surface.bounds.height).toBe(
      hiddenRole.bounds.y + hiddenRole.bounds.height
    );
  } else {
    await movePointerToMacosRuntimeContent(input.windowId);
  }

  await clickVisibleElectronRolePageButton(input.role.launchUrl, input.mainWindowHandle);
  hidden = await waitForToolbar(
    input.windowId,
    (inspection) => hiddenToolbar(inspection, input.platform),
    "Pointer leave did not return the fullscreen toolbar off screen"
  );
  roleSurface(hidden, input.role.id);

  await setPreference(input.platform, true);
  const pinned = await waitForToolbar(input.windowId, (inspection) =>
    inspection.presentation === "fullscreen" &&
    inspection.native.alwaysShowToolbarInFullScreen &&
    inspection.native.toolbarVisible && inspection.native.nativeControlsVisible &&
    inspection.native.nativeWindowControlCount === 3 &&
    (input.platform === "windows" ||
      inspection.native.appKit?.toolbarPinned === true),
  "Always-show did not pin the live native toolbar");
  if (input.platform === "windows") {
    expect(roleSurface(pinned, input.role.id).bounds.y).toBe(40);
  }

  await setPreference(input.platform, false);
  await waitForToolbar(
    input.windowId,
    (inspection) => hiddenToolbar(inspection, input.platform),
    "Reverse preference update did not hide every live toolbar"
  );
  await exitFullscreen(input);
}

describe("Chromium fullscreen Game Window toolbar parity", () => {
  it("uses paired visible native actions and restores the persisted auto-hide baseline", async () => {
    const probe = await electronDesktopE2eProbe();
    expect(probe.runtimeTarget).toBe(required("RION_STUDIO_E2E_RUNTIME_TARGET"));
    await ensureEnglishUi();
    await acceptLegalAndSkipFirstRun();
    const mainWindowHandle = await browser.getWindowHandle();
    const role = await findRole();
    const { tabId, windowId } = await launchRole(role);
    const input = { mainWindowHandle, platform: probe.platform, role, tabId, windowId };
    const phase = required("RION_STUDIO_E2E_PHASE");
    if (phase === "chromium-fullscreen-toolbar-seed") await seedPhase(input);
    else if (phase === "chromium-fullscreen-toolbar-restart") {
      expect((await rendererCall("getRuntimeWindowPreferences"))
        .alwaysShowToolbarInFullScreen).toBe(false);
      await setPreference(probe.platform, false);
      await proveHiddenAndExit(input);
    } else {
      throw new Error(`Unexpected Chromium fullscreen-toolbar phase ${phase}`);
    }
  });
});
