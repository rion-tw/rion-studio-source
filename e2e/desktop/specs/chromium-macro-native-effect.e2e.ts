import { $, $$, browser, expect } from "@wdio/globals";

import type { Macro, Role, RoleStatus } from "../../../src/shared/types";
import {
  electronDesktopE2eProbe,
  electronDesktopE2eRoleSessionRuntime
} from "../support/electron-driver";
import {
  fixtureCursor,
  fixtureEvents,
  type FixtureEvent,
  waitFixtureEvent
} from "../support/fixture";
import { rendererCall } from "../support/renderer-bridge";
import {
  acceptLegalAndSkipFirstRun,
  ensureEnglishUi,
  setEditorName,
  setNumericInputValue,
  submitEditor,
  waitForRoute
} from "../support/ui";

// [journey:CHROMIUM-MACOS-APPKIT-MACRO-NATIVE-EFFECT-018]
// [journey:CHROMIUM-WINDOWS-MACRO-NATIVE-EFFECT-018]

const ROLE_NAME = "Chromium Entity Role Edited";
const SEED_MACRO_NAME = "Chromium Entity Macro Edited";
const MACRO_NAME = "Chromium Native Effect Macro";
const ROLE_FIXTURE_ID = "chromium-entity";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the Chromium native-effect journey`);
  return value;
}

function platform(): "macos" | "windows" {
  const target = required("RION_STUDIO_E2E_RUNTIME_TARGET");
  if (target === "chromium-v23-macos-appkit") return "macos";
  if (target === "chromium-v23-windows") return "windows";
  throw new Error(`Unsupported Chromium native-effect runtime target ${target}`);
}

function expectedHostKind(): "appkit-chromium" | "bundled-chromium" {
  return platform() === "macos" ? "appkit-chromium" : "bundled-chromium";
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
  }, { timeout: 15_000, timeoutMsg: `Did not find native-effect Role ${ROLE_NAME}` });
  return role as Role;
}

async function findMacro(name: string): Promise<Macro> {
  let macro: Macro | undefined;
  await browser.waitUntil(async () => {
    macro = (await rendererCall("listMacros"))
      .find((candidate) => candidate.name === name);
    return macro !== undefined;
  }, { timeout: 15_000, timeoutMsg: `Did not find native-effect Macro ${name}` });
  return macro as Macro;
}

async function selectOption(
  stepIndex: number,
  ariaLabel: string,
  option: string
): Promise<void> {
  const steps = await $$("[data-macro-step-id]");
  const step = steps[stepIndex];
  if (!step) throw new Error(`Macro step ${stepIndex} is missing`);
  await step.$(`button[aria-label='${ariaLabel}']`).click();
  await $(`//*[@role="option" and normalize-space(.)="${option}"]`).click();
}

async function addStep(label: "Click" | "Delay" | "Key"): Promise<void> {
  const add = await $(`//button[normalize-space(.)="${label}" and not(ancestor::*[@data-macro-step-id])]`);
  await add.waitForClickable({ timeout: 10_000 });
  await add.click();
}

async function createNativeEffectMacro(role: Role): Promise<Macro> {
  await openSection("Macros", "/macros");
  const seedMacro = await findMacro(SEED_MACRO_NAME);
  const roleGroup = await $(`[data-macro-group]:has([data-selection-id='${seedMacro.id}'])`);
  await roleGroup.waitForDisplayed({ timeout: 10_000 });
  await roleGroup.$("button[aria-label='New macro']").click();
  await $("h1=New Macro").waitForDisplayed({ timeout: 10_000 });
  await setEditorName(MACRO_NAME);
  await $(`[aria-label='Remove ${role.name}']`).waitForDisplayed({ timeout: 10_000 });

  await addStep("Key");
  await selectOption(0, "Key", "A");
  for (let index = 0; index < 3; index += 1) {
    await addStep("Click");
  }
  await selectOption(2, "Mouse button", "Middle click");
  await selectOption(3, "Mouse button", "Right click");
  await addStep("Delay");
  const steps = await $$("[data-macro-step-id]");
  expect(steps).toHaveLength(5);
  const delay = await steps[4]!.$("input[aria-label='Delay']");
  await setNumericInputValue(delay, "60");
  await submitEditor("/macros");

  const macro = await findMacro(MACRO_NAME);
  expect(macro.roleIds).toEqual([role.id]);
  expect(macro.steps.at(-1)).toMatchObject({ type: "delay", ms: 60_000 });
  expect(macro.steps.map((step) => step.type)).toEqual([
    "key", "click", "click", "click", "delay"
  ]);
  return macro;
}

async function waitForRunningRole(roleId: string): Promise<RoleStatus> {
  let status: RoleStatus | undefined;
  await browser.waitUntil(async () => {
    status = (await rendererCall("listRoleStatuses"))
      .find((candidate) => candidate.roleId === roleId);
    return status?.state === "running";
  }, {
    timeout: 45_000,
    timeoutMsg: `Native-effect Role ${roleId} did not reach running`
  });
  return status as RoleStatus;
}

async function ensureRoleAvailableThroughVisibleUi(role: Role): Promise<void> {
  await openSection("Roles", "/roles");
  const card = await $(`[data-selection-id='${role.id}']`);
  await card.waitForDisplayed({ timeout: 10_000 });
  await card.scrollIntoView({ block: "center", inline: "center" });
  await card.moveTo();
  const alreadyRunning = (await rendererCall("listRoleStatuses"))
    .some((status) => status.roleId === role.id && status.state === "running");
  if (!alreadyRunning) {
    const afterSequence = await fixtureCursor();
    const open = await card.$("button[aria-label='Open']");
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
}

async function expectFocusedRoleRuntime(role: Role): Promise<void> {
  const inspection = await electronDesktopE2eRoleSessionRuntime(role.id);
  expect(inspection.currentRuntime).toEqual(expect.objectContaining({
    focused: true,
    hostKind: expectedHostKind(),
    visible: true
  }));
  if (platform() === "macos") {
    expect(inspection.currentRuntime?.appKitIdentity).not.toBeNull();
  } else {
    expect(inspection.currentRuntime?.appKitIdentity).toBeNull();
  }
}

function expectTrustedEvent(
  event: FixtureEvent,
  expected: Readonly<Partial<FixtureEvent>>
): void {
  expect(event).toEqual(expect.objectContaining({
    isTrusted: true,
    roleId: ROLE_FIXTURE_ID,
    ...expected
  }));
}

async function waitForExactNativeEffects(
  afterSequence: number
): Promise<void> {
  const semanticEvents = Promise.all([
    waitFixtureEvent({ afterSequence, kind: "click", roleId: ROLE_FIXTURE_ID }),
    waitFixtureEvent({ afterSequence, kind: "auxclick", roleId: ROLE_FIXTURE_ID }),
    waitFixtureEvent({ afterSequence, kind: "contextmenu", roleId: ROLE_FIXTURE_ID })
  ]);
  const keyDown = await waitFixtureEvent({
    afterSequence,
    kind: "keydown",
    roleId: ROLE_FIXTURE_ID
  });
  expectTrustedEvent(keyDown, { code: "KeyA", key: "a" });
  const keyUp = await waitFixtureEvent({
    afterSequence: keyDown.sequence,
    kind: "keyup",
    roleId: ROLE_FIXTURE_ID
  });
  expectTrustedEvent(keyUp, { code: "KeyA", key: "a" });

  const leftUp = await waitFixtureEvent({
    afterSequence: keyUp.sequence,
    kind: "mouseup",
    roleId: ROLE_FIXTURE_ID
  });
  const middleUp = await waitFixtureEvent({
    afterSequence: leftUp.sequence,
    kind: "mouseup",
    roleId: ROLE_FIXTURE_ID
  });
  await waitFixtureEvent({
    afterSequence: middleUp.sequence,
    kind: "mouseup",
    roleId: ROLE_FIXTURE_ID
  });
  const [leftClick, middleAuxClick, contextMenu] = await semanticEvents;
  expectTrustedEvent(leftClick, { button: 0, buttons: 0, targetId: "qa-target" });
  expectTrustedEvent(middleAuxClick, {
    button: 1,
    buttons: 0,
    targetId: "qa-target"
  });
  expectTrustedEvent(contextMenu, {
    button: 2,
    buttons: 2,
    targetId: "qa-target"
  });

  const transitions = (await fixtureEvents({
    afterSequence,
    roleId: ROLE_FIXTURE_ID
  })).filter((event) => [
    "keydown", "keyup", "mousedown", "mouseup"
  ].includes(event.kind));
  expect(transitions.map((event) => ({
    button: event.button,
    buttons: event.buttons,
    code: event.code,
    isTrusted: event.isTrusted,
    kind: event.kind,
    targetId: event.kind === "mousedown" || event.kind === "mouseup"
      ? event.targetId
      : undefined
  }))).toEqual([
    { button: undefined, buttons: undefined, code: "KeyA", isTrusted: true,
      kind: "keydown", targetId: undefined },
    { button: undefined, buttons: undefined, code: "KeyA", isTrusted: true,
      kind: "keyup", targetId: undefined },
    { button: 0, buttons: 1, code: undefined, isTrusted: true,
      kind: "mousedown", targetId: "qa-target" },
    { button: 0, buttons: 0, code: undefined, isTrusted: true,
      kind: "mouseup", targetId: "qa-target" },
    { button: 1, buttons: 4, code: undefined, isTrusted: true,
      kind: "mousedown", targetId: "qa-target" },
    { button: 1, buttons: 0, code: undefined, isTrusted: true,
      kind: "mouseup", targetId: "qa-target" },
    { button: 2, buttons: 2, code: undefined, isTrusted: true,
      kind: "mousedown", targetId: "qa-target" },
    { button: 2, buttons: 0, code: undefined, isTrusted: true,
      kind: "mouseup", targetId: "qa-target" }
  ]);
}

async function startObserveAndStopThroughVisibleUi(macro: Macro, role: Role): Promise<void> {
  await openSection("Macros", "/macros");
  const row = await $(`[data-selection-id='${macro.id}']`);
  await row.waitForDisplayed({ timeout: 10_000 });
  const afterSequence = await fixtureCursor();
  const start = await row.$("button[aria-label='Start']");
  await start.waitForEnabled({ timeout: 20_000 });
  await start.click();
  await waitForExactNativeEffects(afterSequence);
  await expectFocusedRoleRuntime(role);
  await browser.waitUntil(async () => (await rendererCall("listMacroStatuses"))
    .some((status) => status.macroId === macro.id && status.state === "running"), {
    timeout: 20_000,
    timeoutMsg: `Native-effect Macro ${macro.id} did not remain running for visible Stop`
  });

  const stop = await row.$("button[aria-label='Stop']");
  await stop.waitForEnabled({ timeout: 20_000 });
  await stop.click();
  await browser.waitUntil(async () => !(await rendererCall("listMacroStatuses"))
    .some((status) => status.macroId === macro.id &&
      (status.state === "running" || status.state === "stopping" ||
        status.state === "recovering")), {
    timeout: 20_000,
    timeoutMsg: `Native-effect Macro ${macro.id} did not terminalize after visible Stop`
  });
  await row.$("button[aria-label='Start']").waitForEnabled({ timeout: 20_000 });
}

describe("Chromium Macro native-effect exact replacement", () => {
  it("delivers trusted foreground key and three-button effects from visible controls", async () => {
    const probe = await electronDesktopE2eProbe();
    expect(probe.runtimeTarget).toBe(required("RION_STUDIO_E2E_RUNTIME_TARGET"));
    expect(required("RION_STUDIO_E2E_PHASE")).toBe("chromium-macro-native-effect");
    await ensureEnglishUi();
    await acceptLegalAndSkipFirstRun();
    const role = await findRole();
    const macro = await createNativeEffectMacro(role);
    await ensureRoleAvailableThroughVisibleUi(role);
    await startObserveAndStopThroughVisibleUi(macro, role);
  });
});
