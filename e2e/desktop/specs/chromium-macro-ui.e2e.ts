import { $, browser, expect } from "@wdio/globals";
import { Key } from "webdriverio";

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
  setEditorName,
  submitEditor,
  waitForRoute
} from "../support/ui";

// [journey:CHROMIUM-MACOS-APPKIT-MACROS-UI-017]
// [journey:CHROMIUM-WINDOWS-MACROS-UI-017]

const ROLE_NAME = "Chromium Entity Role Edited";
const SEED_MACRO_NAME = "Chromium Entity Macro Edited";
const MACRO_NAME = "Chromium Macro UI Delay";
const ROLE_FIXTURE_ID = "chromium-entity";

interface MacroMindMapFocusFrame {
  activeNodeIds: string[];
  focusedEdgeFilters: string[];
  focusedEdgeIds: string[];
  nodeFilters: string[];
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the Chromium Macro UI journey`);
  return value;
}

function platform(): "macos" | "windows" {
  const target = required("RION_STUDIO_E2E_RUNTIME_TARGET");
  if (target === "chromium-v23-macos-appkit") return "macos";
  if (target === "chromium-v23-windows") return "windows";
  throw new Error(`Unsupported Chromium Macro UI runtime target ${target}`);
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
  }, { timeout: 15_000, timeoutMsg: `Did not find Macro UI Role ${ROLE_NAME}` });
  return role as Role;
}

async function findMacro(name: string): Promise<Macro> {
  let macro: Macro | undefined;
  await browser.waitUntil(async () => {
    macro = (await rendererCall("listMacros"))
      .find((candidate) => candidate.name === name);
    return macro !== undefined;
  }, { timeout: 15_000, timeoutMsg: `Did not find Macro UI Macro ${name}` });
  return macro as Macro;
}

async function exerciseMacroMindMapFocus(): Promise<void> {
  const rootSelector = ".react-flow__node:has([data-macro-mind-map-node-kind='macroRoot'])";
  const stepSelector = ".react-flow__node:has([data-macro-mind-map-node-kind='macroStep'])";
  const settingsSelector = ".react-flow__node:has([data-macro-mind-map-node-kind='macroSettings'])";
  const rootNode = await $(rootSelector);
  const stepNode = await $(stepSelector);
  const settingsNode = await $(settingsSelector);
  await rootNode.waitForExist({ timeout: 10_000 });
  await stepNode.waitForExist({ timeout: 10_000 });
  await settingsNode.waitForExist({ timeout: 10_000 });
  const rootNodeId = await rootNode.getAttribute("data-id");
  const stepNodeId = await stepNode.getAttribute("data-id");
  const settingsNodeId = await settingsNode.getAttribute("data-id");
  if (!rootNodeId || !stepNodeId || !settingsNodeId) {
    throw new Error("Macro UI mind map focus nodes must expose data-id");
  }
  const rootCard = await rootNode.$("[data-macro-mind-map-node-kind='macroRoot']");
  const stepCard = await stepNode.$("[data-macro-mind-map-node-kind='macroStep']");
  const settingsCard = await settingsNode.$("[data-macro-mind-map-node-kind='macroSettings']");
  await rootCard.waitForClickable({ timeout: 10_000 });
  await stepCard.waitForClickable({ timeout: 10_000 });
  await settingsCard.waitForClickable({ timeout: 10_000 });

  const waitForSingleActiveNode = async (expectedNodeId: string): Promise<void> => {
    let snapshot = { activeNodeIds: [] as string[], hoveredNodeIds: [] as string[], selectedNodeIds: [] as string[] };
    try {
      await browser.waitUntil(async () => {
        snapshot = await browser.execute(() => ({
          activeNodeIds: [
            ...document.querySelectorAll<HTMLElement>(".macro-mind-map-node-active")
          ].map((node) => node.dataset.id ?? ""),
          hoveredNodeIds: [
            ...document.querySelectorAll<HTMLElement>(".react-flow__node:hover")
          ].map((node) => node.dataset.id ?? ""),
          selectedNodeIds: [
            ...document.querySelectorAll<HTMLElement>(".react-flow__node.selected")
          ].map((node) => node.dataset.id ?? "")
        }));
        return snapshot.activeNodeIds.length === 1 && snapshot.activeNodeIds[0] === expectedNodeId;
      }, {
        timeout: 10_000,
        timeoutMsg: `Macro UI mind map did not focus only ${expectedNodeId}`
      });
    } catch (error) {
      throw new Error(
        `Macro UI mind map focus mismatch for ${expectedNodeId}: ${JSON.stringify(snapshot)}`,
        { cause: error }
      );
    }
  };

  await rootCard.scrollIntoView({ block: "center", inline: "center" });
  await rootCard.click();
  await waitForSingleActiveNode(rootNodeId);
  await stepCard.click();
  await waitForSingleActiveNode(stepNodeId);
  await settingsCard.click();
  await waitForSingleActiveNode(settingsNodeId);
  await browser.waitUntil(async () => await browser.execute(() =>
    document.querySelectorAll("[class~='macro-mind-map-edge-focused']").length > 0
  ), { timeout: 10_000, timeoutMsg: "Macro UI mind map did not focus its settings edge" });

  const frames = await browser.executeAsync(
    (done: (frames: MacroMindMapFocusFrame[]) => void) => {
      const samples: MacroMindMapFocusFrame[] = [];
      const sample = (): void => {
        const map = document.querySelector<HTMLElement>("[data-macro-mind-map='inline']");
        const activeNodes = [
          ...(map?.querySelectorAll<HTMLElement>(".macro-mind-map-node-active") ?? [])
        ];
        const focusedEdges = [
          ...document.querySelectorAll<SVGGElement>("[class~='macro-mind-map-edge-focused']")
        ];
        samples.push({
          activeNodeIds: activeNodes.map((node) => node.dataset.id ?? ""),
          focusedEdgeFilters: focusedEdges.map((edge) => {
            const path = edge.querySelector<SVGPathElement>("[class~='react-flow__edge-path']");
            return path ? getComputedStyle(path).filter : "missing";
          }),
          focusedEdgeIds: focusedEdges.map((edge) => edge.dataset.id ?? ""),
          nodeFilters: [...(map?.querySelectorAll<HTMLElement>(".react-flow__node") ?? [])]
            .map((node) => getComputedStyle(node).filter)
        });
        if (samples.length === 12) {
          done(samples);
          return;
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }
  ) as MacroMindMapFocusFrame[];

  expect(frames).toHaveLength(12);
  expect(frames[0]?.focusedEdgeIds.length).toBeGreaterThan(0);
  for (const frame of frames) {
    expect(frame.activeNodeIds).toEqual([settingsNodeId]);
    expect(frame.nodeFilters.every((filter) => filter === "none")).toBe(true);
    expect(frame.focusedEdgeFilters.every((filter) => filter === "none")).toBe(true);
    expect(frame).toEqual(frames[0]);
  }
}

async function recordReservedQuickAccessShortcut(): Promise<void> {
  await $("button[aria-label='Record']").click();
  const modifier = platform() === "macos" ? Key.Command : Key.Ctrl;
  await browser.action("key")
    .down(modifier)
    .down("k")
    .up("k")
    .up(modifier)
    .perform();
  const reserved = await $("p.text-destructive");
  await reserved.waitForExist({ timeout: 10_000 });
  await expect(reserved)
    .toHaveText("Ctrl/Command+K is reserved for Rion Studio Quick Access.");
  await expect($("button=Create macro")).toBeDisabled();
  await $("button=Clear").click();
  await reserved.waitForExist({ reverse: true, timeout: 10_000 });
}

async function setPortableDelayStep(): Promise<void> {
  let step = await $("[data-macro-step-id]");
  if (!await step.isExisting()) {
    const addDelay = await $("button=Delay");
    await addDelay.waitForClickable({ timeout: 10_000 });
    await addDelay.click();
    step = await $("[data-macro-step-id]");
  }
  await step.waitForDisplayed({ timeout: 10_000 });
  const type = await step.$("button[aria-label='Step type']");
  await type.click();
  await $("[role='option']=Delay").click();
  const delay = await step.$("input[aria-label='Delay']");
  await delay.clearValue();
  await delay.setValue("60");
}

function expectPortableMacro(macro: Macro, role: Role): void {
  expect(macro.roleIds).toEqual([role.id]);
  expect(macro.trigger).toBeUndefined();
  expect(macro.steps).toEqual([
    expect.objectContaining({ ms: 60_000, type: "delay" })
  ]);
}

async function createRoleAssignedMacro(role: Role): Promise<Macro> {
  await openSection("Macros", "/macros");
  const seedMacro = await findMacro(SEED_MACRO_NAME);
  const roleGroup = await $(`[data-macro-group]:has([data-selection-id='${seedMacro.id}'])`);
  await roleGroup.waitForDisplayed({ timeout: 10_000 });
  await expect(roleGroup).toHaveText(expect.stringContaining(role.name));
  const newMacro = await roleGroup.$("button[aria-label='New macro']");
  await newMacro.waitForClickable({ timeout: 10_000 });
  await newMacro.click();
  await $("h1=New Macro").waitForDisplayed({ timeout: 10_000 });
  expect(await browser.execute((roleId) => {
    const route = new URL(window.location.hash.slice(1), "https://rion.invalid");
    return route.pathname === "/macros/new" &&
      JSON.stringify(route.searchParams.getAll("roleId")) === JSON.stringify([roleId]);
  }, role.id)).toBe(true);

  await setEditorName(MACRO_NAME);
  await $(`[aria-label='Remove ${role.name}']`).waitForDisplayed({ timeout: 10_000 });
  await recordReservedQuickAccessShortcut();
  await setPortableDelayStep();
  await exerciseMacroMindMapFocus();
  await submitEditor("/macros");

  const macro = await findMacro(MACRO_NAME);
  expectPortableMacro(macro, role);
  return macro;
}

async function chooseMacroView(label: "Flat" | "Grouped", view: "flat" | "grouped"): Promise<void> {
  await $("button[role='combobox'][aria-label='Macro view']").click();
  await $(`//*[@role="option" and normalize-space(.)="${label}"]`).click();
  await $(`[data-macro-list-view='${view}']`).waitForExist({ timeout: 10_000 });
}

async function exerciseTablesAndSelection(macro: Macro, role: Role): Promise<void> {
  await openSection("Macros", "/macros");
  await chooseMacroView("Grouped", "grouped");
  expect(await $("[data-macro-list-view='grouped'] table thead").isExisting()).toBe(true);
  const roleGroup = await $(`[data-macro-group]:has([data-selection-id='${macro.id}'])`);
  await roleGroup.waitForDisplayed({ timeout: 10_000 });
  expect(await roleGroup.getTagName()).toBe("tbody");
  expect(await roleGroup.$("tr:first-child > td").getAttribute("colspan")).toBe("5");
  await expect(roleGroup).toHaveText(expect.stringContaining(role.name));
  const selectGroup = await roleGroup.$("button=Select 2");
  await selectGroup.waitForClickable({ timeout: 10_000 });
  await selectGroup.click();
  const groupSelection = await $("[role='toolbar'][aria-label='2 selected']");
  await groupSelection.waitForDisplayed({ timeout: 10_000 });
  await groupSelection.$("button[aria-label='Clear selection']").click();
  await groupSelection.waitForExist({ reverse: true, timeout: 10_000 });

  await chooseMacroView("Flat", "flat");
  expect(await $("[data-macro-list-view='flat'] table tbody").isExisting()).toBe(true);
  const flatRow = await $(`[data-macro-list-view='flat'] [data-selection-id='${macro.id}']`);
  const modifier = platform() === "macos" ? Key.Command : Key.Ctrl;
  await browser.action("key").down(modifier).perform(true);
  try {
    await flatRow.$("td.macro-list-column-steps").click();
  } finally {
    await browser.releaseActions();
  }
  const flatSelection = await $("[role='toolbar'][aria-label='1 selected']");
  await flatSelection.waitForDisplayed({ timeout: 10_000 });
  await flatSelection.$("button[aria-label='Clear selection']").click();
  await flatSelection.waitForExist({ reverse: true, timeout: 10_000 });
  await chooseMacroView("Grouped", "grouped");
}

async function waitForRunningRole(roleId: string): Promise<RoleStatus> {
  let status: RoleStatus | undefined;
  await browser.waitUntil(async () => {
    status = (await rendererCall("listRoleStatuses"))
      .find((candidate) => candidate.roleId === roleId);
    return status?.state === "running";
  }, {
    timeout: 45_000,
    timeoutMsg: `Macro UI Role ${roleId} did not reach running`
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
  let inspection = await electronDesktopE2eRoleSessionRuntime(role.id);
  await browser.waitUntil(async () => {
    inspection = await electronDesktopE2eRoleSessionRuntime(role.id);
    return inspection.currentRuntime?.visible === true &&
      inspection.currentRuntime.hostKind === expectedHostKind();
  }, {
    timeout: 45_000,
    timeoutMsg: `Macro UI Role ${role.id} did not reach visible native ownership`
  });
  expect(inspection.roleId).toBe(role.id);
  expect(inspection.currentRuntime).toEqual(expect.objectContaining({
    hostKind: expectedHostKind(),
    visible: true
  }));
  if (platform() === "macos") {
    expect(inspection.currentRuntime?.appKitIdentity).not.toBeNull();
  } else {
    expect(inspection.currentRuntime?.appKitIdentity).toBeNull();
  }
}

async function startAndStopThroughVisibleUi(macro: Macro): Promise<void> {
  await openSection("Macros", "/macros");
  const row = await $(`[data-selection-id='${macro.id}']`);
  await row.waitForDisplayed({ timeout: 10_000 });
  const start = await row.$("button[aria-label='Start']");
  await start.waitForEnabled({ timeout: 20_000 });
  await start.click();
  await browser.waitUntil(async () => (await rendererCall("listMacroStatuses"))
    .some((status) => status.macroId === macro.id && status.state === "running"), {
    timeout: 20_000,
    timeoutMsg: `Macro UI Macro ${macro.id} did not reach running`
  });

  const stop = await row.$("button[aria-label='Stop']");
  await stop.waitForEnabled({ timeout: 20_000 });
  await stop.click();
  await browser.waitUntil(async () => !(await rendererCall("listMacroStatuses"))
    .some((status) => status.macroId === macro.id &&
      (status.state === "running" || status.state === "stopping")), {
    timeout: 20_000,
    timeoutMsg: `Macro UI Macro ${macro.id} did not stop`
  });
  await row.$("button[aria-label='Start']").waitForEnabled({ timeout: 20_000 });
}

async function seedPhase(): Promise<void> {
  const role = await findRole();
  const macro = await createRoleAssignedMacro(role);
  await exerciseTablesAndSelection(macro, role);
  await ensureRoleAvailableThroughVisibleUi(role);
  await startAndStopThroughVisibleUi(macro);
}

async function restartPhase(): Promise<void> {
  const role = await findRole();
  const macro = await findMacro(MACRO_NAME);
  expectPortableMacro(macro, role);
  await exerciseTablesAndSelection(macro, role);
  await ensureRoleAvailableThroughVisibleUi(role);
  await startAndStopThroughVisibleUi(macro);
}

describe("Chromium Macro UI exact replacement", () => {
  it("authors, inspects, selects, starts, stops, and restores a Role Macro", async () => {
    const probe = await electronDesktopE2eProbe();
    expect(probe.runtimeTarget).toBe(required("RION_STUDIO_E2E_RUNTIME_TARGET"));
    await ensureEnglishUi();
    await acceptLegalAndSkipFirstRun();

    const phase = required("RION_STUDIO_E2E_PHASE");
    if (phase === "chromium-macro-ui-seed") await seedPhase();
    else if (phase === "chromium-macro-ui-restart") await restartPhase();
    else throw new Error(`Unexpected Chromium Macro UI phase ${phase}`);
  });
});
