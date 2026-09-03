import { $, browser, expect } from "@wdio/globals";

import type {
  EmbeddedRuntimeTabSummary,
  Game,
  LaunchWorkspace,
  Role
} from "../../../src/shared/types";
import { electronDesktopE2eProbe } from "./electron-driver";
import { closeVisibleRuntimeTab } from "./native-runtime-tabs";
import { rendererCall } from "./renderer-bridge";
import {
  acceptLegalAndSkipFirstRun,
  clickEntityMenuAction,
  clickWorkspaceCreateAction,
  ensureEnglishUi,
  setEditorName,
  submitEditor,
  waitForRoute
} from "./ui";

export function requiredCutoverEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the Workspace cutover journey`);
  return value;
}

export function cutoverFixtureUrl(fixtureId: string): string {
  return new URL(
    `/role/${fixtureId}`,
    requiredCutoverEnvironment("RION_STUDIO_E2E_FIXTURE_ORIGIN")
  ).href;
}

export async function openCutoverSection(label: string, route: string): Promise<void> {
  const sidebar = await $(".app-main-sidebar");
  await sidebar.waitForDisplayed({ timeout: 20_000 });
  const button = await sidebar.$(`button*=${label}`);
  await button.waitForClickable({ timeout: 10_000 });
  await button.click();
  await waitForRoute(route);
}

export async function prepareWorkspaceCutover(): Promise<Readonly<{
  mainWindowHandle: string;
  platform: "macos" | "windows";
}>> {
  const probe = await electronDesktopE2eProbe();
  expect(probe.runtimeTarget).toBe(requiredCutoverEnvironment(
    "RION_STUDIO_E2E_RUNTIME_TARGET"
  ));
  await ensureEnglishUi();
  await acceptLegalAndSkipFirstRun();
  return Object.freeze({
    mainWindowHandle: await browser.getWindowHandle(),
    platform: probe.platform
  });
}

async function findNamed<Entity extends { name: string }>(
  read: () => Promise<Entity[]>,
  name: string
): Promise<Entity> {
  let entity: Entity | undefined;
  await browser.waitUntil(async () => {
    entity = (await read()).find((candidate) => candidate.name === name);
    return entity !== undefined;
  }, { timeout: 15_000, timeoutMsg: `Cutover entity ${name} is unavailable` });
  return entity!;
}

export function findCutoverGame(name: string): Promise<Game> {
  return findNamed(() => rendererCall("listGames"), name);
}

export function findCutoverRole(name: string): Promise<Role> {
  return findNamed(() => rendererCall("listRoles"), name);
}

export function findCutoverWorkspace(name: string): Promise<LaunchWorkspace> {
  return findNamed(() => rendererCall("listLaunchWorkspaces"), name);
}

export async function createCutoverGame(
  name: string,
  defaultLaunchUrl: string
): Promise<Game> {
  await openCutoverSection("Games", "/games");
  await $("button=New game").click();
  await waitForRoute("/games/new");
  await setEditorName(name);
  await $("#game-launch-url").setValue(defaultLaunchUrl);
  await submitEditor("/games");
  return findCutoverGame(name);
}

export async function createCutoverRole(
  game: Game,
  name: string,
  launchUrl: string
): Promise<Role> {
  await openCutoverSection("Games", "/games");
  await clickEntityMenuAction(game.id, "Game actions", "Add role");
  await waitForRoute(`/roles/new?gameId=${game.id}`);
  await setEditorName(name);
  await $("#role-launch-url").setValue(launchUrl);
  await submitEditor("/roles");
  return findCutoverRole(name);
}

export async function createCutoverRoleWorkspace(
  name: string,
  roles: readonly [Role, Role]
): Promise<LaunchWorkspace> {
  await openCutoverSection("Workspaces", "/workspaces");
  await clickWorkspaceCreateAction();
  await waitForRoute("/workspaces/new");
  await setEditorName(name);
  for (const [index, role] of roles.entries()) {
    if (index > 0) await $(`[data-workspace-slot-index='${index}']`).click();
    await $("#workspace-slot-content").click();
    await $("[role='option']=Role").click();
    const option = await $(`[data-workspace-role-id='${role.id}']`);
    await option.waitForClickable({ timeout: 10_000 });
    await option.click();
  }
  await submitEditor("/workspaces");
  const workspace = await findCutoverWorkspace(name);
  expect(workspace.slots.map((slot) => slot.roleId)).toEqual(
    roles.map((role) => role.id)
  );
  return workspace;
}

export async function openCutoverWorkspace(
  workspace: LaunchWorkspace,
  destination: "default" | "new-window" = "default"
): Promise<void> {
  if (destination === "default") {
    await openCutoverSection("Workspaces", "/workspaces");
    const card = await $(`[data-selection-id='${workspace.id}']`);
    await card.waitForDisplayed({ timeout: 10_000 });
    await card.scrollIntoView({ block: "center", inline: "center" });
    await card.moveTo();
    const open = await card.$("button[aria-label='Open workspace']");
    await open.waitForDisplayed({ timeout: 10_000 });
    await open.waitForClickable({ timeout: 10_000 });
    await open.click();
    return;
  }
  await openCutoverSection("Home", "/dashboard");
  await $("[data-testid='quick-access-trigger']").click();
  const palette = await $("[data-testid='quick-access-palette'][open]");
  await palette.waitForDisplayed({ timeout: 10_000 });
  await palette.$("input[role='combobox']").setValue(workspace.name);
  const option = await $(`#quick-access-option-workspace-${workspace.id}`);
  await option.waitForDisplayed({ timeout: 10_000 });
  const openIn = await $(
    `[data-testid='quick-access-destination-workspace-${workspace.id}']`
  );
  await openIn.waitForClickable({ timeout: 10_000 });
  await openIn.click();
  const target = await $("[data-testid='quick-access-destination-option-new-window']");
  await target.waitForClickable({ timeout: 10_000 });
  await target.click();
}

export async function waitCutoverWorkspaceTab(
  workspace: LaunchWorkspace,
  expected: readonly Readonly<{
    roleId: string;
    state: "blocked" | "running";
  }>[]
): Promise<EmbeddedRuntimeTabSummary> {
  let tab: EmbeddedRuntimeTabSummary | undefined;
  await browser.waitUntil(async () => {
    tab = (await rendererCall("getEmbeddedRuntimeState")).tabs.find(
      (candidate) => candidate.type === "workspace" &&
        candidate.sourceId === workspace.id
    );
    return tab !== undefined && expected.every(({ roleId, state }) =>
      tab!.slots.some((slot) => slot.roleId === roleId && slot.state === state)
    );
  }, {
    interval: 100,
    timeout: 45_000,
    timeoutMsg: `Workspace ${workspace.name} did not reach exact Role-slot ownership`
  });
  return tab!;
}

export async function stopCutoverWindow(input: Readonly<{
  mainWindowHandle: string;
  platform: "macos" | "windows";
  tab: EmbeddedRuntimeTabSummary;
}>): Promise<void> {
  await closeVisibleRuntimeTab({
    mainWindowHandle: input.mainWindowHandle,
    platform: input.platform,
    tabId: input.tab.id,
    tabName: input.tab.name,
    windowId: input.tab.windowId
  });
  await browser.waitUntil(async () => !(await rendererCall(
    "getEmbeddedRuntimeState"
  )).windows.some((window) => window.id === input.tab.windowId), {
    timeout: 45_000,
    timeoutMsg: `Visible stop did not retire runtime window ${input.tab.windowId}`
  });
}
