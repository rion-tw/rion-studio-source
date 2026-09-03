import { $, browser, expect } from "@wdio/globals";
import { Key } from "webdriverio";

import type {
  EmbeddedRuntimeState,
  Game,
  LaunchWorkspace,
  Macro,
  Role,
  RoleStatus
} from "../../../src/shared/types";
import {
  electronDesktopE2eProbe,
  electronDesktopE2eRoleSessionRuntime
} from "../support/electron-driver";
import { fixtureCursor, waitFixtureEvent } from "../support/fixture";
import { rendererCall } from "../support/renderer-bridge";
import {
  acceptLegalAndSkipFirstRun,
  clickWorkspaceCreateAction,
  ensureEnglishUi,
  navigate,
  setEditorName,
  setInputValue,
  submitEditor,
  waitForRoute
} from "../support/ui";

// [journey:CHROMIUM-MACOS-APPKIT-ROLE-PERSIST-003]
// [journey:CHROMIUM-WINDOWS-ROLE-PERSIST-003]
// [journey:CHROMIUM-MACOS-APPKIT-WORKSPACE-PERSIST-004]
// [journey:CHROMIUM-WINDOWS-WORKSPACE-PERSIST-004]
// [journey:CHROMIUM-MACOS-APPKIT-MACRO-PERSIST-005]
// [journey:CHROMIUM-WINDOWS-MACRO-PERSIST-005]

const GAME_NAME = "Chromium Entity Game";
const ROLE_NAME = "Chromium Entity Role";
const ROLE_NAME_EDITED = "Chromium Entity Role Edited";
const WORKSPACE_NAME = "Chromium Entity Workspace";
const WORKSPACE_NAME_EDITED = "Chromium Entity Workspace Edited";
const MACRO_NAME = "Chromium Entity Macro";
const MACRO_NAME_EDITED = "Chromium Entity Macro Edited";
const ROLE_FIXTURE_ID = "chromium-entity";
const WEB_FIXTURE_ID = "chromium-workspace-web";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the Chromium entity journey`);
  return value;
}

async function expectNativeRoleOwnership(
  role: Role,
  runtime: EmbeddedRuntimeState,
  expectedTab: Readonly<{ sourceId: string; type: "role" | "workspace" }>
): Promise<void> {
  const inspection = await electronDesktopE2eRoleSessionRuntime(role.id);
  const native = inspection.currentRuntime;
  const session = inspection.latestSessionEnsure;
  expect(native).not.toBeNull();
  const tab = runtime.tabs.find((candidate) => candidate.id === native?.tabId);
  const window = runtime.windows.find((candidate) => candidate.id === native?.windowId);
  expect(inspection.roleId).toBe(role.id);
  expect(session.chromiumUserDataDir).toContain(role.id);
  expect(session.sessionStoragePath).toBe(session.chromiumUserDataDir);
  expect(session.sessionStoragePathSha256).toBe(session.chromiumPathSha256);
  expect(session.ensureCount).toBeGreaterThan(0);
  expect(session.nativeSessionInstance).toBeGreaterThan(0);
  expect(native).toEqual(expect.objectContaining({
    visible: true
  }));
  expect(native?.attemptGeneration).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
  );
  expect(native?.generation).toBeGreaterThan(0);
  expect(native?.ownerGeneration).toBeGreaterThan(0);
  expect(native?.parentNativeHostId).toBeGreaterThan(0);
  expect(native?.topologyRevision).toBeGreaterThan(0);
  expect(native?.windowGeneration).toBeGreaterThan(0);
  expect(tab).toEqual(expect.objectContaining({
    active: true,
    hidden: false,
    id: native?.tabId,
    roleIds: expect.arrayContaining([role.id]),
    sourceId: expectedTab.sourceId,
    type: expectedTab.type,
    windowId: native?.windowId
  }));
  expect(window).toEqual(expect.objectContaining({
    activeTabId: native?.tabId,
    id: native?.windowId,
    visible: true,
    windowId: native?.windowId
  }));
  if (required("RION_STUDIO_E2E_RUNTIME_TARGET") === "chromium-v23-macos-appkit") {
    expect(native?.hostKind).toBe("appkit-chromium");
    expect(native?.appKitIdentity).toEqual({
      launchGeneration: native?.attemptGeneration,
      logicalWindowId: native?.windowId,
      nativeGeneration: native?.appKitIdentity?.nativeGeneration
    });
    expect(native?.appKitIdentity?.nativeGeneration).toBeGreaterThan(0);
  } else {
    expect(native?.hostKind).toBe("bundled-chromium");
    expect(native?.appKitIdentity).toBeNull();
  }
}

async function findGame(name: string): Promise<Game> {
  let entity: Game | undefined;
  await browser.waitUntil(async () => {
    entity = (await rendererCall("listGames")).find((candidate) => candidate.name === name);
    return Boolean(entity);
  }, { timeout: 15_000, timeoutMsg: `Chromium entity journey did not find Game ${name}` });
  return entity as Game;
}

async function findRole(name: string): Promise<Role> {
  let entity: Role | undefined;
  await browser.waitUntil(async () => {
    entity = (await rendererCall("listRoles")).find((candidate) => candidate.name === name);
    return Boolean(entity);
  }, { timeout: 15_000, timeoutMsg: `Chromium entity journey did not find Role ${name}` });
  return entity as Role;
}

async function launchRoleThroughQuickAccess(role: Role): Promise<void> {
  await openSection("Home", "/dashboard");
  const afterSequence = await fixtureCursor();
  await $("[data-testid='quick-access-trigger']").click();
  const palette = await $("[data-testid='quick-access-palette'][open]");
  await palette.waitForDisplayed({ timeout: 10_000 });
  const search = await palette.$("input[role='combobox']");
  await search.setValue(role.name);
  const option = await $(`#quick-access-option-role-${role.id}`);
  await option.waitForDisplayed({ timeout: 10_000 });
  await option.click();

  const session = await waitFixtureEvent({
    afterSequence,
    kind: "session",
    roleId: ROLE_FIXTURE_ID
  });
  expect(session.session).toEqual({
    after: { cookie: null, localStorage: null },
    before: { cookie: null, localStorage: null },
    marker: ROLE_FIXTURE_ID,
    mode: "observe"
  });

  let status: RoleStatus | undefined;
  await browser.waitUntil(async () => {
    status = (await rendererCall("listRoleStatuses"))
      .find((candidate) => candidate.roleId === role.id);
    return status?.state === "running";
  }, {
    interval: 100,
    timeout: 45_000,
    timeoutMsg: `Chromium Quick Access did not launch Role ${role.id}`
  });
  expect(status?.resolvedEngine).toBe("chromium");
  expect(status?.hostKind).toBe(
    required("RION_STUDIO_E2E_RUNTIME_TARGET") === "chromium-v23-macos-appkit"
      ? "appkit-chromium"
      : "bundled-chromium"
  );

  let runtime: EmbeddedRuntimeState | undefined;
  await browser.waitUntil(async () => {
    try {
      runtime = await rendererCall("getEmbeddedRuntimeState");
      return runtime.windows.some((window) => window.visible) &&
        runtime.tabs.some((tab) => tab.roleIds.includes(role.id));
    } catch {
      return false;
    }
  }, {
    interval: 100,
    timeout: 20_000,
    timeoutMsg: `Chromium native runtime projection did not own Role ${role.id}`
  });
  expect(runtime?.windows).toEqual([
    expect.objectContaining({ visible: true })
  ]);
  await expectNativeRoleOwnership(role, runtime!, {
    sourceId: role.id,
    type: "role"
  });
}

async function launchWorkspaceThroughVisibleUi(
  workspace: LaunchWorkspace,
  role: Role
): Promise<void> {
  const afterSequence = await fixtureCursor();
  await openSection("Workspaces", "/workspaces");
  const card = await $(`[data-selection-id='${workspace.id}']`);
  await card.waitForDisplayed({ timeout: 10_000 });
  await card.scrollIntoView({ block: "center", inline: "center" });
  await card.moveTo();
  const open = await card.$("button[aria-label='Open workspace']");
  await open.waitForDisplayed({ timeout: 10_000 });
  await open.waitForClickable({ timeout: 10_000 });
  await open.click();

  const roleSession = await waitFixtureEvent({
    afterSequence,
    kind: "session",
    roleId: ROLE_FIXTURE_ID
  });
  expect(roleSession.session).toEqual({
    after: { cookie: null, localStorage: null },
    before: { cookie: null, localStorage: null },
    marker: ROLE_FIXTURE_ID,
    mode: "observe"
  });
  const webSession = await waitFixtureEvent({
    afterSequence,
    kind: "session",
    roleId: WEB_FIXTURE_ID
  });
  expect(webSession.session).toEqual({
    after: { cookie: null, localStorage: null },
    before: { cookie: null, localStorage: null },
    marker: WEB_FIXTURE_ID,
    mode: "observe"
  });

  let status: RoleStatus | undefined;
  let runtime: EmbeddedRuntimeState | undefined;
  await browser.waitUntil(async () => {
    status = (await rendererCall("listRoleStatuses"))
      .find((candidate) => candidate.roleId === role.id);
    runtime = await rendererCall("getEmbeddedRuntimeState");
    const tab = runtime.tabs.find((candidate) =>
      candidate.type === "workspace" &&
      candidate.sourceId === workspace.id &&
      candidate.roleIds.includes(role.id)
    );
    return status?.state === "running" && Boolean(tab) &&
      runtime.windows.some((window) => window.id === tab?.windowId && window.visible);
  }, {
    interval: 100,
    timeout: 45_000,
    timeoutMsg: `Chromium native Workspace ${workspace.id} did not reach ready`
  });
  expect(status?.resolvedEngine).toBe("chromium");
  expect(status?.hostKind).toBe(
    required("RION_STUDIO_E2E_RUNTIME_TARGET") === "chromium-v23-macos-appkit"
      ? "appkit-chromium"
      : "bundled-chromium"
  );
  expect(runtime?.tabs).toEqual(expect.arrayContaining([
    expect.objectContaining({
      type: "workspace",
      sourceId: workspace.id,
      roleIds: expect.arrayContaining([role.id])
    })
  ]));
  await expectNativeRoleOwnership(role, runtime!, {
    sourceId: workspace.id,
    type: "workspace"
  });

  await rendererCall("stopLaunchWorkspace", workspace.id);
  await browser.waitUntil(async () => {
    const statuses = await rendererCall("listRoleStatuses");
    const current = await rendererCall("getEmbeddedRuntimeState");
    return !statuses.some((candidate) => candidate.roleId === role.id) &&
      !current.tabs.some((candidate) => candidate.sourceId === workspace.id);
  }, {
    interval: 100,
    timeout: 30_000,
    timeoutMsg: `Chromium Workspace ${workspace.id} did not retire after validation`
  });
}

async function findWorkspace(name: string): Promise<LaunchWorkspace> {
  let entity: LaunchWorkspace | undefined;
  await browser.waitUntil(async () => {
    entity = (await rendererCall("listLaunchWorkspaces"))
      .find((candidate) => candidate.name === name);
    return Boolean(entity);
  }, { timeout: 15_000, timeoutMsg: `Chromium entity journey did not find Workspace ${name}` });
  return entity as LaunchWorkspace;
}

async function findMacro(name: string): Promise<Macro> {
  let entity: Macro | undefined;
  await browser.waitUntil(async () => {
    entity = (await rendererCall("listMacros")).find((candidate) => candidate.name === name);
    return Boolean(entity);
  }, { timeout: 15_000, timeoutMsg: `Chromium entity journey did not find Macro ${name}` });
  return entity as Macro;
}

async function openSection(label: string, route: string): Promise<void> {
  const sidebar = await $(".app-main-sidebar");
  await sidebar.waitForDisplayed({ timeout: 20_000 });
  await sidebar.$(`button*=${label}`).click();
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
  await trigger.waitForDisplayed({ timeout: 10_000 });
  await trigger.click();
  const menu = await $("[role='menu']");
  await menu.waitForDisplayed({ timeout: 10_000 });
  const action = await menu.$(`.//*[@role='menuitem' and normalize-space(.)='${actionLabel}']`);
  await action.waitForClickable({ timeout: 10_000 });
  await action.click();
}

async function createGame(): Promise<Game> {
  await openSection("Games", "/games");
  await $("button=New game").click();
  await waitForRoute("/games/new");
  await setEditorName(GAME_NAME);
  const launchUrl = await $("#game-launch-url");
  await launchUrl.setValue("invalid-url");
  await expect($("#app-editor-form button[type='submit']")).toBeDisabled();
  await launchUrl.setValue(`${required("RION_STUDIO_E2E_FIXTURE_ORIGIN")}/role/chromium-entity`);
  await submitEditor("/games");
  return findGame(GAME_NAME);
}

async function createAndEditRole(game: Game): Promise<Role> {
  await clickEntityMenuAction(game.id, ["Game actions"], "Add role");
  await waitForRoute(`/roles/new?gameId=${game.id}`);
  await setEditorName(ROLE_NAME);
  await submitEditor("/roles");
  const role = await findRole(ROLE_NAME);
  await clickEntityMenuAction(
    role.id,
    ["Role actions", "Click for actions or drag to reorder"],
    "Edit"
  );
  await waitForRoute(`/roles/${role.id}/edit`);
  await setEditorName(ROLE_NAME_EDITED);
  await submitEditor("/roles");
  const edited = await findRole(ROLE_NAME_EDITED);
  expect(edited.id).toBe(role.id);
  return edited;
}

async function createAndEditWorkspace(role: Role): Promise<LaunchWorkspace> {
  await openSection("Workspaces", "/workspaces");
  await clickWorkspaceCreateAction();
  await waitForRoute("/workspaces/new");
  await setEditorName(WORKSPACE_NAME);

  await $("#workspace-slot-content").click();
  await $("[role='option']=Web app").click();
  await setInputValue("#workspace-web-name", "Chromium fixture");
  await setInputValue("#workspace-web-url",
    `${required("RION_STUDIO_E2E_FIXTURE_ORIGIN")}/role/chromium-workspace-web`
  );
  await $("[data-workspace-slot-index='1']").click();
  await $("#workspace-slot-content").click();
  await $("[role='option']=Role").click();
  await $(`[data-workspace-role-id='${role.id}']`).click();
  await submitEditor("/workspaces");

  const workspace = await findWorkspace(WORKSPACE_NAME);
  await clickEntityMenuAction(
    workspace.id,
    ["Workspace actions", "Click for actions or drag to reorder"],
    "Edit"
  );
  await waitForRoute(`/workspaces/${workspace.id}/edit`);
  await setEditorName(WORKSPACE_NAME_EDITED);
  await submitEditor("/workspaces");
  const edited = await findWorkspace(WORKSPACE_NAME_EDITED);
  expect(edited.id).toBe(workspace.id);
  return edited;
}

async function createAndEditMacro(role: Role): Promise<Macro> {
  await openSection("Macros", "/macros");
  const populatedListAction = await $("button=New macro");
  const createAction = await populatedListAction.isExisting()
    ? populatedListAction
    : $("button=Create macro");
  await createAction.waitForDisplayed({ timeout: 10_000 });
  await createAction.click();
  await waitForRoute("/macros/new");
  // The empty list has no role-scoped visible entry. Re-enter through the same
  // role deep link emitted by a populated group's visible New macro action;
  // creation, validation, steps, submit, and edit remain visible user actions.
  await navigate(`/macros/new?roleId=${role.id}`);
  await setEditorName(MACRO_NAME);
  await $(`[aria-label='Remove ${role.name}']`).waitForDisplayed({ timeout: 10_000 });

  await $("button[aria-label='Record']").click();
  await browser.action("key")
    .down(Key.Ctrl)
    .down("k")
    .up("k")
    .up(Key.Ctrl)
    .perform();
  const shortcutError = await $("p.text-destructive");
  await shortcutError.waitForExist({ timeout: 10_000 });
  await expect(shortcutError)
    .toHaveText("Ctrl/Command+K is reserved for Rion Studio Quick Access.");
  await expect($("button=Create macro")).toBeDisabled();
  await $("button=Clear").click();
  await $("button=Hold until stopped").click();
  await submitEditor("/macros");

  const macro = await findMacro(MACRO_NAME);
  await clickEntityMenuAction(macro.id, ["Macro actions"], "Edit");
  await waitForRoute(`/macros/${macro.id}/edit`);
  await setEditorName(MACRO_NAME_EDITED);
  await submitEditor("/macros");
  const edited = await findMacro(MACRO_NAME_EDITED);
  expect(edited.id).toBe(macro.id);
  return edited;
}

async function seedPhase(): Promise<void> {
  const game = await createGame();
  const role = await createAndEditRole(game);
  const workspace = await createAndEditWorkspace(role);
  const macro = await createAndEditMacro(role);
  expect(workspace.slots.some((slot) => slot.roleId === role.id)).toBe(true);
  expect(workspace.slots.some((slot) => slot.web?.name === "Chromium fixture")).toBe(true);
  expect(macro.roleIds).toContain(role.id);
  await launchWorkspaceThroughVisibleUi(workspace, role);
  await launchRoleThroughQuickAccess(role);
}

async function restartPhase(): Promise<void> {
  const game = await findGame(GAME_NAME);
  const role = await findRole(ROLE_NAME_EDITED);
  const workspace = await findWorkspace(WORKSPACE_NAME_EDITED);
  const macro = await findMacro(MACRO_NAME_EDITED);
  expect(role.gameId).toBe(game.id);
  expect(workspace.slots.some((slot) => slot.roleId === role.id)).toBe(true);
  expect(workspace.slots.some((slot) =>
    slot.web?.name === "Chromium fixture"
      && slot.web.startUrl.endsWith("/role/chromium-workspace-web")
  )).toBe(true);
  expect(macro.roleIds).toContain(role.id);
  for (const [label, route, entityId] of [
    ["Games", "/games", game.id],
    ["Roles", "/roles", role.id],
    ["Workspaces", "/workspaces", workspace.id],
    ["Macros", "/macros", macro.id]
  ] as const) {
    await openSection(label, route);
    await $(`[data-selection-id='${entityId}']`).waitForDisplayed({ timeout: 10_000 });
  }
  await launchWorkspaceThroughVisibleUi(workspace, role);
  await launchRoleThroughQuickAccess(role);
}

describe("Chromium Core entity persistence", () => {
  it("creates, edits, restores, and launches entities through visible Chromium UI", async () => {
    const probe = await electronDesktopE2eProbe();
    expect(probe.runtimeTarget).toBe(required("RION_STUDIO_E2E_RUNTIME_TARGET"));
    await ensureEnglishUi();
    await acceptLegalAndSkipFirstRun();

    const phase = required("RION_STUDIO_E2E_PHASE");
    if (phase === "chromium-entity-persistence-seed") await seedPhase();
    else if (phase === "chromium-entity-persistence-restart") await restartPhase();
    else throw new Error(`Unexpected Chromium entity journey phase ${phase}`);
  });
});
