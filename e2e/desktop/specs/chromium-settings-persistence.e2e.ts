import { $, browser, expect } from "@wdio/globals";

import type { Macro, Role, RoleStatus } from "../../../src/shared/types";
import {
  electronDesktopE2eProbe,
  electronDesktopE2eRoleSessionRuntime
} from "../support/electron-driver";
import { fixtureCursor, waitFixtureEvent } from "../support/fixture";
import { rendererCall } from "../support/renderer-bridge";
import {
  acceptLegalAndSkipFirstRun,
  ensureEnglishUi,
  submitEditor,
  waitForRoute
} from "../support/ui";

// [journey:CHROMIUM-MACOS-APPKIT-SETTINGS-PERSIST-006]
// [journey:CHROMIUM-WINDOWS-SETTINGS-PERSIST-006]

const ROLE_NAME = "Chromium Entity Role Edited";
const MACRO_NAME = "Chromium Entity Macro Edited";
const ROLE_FIXTURE_ID = "chromium-entity";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the Chromium settings journey`);
  return value;
}

function expectedHostKind(): "appkit-chromium" | "bundled-chromium" {
  const target = required("RION_STUDIO_E2E_RUNTIME_TARGET");
  if (target === "chromium-v23-macos-appkit") return "appkit-chromium";
  if (target === "chromium-v23-windows") return "bundled-chromium";
  throw new Error(`Unsupported Chromium settings runtime target ${target}`);
}

async function openAppSection(label: string, route: string): Promise<void> {
  const sidebar = await $(".app-main-sidebar");
  await sidebar.waitForDisplayed({ timeout: 20_000 });
  await sidebar.$(`button*=${label}`).click();
  await waitForRoute(route);
}

async function openSettingsThroughVisibleUi(): Promise<void> {
  await openAppSection("Settings", "/settings");
}

async function openSettingsSection(label: string, section: string): Promise<void> {
  const sidebar = await $(".settings-mode-sidebar");
  await sidebar.waitForDisplayed({ timeout: 10_000 });
  const sectionButton = await sidebar.$(`button=${label}`);
  await sectionButton.scrollIntoView({ block: "center" });
  await sectionButton.click();
  await waitForRoute(`/settings?section=${section}`);
}

async function switchControl(label: string) {
  const control = await $(`button[role='switch'][aria-label='${label}']`);
  await control.waitForDisplayed({ timeout: 10_000 });
  return control;
}

async function setSwitch(label: string, checked: boolean): Promise<void> {
  const control = await switchControl(label);
  const expectedState = checked ? "checked" : "unchecked";
  await control.waitForEnabled({ timeout: 10_000 });
  if ((await control.getAttribute("data-state")) !== expectedState) {
    await control.click();
  }
  await browser.waitUntil(async () =>
    (await control.getAttribute("data-state")) === expectedState
      && await control.isEnabled(), {
    timeout: 15_000,
    timeoutMsg: `${label} did not finish saving as ${expectedState}`
  });
}

async function expectSwitch(label: string, checked: boolean): Promise<void> {
  const control = await switchControl(label);
  await browser.waitUntil(
    async () => (await control.getAttribute("data-state")) ===
      (checked ? "checked" : "unchecked"),
    { timeout: 10_000, timeoutMsg: `${label} did not restore visibly` }
  );
}

async function setVisiblePreferences(): Promise<void> {
  const light = await $("button=Light");
  await light.waitForClickable({ timeout: 10_000 });
  await light.click();
  await browser.waitUntil(async () =>
    await light.getAttribute("aria-pressed") === "true"
      && await browser.execute(() => document.documentElement.dataset.theme) === "light", {
    timeout: 10_000,
    timeoutMsg: "The Chromium renderer did not visibly apply the Light theme"
  });

  await setSwitch("Always hide tab close buttons", true);
  // Exercise the saved startup behavior through the visible control even when
  // a prior default already selected it.
  await setSwitch("Restore Game Windows on startup", false);
  await setSwitch("Restore Game Windows on startup", true);

  await openSettingsSection("Interface settings", "interface");
  await setSwitch("Show macro tools button", false);
  await setSwitch("Show running macro badges", false);
  await setSwitch("Show macro click markers", false);
}

async function expectVisiblePreferences(): Promise<void> {
  const light = await $("button=Light");
  await light.waitForDisplayed({ timeout: 10_000 });
  expect(await light.getAttribute("aria-pressed")).toBe("true");
  expect(await browser.execute(() => document.documentElement.dataset.theme)).toBe("light");
  await expectSwitch("Always hide tab close buttons", true);
  await expectSwitch("Restore Game Windows on startup", true);

  await openSettingsSection("Interface settings", "interface");
  await expectSwitch("Show macro tools button", false);
  await expectSwitch("Show running macro badges", false);
  await expectSwitch("Show macro click markers", false);
}

async function expectPersistedPreferences(): Promise<void> {
  expect(await rendererCall("getRuntimeWindowPreferences")).toEqual(
    expect.objectContaining({
      alwaysHideTabCloseButton: true,
      alwaysShowToolbarInFullScreen: false,
      restoreGameWindowsOnStartup: true
    })
  );
  expect((await rendererCall("getGameBrowserSettings")).macroOverlay).toEqual({
    showClickMarkers: false,
    showRunningBadges: false,
    showToolButton: false
  });
}

async function leaveSettings(): Promise<void> {
  await $("button=Back to app").click();
  await waitForRoute("/dashboard");
}

async function findEntities(): Promise<Readonly<{ role: Role; macro: Macro }>> {
  const roles = (await rendererCall("listRoles"))
    .filter((candidate) => candidate.name === ROLE_NAME);
  const macros = (await rendererCall("listMacros"))
    .filter((candidate) => candidate.name === MACRO_NAME);
  expect(roles).toHaveLength(1);
  expect(macros).toHaveLength(1);
  expect(macros[0].roleIds).toContain(roles[0].id);
  return { role: roles[0], macro: macros[0] };
}

async function waitForRunningRole(roleId: string): Promise<RoleStatus> {
  let status: RoleStatus | undefined;
  await browser.waitUntil(async () => {
    status = (await rendererCall("listRoleStatuses"))
      .find((candidate) => candidate.roleId === roleId);
    return status?.state === "running";
  }, {
    timeout: 45_000,
    timeoutMsg: `Role ${roleId} did not reach running after its visible Open action`
  });
  return status as RoleStatus;
}

async function makeMacroExecutionPortable(macro: Macro): Promise<void> {
  await openAppSection("Macros", "/macros");
  const card = await $(`[data-selection-id='${macro.id}']`);
  await card.waitForDisplayed({ timeout: 10_000 });
  await card.scrollIntoView({ block: "center", inline: "center" });
  await card.moveTo();
  const actions = await card.$("button[aria-label='Macro actions']");
  await actions.waitForClickable({ timeout: 10_000 });
  await actions.click();
  const edit = await $("//*[@role='menuitem' and normalize-space(.)='Edit']");
  await edit.waitForClickable({ timeout: 10_000 });
  await edit.click();
  await waitForRoute(`/macros/${macro.id}/edit`);

  const step = await $("[data-macro-step-id]");
  const stepType = await step.$("button[aria-label='Step type']");
  await stepType.click();
  await $("[role='option']=Delay").click();
  const delay = await step.$("input[aria-label='Delay']");
  await delay.clearValue();
  await delay.setValue("60");
  await submitEditor("/macros");
}

function expectPortableMacro(macro: Macro): void {
  expect(macro.steps).toEqual([
    expect.objectContaining({ type: "delay", ms: 60_000 })
  ]);
}

async function openRoleThroughVisibleUi(role: Role): Promise<void> {
  await openAppSection("Roles", "/roles");
  const card = await $(`[data-selection-id='${role.id}']`);
  await card.waitForDisplayed({ timeout: 10_000 });
  await card.scrollIntoView({ block: "center", inline: "center" });
  await card.moveTo();

  const alreadyRunning = (await rendererCall("listRoleStatuses"))
    .some((status) => status.roleId === role.id && status.state === "running");
  if (!alreadyRunning) {
    const afterSequence = await fixtureCursor();
    const open = await card.$("button[aria-label='Open']");
    await open.waitForDisplayed({ timeout: 10_000 });
    await open.waitForEnabled({ timeout: 20_000 });
    await open.click();
    await waitFixtureEvent({
      afterSequence,
      kind: "session",
      roleId: ROLE_FIXTURE_ID
    });
  }

  const status = await waitForRunningRole(role.id);
  expect(status.resolvedEngine).toBe("chromium");
  expect(status.hostKind).toBe(expectedHostKind());
  const runtime = (await electronDesktopE2eRoleSessionRuntime(role.id)).currentRuntime;
  expect(runtime).toEqual(expect.objectContaining({
    hostKind: expectedHostKind(),
    visible: true
  }));
  if (expectedHostKind() === "appkit-chromium") {
    expect(runtime?.appKitIdentity).not.toBeNull();
  } else {
    expect(runtime?.appKitIdentity).toBeNull();
  }
}

async function runAndStopMacroThroughVisibleUi(macro: Macro): Promise<void> {
  await openAppSection("Macros", "/macros");
  const card = await $(`[data-selection-id='${macro.id}']`);
  await card.waitForDisplayed({ timeout: 10_000 });
  const start = await card.$("button[aria-label='Start']");
  await start.waitForEnabled({ timeout: 20_000 });
  await start.click();
  await browser.waitUntil(async () => (await rendererCall("listMacroStatuses"))
    .some((status) => status.macroId === macro.id && status.state === "running"), {
    timeout: 20_000,
    timeoutMsg: `Macro ${macro.id} did not run with its in-game controls hidden`
  });

  const stop = await card.$("button[aria-label='Stop']");
  await stop.waitForEnabled({ timeout: 20_000 });
  await stop.click();
  await browser.waitUntil(async () => !(await rendererCall("listMacroStatuses"))
    .some((status) => status.macroId === macro.id &&
      (status.state === "running" || status.state === "stopping")), {
    timeout: 20_000,
    timeoutMsg: `Macro ${macro.id} did not stop from its visible control`
  });
}

async function exerciseMacroAvailability(makePortable: boolean): Promise<void> {
  const { role, macro } = await findEntities();
  if (makePortable) {
    await makeMacroExecutionPortable(macro);
  } else {
    expectPortableMacro(macro);
  }
  await openRoleThroughVisibleUi(role);
  await runAndStopMacroThroughVisibleUi(macro);
}

async function seedPhase(): Promise<void> {
  await openSettingsThroughVisibleUi();
  await setVisiblePreferences();
  await expectPersistedPreferences();
  await leaveSettings();
  await exerciseMacroAvailability(true);
}

async function restartPhase(): Promise<void> {
  await openSettingsThroughVisibleUi();
  await expectVisiblePreferences();
  await expectPersistedPreferences();
  await leaveSettings();
  await exerciseMacroAvailability(false);
}

describe("Chromium settings persistence", () => {
  it("persists visible preferences while macro execution remains available", async () => {
    const probe = await electronDesktopE2eProbe();
    expect(probe.runtimeTarget).toBe(required("RION_STUDIO_E2E_RUNTIME_TARGET"));
    await ensureEnglishUi();
    await acceptLegalAndSkipFirstRun();

    const phase = required("RION_STUDIO_E2E_PHASE");
    if (phase === "chromium-settings-persistence-seed") await seedPhase();
    else if (phase === "chromium-settings-persistence-restart") await restartPhase();
    else throw new Error(`Unexpected Chromium settings phase ${phase}`);
  });
});
