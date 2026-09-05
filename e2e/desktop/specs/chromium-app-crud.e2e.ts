import { $, browser, expect } from "@wdio/globals";
import { Key } from "webdriverio";

import type { Game, LaunchWorkspace, Macro, Role } from "../../../src/shared/types";
import { electronDesktopE2eProbe } from "../support/electron-driver";
import { rendererCall } from "../support/renderer-bridge";
import {
  clickWorkspaceCreateAction,
  acceptLegalAndSkipFirstRun,
  clickConfirmation,
  ensureEnglishUi,
  setEditorName,
  submitEditor,
  waitForRoute
} from "../support/ui";

// [journey:CHROMIUM-MACOS-APPKIT-FULL-CRUD-010]
// [journey:CHROMIUM-WINDOWS-FULL-CRUD-010]
// [journey:CHROMIUM-MACOS-APPKIT-CRUD-REORDER-011]
// [journey:CHROMIUM-WINDOWS-CRUD-REORDER-011]

const PRIMARY_GAME_NAME = "Chromium Entity Game";
const PRIMARY_ROLE_NAME = "Chromium Entity Role Edited";
const EDITED_ROLE_NAME = "Chromium P1 Role Edited";
const COPIED_ROLE_NAME = `${EDITED_ROLE_NAME} Copy`;
const RECOVERY_ROLE_NAME = "Chromium P1 Recovery Role";
const PRIMARY_WORKSPACE_NAME = "Chromium Entity Workspace Edited";
const EDITED_WORKSPACE_NAME = "Chromium P1 Workspace Edited";
const COPIED_WORKSPACE_NAME = `${EDITED_WORKSPACE_NAME} Copy`;
const RECOVERY_WORKSPACE_NAME = "Chromium P1 Recovery Workspace";
const PRIMARY_MACRO_NAME = "Chromium Entity Macro Edited";
const EDITED_MACRO_NAME = "Chromium P1 Macro Edited";
const COPIED_MACRO_NAME = `${EDITED_MACRO_NAME} Copy`;
const UNUSED_GAME_NAME = "Chromium P1 Unused Game";
const RECOVERY_GAME_NAME = "Chromium P1 Recovery Game";
const RECOVERY_FIXTURE_ID = "chromium-p1-recovery-role";
const CRUD_GAME_NAMES = [PRIMARY_GAME_NAME, UNUSED_GAME_NAME, RECOVERY_GAME_NAME];

const ROLE_ORDER = [COPIED_ROLE_NAME, EDITED_ROLE_NAME, RECOVERY_ROLE_NAME];
const WORKSPACE_ORDER = [
  COPIED_WORKSPACE_NAME,
  EDITED_WORKSPACE_NAME,
  RECOVERY_WORKSPACE_NAME
];
const CRUD_ROLE_NAMES = [PRIMARY_ROLE_NAME, ...ROLE_ORDER];
const CRUD_WORKSPACE_NAMES = [PRIMARY_WORKSPACE_NAME, ...WORKSPACE_ORDER];
const CRUD_MACRO_NAMES = [
  PRIMARY_MACRO_NAME,
  EDITED_MACRO_NAME,
  COPIED_MACRO_NAME
];

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the Chromium app CRUD journey`);
  return value;
}

function requireNamed<T extends { name: string }>(items: readonly T[], name: string): T {
  const item = items.find((candidate) => candidate.name === name);
  if (!item) throw new Error(`Required Chromium app CRUD entity ${name} is unavailable`);
  return item;
}

async function waitForNamed<T extends { name: string }>(
  read: () => Promise<readonly T[]>,
  name: string
): Promise<T> {
  let item: T | undefined;
  await browser.waitUntil(async () => {
    item = (await read()).find((candidate) => candidate.name === name);
    return item !== undefined;
  }, {
    timeout: 15_000,
    timeoutMsg: `Chromium app CRUD journey did not observe ${name}`
  });
  return item as T;
}

async function waitForNamesAbsent<T extends { name: string }>(
  read: () => Promise<readonly T[]>,
  names: readonly string[]
): Promise<void> {
  await browser.waitUntil(async () => {
    const items = await read();
    return names.every((name) => !items.some((item) => item.name === name));
  }, {
    timeout: 15_000,
    timeoutMsg: `Chromium app CRUD entities remained after visible deletion: ${names.join(", ")}`
  });
}

async function openSection(label: string, route: string): Promise<void> {
  const sidebar = await $(".app-main-sidebar");
  await sidebar.waitForDisplayed({ timeout: 20_000 });
  const button = await sidebar.$(`button*=${label}`);
  await button.waitForClickable({ timeout: 10_000 });
  await button.click();
  await waitForRoute(route);
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
  let trigger;
  for (const label of triggerLabels) {
    const candidate = await entity.$(`button[aria-label='${label}']`);
    if (await candidate.isExisting()) {
      trigger = candidate;
      break;
    }
  }
  if (!trigger) throw new Error(`Entity ${entityId} has no visible action trigger`);
  await trigger.waitForClickable({ timeout: 10_000 });
  await trigger.click();
  const menu = await $("[role='menu']");
  await menu.waitForDisplayed({ timeout: 10_000 });
  const action = await menu.$(`.//*[@role='menuitem' and normalize-space(.)='${actionLabel}']`);
  await action.waitForClickable({ timeout: 10_000 });
  await action.click();
}

async function editNamedEntity(
  section: string,
  route: "macros" | "roles" | "workspaces",
  entityId: string,
  triggerLabels: readonly string[],
  nextName: string
): Promise<void> {
  await openSection(section, `/${route}`);
  await clickEntityMenuAction(entityId, triggerLabels, "Edit");
  await waitForRoute(`/${route}/${entityId}/edit`);
  await setEditorName(nextName);
  await submitEditor(`/${route}`);
}

async function createGame(name: string, fixtureId: string): Promise<Game> {
  await openSection("Games", "/games");
  await $("button=New game").click();
  await waitForRoute("/games/new");
  await setEditorName(name);
  await $("#game-launch-url").setValue(
    `${required("RION_STUDIO_E2E_FIXTURE_ORIGIN")}/role/${fixtureId}`
  );
  await submitEditor("/games");
  return waitForNamed(() => rendererCall("listGames"), name);
}

async function createRole(name: string, game: Game): Promise<Role> {
  await openSection("Games", "/games");
  await clickEntityMenuAction(game.id, ["Game actions"], "Add role");
  await waitForRoute(`/roles/new?gameId=${game.id}`);
  await setEditorName(name);
  await submitEditor("/roles");
  return waitForNamed(() => rendererCall("listRoles"), name);
}

async function duplicateRole(role: Role): Promise<Role> {
  await openSection("Roles", "/roles");
  await clickEntityMenuAction(
    role.id,
    ["Role actions", "Click for actions or drag to reorder"],
    "Duplicate"
  );
  return waitForNamed(() => rendererCall("listRoles"), COPIED_ROLE_NAME);
}

async function createRecoveryWorkspace(
  primaryRole: Role,
  recoveryRole: Role
): Promise<LaunchWorkspace> {
  await openSection("Workspaces", "/workspaces");
  await clickWorkspaceCreateAction();
  await waitForRoute("/workspaces/new");
  await setEditorName(RECOVERY_WORKSPACE_NAME);
  await $("#workspace-layout").click();
  await $("[data-workspace-layout-option='two_columns']").click();
  await $("#workspace-slot-content").click();
  await $("[role='option']=Role").click();
  await $(`[data-workspace-role-id='${primaryRole.id}']`).click();
  await $("[data-workspace-slot-index='1']").click();
  await $("#workspace-slot-content").click();
  await $("[role='option']=Role").click();
  await $(`[data-workspace-role-id='${recoveryRole.id}']`).click();
  await submitEditor("/workspaces");
  const workspace = await waitForNamed(
    () => rendererCall("listLaunchWorkspaces"),
    RECOVERY_WORKSPACE_NAME
  );
  expect(workspace.template).toBe("two_columns");
  expect(workspace.slots.filter((slot) => slot.roleId).map((slot) => slot.roleId))
    .toEqual([primaryRole.id, recoveryRole.id]);
  return workspace;
}

async function duplicateWorkspace(workspace: LaunchWorkspace): Promise<LaunchWorkspace> {
  await openSection("Workspaces", "/workspaces");
  await clickEntityMenuAction(
    workspace.id,
    ["Workspace actions", "Click for actions or drag to reorder"],
    "Duplicate"
  );
  return waitForNamed(() => rendererCall("listLaunchWorkspaces"), COPIED_WORKSPACE_NAME);
}

async function duplicateMacro(macro: Macro): Promise<Macro> {
  await openSection("Macros", "/macros");
  await clickEntityMenuAction(macro.id, ["Macro actions"], "Duplicate");
  return waitForNamed(() => rendererCall("listMacros"), COPIED_MACRO_NAME);
}

async function dragEntityToThroughVisiblePointer(
  sourceId: string,
  targetId: string,
  handleLabel: string
): Promise<void> {
  const source = await $(`[data-selection-id='${sourceId}']`);
  const target = await $(`[data-selection-id='${targetId}']`);
  await source.waitForDisplayed({ timeout: 10_000 });
  await target.waitForDisplayed({ timeout: 10_000 });
  await source.scrollIntoView({ block: "center" });
  await source.moveTo();
  const handle = await source.$(`button[aria-label='${handleLabel}']`);
  await handle.waitForDisplayed({ timeout: 10_000 });
  const targetX = await target.getLocation("x") + (await target.getSize("width")) / 2;
  await browser.action("pointer", { parameters: { pointerType: "mouse" } })
    .move({ duration: 250, origin: handle })
    .pause(200)
    .down("left")
    .move({ duration: 700, origin: "viewport", x: Math.round(targetX), y: 8 })
    .pause(1_600)
    .move({ duration: 700, origin: target })
    .pause(200)
    .up("left")
    .perform();
}

async function waitForOrder<T extends { name: string }>(
  read: () => Promise<readonly T[]>,
  expectedNames: readonly string[]
): Promise<void> {
  await browser.waitUntil(async () => {
    const names = (await read())
      .filter((item) => expectedNames.includes(item.name))
      .map((item) => item.name);
    return JSON.stringify(names) === JSON.stringify(expectedNames);
  }, {
    timeout: 15_000,
    timeoutMsg: `Visible pointer reorder did not persist ${expectedNames.join(" -> ")}`
  });
}

async function selectEntityItemsThroughVisibleUi(entityIds: readonly string[]): Promise<void> {
  if (entityIds.length === 0) throw new Error("Visible multi-select requires at least one entity");
  const modifier = required("RION_STUDIO_E2E_RUNTIME_TARGET") ===
      "chromium-v23-macos-appkit"
    ? Key.Command
    : Key.Ctrl;
  await browser.action("key").down(modifier).perform(true);
  try {
    for (const entityId of entityIds) {
      const entity = await $(`[data-selection-id='${entityId}']`);
      await entity.waitForDisplayed({ timeout: 10_000 });
      await entity.click();
    }
  } finally {
    await browser.releaseActions();
  }
  await $(`[role='toolbar'][aria-label='${entityIds.length} selected']`)
    .waitForDisplayed({ timeout: 10_000 });
}

async function confirmBulkDelete<T extends { name: string }>(
  section: string,
  route: string,
  ids: readonly string[],
  read: () => Promise<readonly T[]>,
  absentNames: readonly string[]
): Promise<void> {
  await openSection(section, route);
  await selectEntityItemsThroughVisibleUi(ids);
  await $(`button=Delete ${ids.length}`).click();
  await clickConfirmation("Delete");
  await waitForNamesAbsent(read, absentNames);
}

async function preparePhase(): Promise<void> {
  const target = required("RION_STUDIO_E2E_RUNTIME_TARGET");
  const probe = await electronDesktopE2eProbe();
  expect(probe.runtimeTarget).toBe(target);
  expect(probe.platform).toBe(
    target === "chromium-v23-macos-appkit" ? "macos" : "windows"
  );
  await ensureEnglishUi();
  await acceptLegalAndSkipFirstRun();
}

async function mutationPhase(): Promise<void> {
  await preparePhase();
  const primaryGame = requireNamed(await rendererCall("listGames"), PRIMARY_GAME_NAME);
  const primaryRole = requireNamed(await rendererCall("listRoles"), PRIMARY_ROLE_NAME);
  const primaryWorkspace = requireNamed(
    await rendererCall("listLaunchWorkspaces"),
    PRIMARY_WORKSPACE_NAME
  );
  const primaryMacro = requireNamed(await rendererCall("listMacros"), PRIMARY_MACRO_NAME);

  await editNamedEntity(
    "Roles",
    "roles",
    primaryRole.id,
    ["Role actions", "Click for actions or drag to reorder"],
    EDITED_ROLE_NAME
  );
  const editedRole = await waitForNamed(() => rendererCall("listRoles"), EDITED_ROLE_NAME);
  await editNamedEntity(
    "Workspaces",
    "workspaces",
    primaryWorkspace.id,
    ["Workspace actions", "Click for actions or drag to reorder"],
    EDITED_WORKSPACE_NAME
  );
  const editedWorkspace = await waitForNamed(
    () => rendererCall("listLaunchWorkspaces"),
    EDITED_WORKSPACE_NAME
  );
  await editNamedEntity(
    "Macros",
    "macros",
    primaryMacro.id,
    ["Macro actions"],
    EDITED_MACRO_NAME
  );
  const editedMacro = await waitForNamed(() => rendererCall("listMacros"), EDITED_MACRO_NAME);

  await createGame(UNUSED_GAME_NAME, "chromium-p1-unused-role");
  const recoveryGame = await createGame(RECOVERY_GAME_NAME, RECOVERY_FIXTURE_ID);
  const recoveryRole = await createRole(RECOVERY_ROLE_NAME, recoveryGame);
  const copiedRole = await duplicateRole(editedRole);
  const recoveryWorkspace = await createRecoveryWorkspace(editedRole, recoveryRole);
  const copiedWorkspace = await duplicateWorkspace(editedWorkspace);
  const copiedMacro = await duplicateMacro(editedMacro);

  await openSection("Roles", "/roles");
  await dragEntityToThroughVisiblePointer(
    copiedRole.id,
    editedRole.id,
    "Click for actions or drag to reorder"
  );
  await waitForOrder(() => rendererCall("listRoles"), ROLE_ORDER);
  await openSection("Workspaces", "/workspaces");
  await dragEntityToThroughVisiblePointer(
    copiedWorkspace.id,
    editedWorkspace.id,
    "Click for actions or drag to reorder"
  );
  await waitForOrder(() => rendererCall("listLaunchWorkspaces"), WORKSPACE_ORDER);

  expect(primaryGame.defaultLaunchUrl).toContain("chromium-entity");
  expect(recoveryWorkspace.template).toBe("two_columns");
  expect(copiedMacro.roleIds).toEqual(editedMacro.roleIds);
}

async function cleanupPhase(): Promise<void> {
  await preparePhase();
  const macros = await rendererCall("listMacros");
  const macroIds = [EDITED_MACRO_NAME, COPIED_MACRO_NAME]
    .map((name) => requireNamed(macros, name).id);
  await openSection("Macros", "/macros");
  await selectEntityItemsThroughVisibleUi(macroIds);
  await $("button=Delete 2").click();
  await clickConfirmation("Cancel");
  expect((await rendererCall("listMacros")).filter((macro) => macroIds.includes(macro.id)))
    .toHaveLength(2);
  await $("button=Delete 2").click();
  await clickConfirmation("Delete");
  await waitForNamesAbsent(
    () => rendererCall("listMacros"),
    [EDITED_MACRO_NAME, COPIED_MACRO_NAME]
  );

  const games = await rendererCall("listGames");
  const primaryGame = requireNamed(games, PRIMARY_GAME_NAME);
  const recoveryGame = requireNamed(games, RECOVERY_GAME_NAME);
  const unusedGame = requireNamed(games, UNUSED_GAME_NAME);
  await openSection("Games", "/games");
  await selectEntityItemsThroughVisibleUi([primaryGame.id, recoveryGame.id, unusedGame.id]);
  await $("button=Delete 3").click();
  await clickConfirmation("Delete");
  await waitForNamesAbsent(() => rendererCall("listGames"), [UNUSED_GAME_NAME]);
  const retainedGames = await rendererCall("listGames");
  expect(retainedGames.map((game) => game.id)).toEqual(
    expect.arrayContaining([primaryGame.id, recoveryGame.id])
  );
  const partialNotice = await $("[role='status']");
  await expect(partialNotice).toHaveText(expect.stringContaining("Deleted 1; skipped 2."));
  await expect(partialNotice).toHaveText(expect.stringContaining("2 in use"));

  const workspaces = await rendererCall("listLaunchWorkspaces");
  await confirmBulkDelete(
    "Workspaces",
    "/workspaces",
    WORKSPACE_ORDER.map((name) => requireNamed(workspaces, name).id),
    () => rendererCall("listLaunchWorkspaces"),
    WORKSPACE_ORDER
  );
  const roles = await rendererCall("listRoles");
  await confirmBulkDelete(
    "Roles",
    "/roles",
    ROLE_ORDER.map((name) => requireNamed(roles, name).id),
    () => rendererCall("listRoles"),
    ROLE_ORDER
  );
  const gamesAfterDependencies = await rendererCall("listGames");
  await confirmBulkDelete(
    "Games",
    "/games",
    [PRIMARY_GAME_NAME, RECOVERY_GAME_NAME]
      .map((name) => requireNamed(gamesAfterDependencies, name).id),
    () => rendererCall("listGames"),
    [PRIMARY_GAME_NAME, RECOVERY_GAME_NAME]
  );

  const snapshot = await rendererCall("getAppSnapshot");
  expect(snapshot.games.some((game) => CRUD_GAME_NAMES.includes(game.name))).toBe(false);
  expect(snapshot.roles.some((role) => CRUD_ROLE_NAMES.includes(role.name))).toBe(false);
  expect(snapshot.launchWorkspaces.some((workspace) =>
    CRUD_WORKSPACE_NAMES.includes(workspace.name)
  )).toBe(false);
  expect(snapshot.macros.some((macro) => CRUD_MACRO_NAMES.includes(macro.name))).toBe(false);
}

async function finalRestartPhase(): Promise<void> {
  await preparePhase();
  const snapshot = await rendererCall("getAppSnapshot");
  expect(snapshot.games.some((game) => CRUD_GAME_NAMES.includes(game.name))).toBe(false);
  expect(snapshot.roles.some((role) => CRUD_ROLE_NAMES.includes(role.name))).toBe(false);
  expect(snapshot.launchWorkspaces.some((workspace) =>
    CRUD_WORKSPACE_NAMES.includes(workspace.name)
  )).toBe(false);
  expect(snapshot.macros.some((macro) => CRUD_MACRO_NAMES.includes(macro.name))).toBe(false);

  for (const [label, route, names] of [
    ["Games", "/games", CRUD_GAME_NAMES],
    ["Roles", "/roles", CRUD_ROLE_NAMES],
    ["Workspaces", "/workspaces", CRUD_WORKSPACE_NAMES],
    ["Macros", "/macros", CRUD_MACRO_NAMES]
  ] as const) {
    await openSection(label, route);
    const visibleText = await $("body").getText();
    for (const name of names) expect(visibleText).not.toContain(name);
  }
}

describe("Chromium full app CRUD and pointer reorder", () => {
  it("uses only visible UI mutations and authoritative read-only state evidence", async () => {
    const phase = required("RION_STUDIO_E2E_PHASE");
    if (phase === "chromium-app-crud-mutations") await mutationPhase();
    else if (phase === "chromium-app-crud-cleanup") await cleanupPhase();
    else if (phase === "chromium-app-crud-final-restart") await finalRestartPhase();
    else throw new Error(`Unexpected Chromium app CRUD phase ${phase}`);
  });
});
