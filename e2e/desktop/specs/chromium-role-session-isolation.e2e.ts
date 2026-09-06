import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { $, browser, expect } from "@wdio/globals";

import type {
  Game,
  GameWindow,
  LaunchWorkspace,
  Role,
  RoleStatus
} from "../../../src/shared/types";
import {
  electronDesktopE2eProbe,
  electronDesktopE2eRoleSessionMigration,
  electronDesktopE2eRoleSessionRuntime,
  type ElectronDesktopE2eRoleSessionMigrationInspection,
  type ElectronDesktopE2eRoleSessionRuntimeInspection
} from "../support/electron-driver";
import { clickVisibleElectronRolePageButton } from
  "../support/electron-role-surface";
import { fixtureCursor, waitFixtureEvent } from "../support/fixture";
import { rendererCall } from "../support/renderer-bridge";
import {
  acceptLegalAndSkipFirstRun,
  clickWorkspaceCreateAction,
  clickDialogButton,
  ensureEnglishUi,
  setEditorName,
  submitEditor,
  waitForRoute
} from "../support/ui";

// [journey:CHROMIUM-MACOS-APPKIT-ROLE-SESSION-ISOLATION-003]
// [journey:CHROMIUM-WINDOWS-ROLE-SESSION-ISOLATION-003]

const GAME_NAME = "Chromium Session Isolation Game";
const ROLE_A_NAME = "Chromium Session Role A";
const ROLE_B_NAME = "Chromium Session Role B";
const WINDOW_NAME = "Chromium Session Isolation Window";
const WORKSPACE_NAME = "Chromium Session Isolation Workspace";
const FIXTURE_A = "chromium-session-role-a";
const FIXTURE_B = "chromium-session-role-b";
const MARKER_A = "chromium-session-marker-a";
const MARKER_B = "chromium-session-marker-b";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

interface SeedEvidence {
  contractVersion: 1;
  platform: "macos" | "windows";
  roles: Readonly<Record<"a" | "b", Readonly<{
    chromiumPathSha256: string;
    firstVerifiedLaunchAt: string;
    journalRevision: number;
    roleId: string;
    targetRevision: 0;
    transferId: string;
  }>>>;
  windowId: string;
  workspaceId: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the Chromium isolation journey`);
  return value;
}

function roleFixtureUrl(
  fixtureId: string,
  marker: string,
  mode: "late-write" | "observe"
): string {
  const url = new URL(`/role/${fixtureId}`, required("RION_STUDIO_E2E_FIXTURE_ORIGIN"));
  url.searchParams.set("marker", marker);
  url.searchParams.set("mode", mode);
  return url.href;
}

function lifecycleEvidencePath(): string {
  return resolve(
    dirname(required("RION_STUDIO_E2E_ARTIFACT_DIR")),
    "chromium-role-session-isolation-evidence.json"
  );
}

async function openSection(label: string, route: string): Promise<void> {
  const sidebar = await $(".app-main-sidebar");
  await sidebar.waitForDisplayed({ timeout: 20_000 });
  await sidebar.$(`button*=${label}`).click();
  await waitForRoute(route);
}

async function findGame(): Promise<Game> {
  let game: Game | undefined;
  await browser.waitUntil(async () => {
    game = (await rendererCall("listGames")).find((candidate) => candidate.name === GAME_NAME);
    return Boolean(game);
  }, { timeout: 15_000, timeoutMsg: `Did not find ${GAME_NAME}` });
  return game as Game;
}

async function findRole(name: string): Promise<Role> {
  let role: Role | undefined;
  await browser.waitUntil(async () => {
    role = (await rendererCall("listRoles")).find((candidate) => candidate.name === name);
    return Boolean(role);
  }, { timeout: 15_000, timeoutMsg: `Did not find ${name}` });
  return role as Role;
}

async function findWorkspace(): Promise<LaunchWorkspace> {
  let workspace: LaunchWorkspace | undefined;
  await browser.waitUntil(async () => {
    workspace = (await rendererCall("listLaunchWorkspaces"))
      .find((candidate) => candidate.name === WORKSPACE_NAME);
    return Boolean(workspace);
  }, { timeout: 15_000, timeoutMsg: `Did not find ${WORKSPACE_NAME}` });
  return workspace as LaunchWorkspace;
}

async function findGameWindow(): Promise<GameWindow> {
  let gameWindow: GameWindow | undefined;
  await browser.waitUntil(async () => {
    gameWindow = (await rendererCall("listGameWindows"))
      .find((candidate) => candidate.name === WINDOW_NAME);
    return Boolean(gameWindow);
  }, { timeout: 15_000, timeoutMsg: `Did not find ${WINDOW_NAME}` });
  return gameWindow as GameWindow;
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
    if (await candidate.isExisting() && await candidate.isDisplayed()) {
      trigger = candidate;
      break;
    }
  }
  if (!trigger) throw new Error(`Entity ${entityId} has no visible action trigger`);
  await trigger.waitForClickable({ timeout: 10_000 });
  await trigger.click();
  const menu = await $("[role='menu']");
  await menu.waitForDisplayed({ timeout: 10_000 });
  const action = await menu.$(
    `.//*[@role='menuitem' and normalize-space(.)='${actionLabel}']`
  );
  await action.waitForClickable({ timeout: 10_000 });
  await action.click();
}

async function createGame(): Promise<Game> {
  await openSection("Games", "/games");
  await $("button=New game").click();
  await waitForRoute("/games/new");
  await setEditorName(GAME_NAME);
  await $("#game-launch-url").setValue(
    roleFixtureUrl(FIXTURE_A, MARKER_A, "late-write")
  );
  await submitEditor("/games");
  return findGame();
}

async function createGameWindow(): Promise<GameWindow> {
  await openSection("Windows", "/game-windows");
  const existingIds = new Set(
    (await rendererCall("listGameWindows")).map((window) => window.id)
  );
  await $("button=New game window").click();
  let created: GameWindow | undefined;
  await browser.waitUntil(async () => {
    created = (await rendererCall("listGameWindows"))
      .find((window) => !existingIds.has(window.id));
    return created !== undefined;
  }, { timeout: 15_000, timeoutMsg: "Visible UI did not create a saved Game Window" });
  await clickEntityMenuAction(created!.id, ["Game window actions"], "Rename");
  const input = await $("#rename-game-window-name");
  await input.clearValue();
  await input.setValue(WINDOW_NAME);
  await (await $("dialog[open]")).$("button=Save").click();
  const gameWindow = await findGameWindow();
  expect(gameWindow.id).toBe(created!.id);
  expect(gameWindow.tabs).toEqual([]);
  return gameWindow;
}

async function createRole(game: Game, name: string, launchUrl: string): Promise<Role> {
  await openSection("Games", "/games");
  await clickEntityMenuAction(game.id, ["Game actions"], "Add role");
  await waitForRoute(`/roles/new?gameId=${game.id}`);
  await setEditorName(name);
  await $("#role-launch-url").setValue(launchUrl);
  await submitEditor("/roles");
  return findRole(name);
}

async function editRoleLaunchUrl(role: Role, launchUrl: string): Promise<Role> {
  await openSection("Roles", "/roles");
  await clickEntityMenuAction(
    role.id,
    ["Role actions", "Click for actions or drag to reorder"],
    "Edit"
  );
  await waitForRoute(`/roles/${role.id}/edit`);
  await $("#role-launch-url").setValue(launchUrl);
  await submitEditor("/roles");
  const updated = await findRole(role.name);
  expect(updated.id).toBe(role.id);
  expect(updated.launchUrl).toBe(launchUrl);
  return updated;
}

async function createWorkspace(roleA: Role, roleB: Role): Promise<LaunchWorkspace> {
  await openSection("Workspaces", "/workspaces");
  await clickWorkspaceCreateAction();
  await waitForRoute("/workspaces/new");
  await setEditorName(WORKSPACE_NAME);
  await $("#workspace-slot-content").click();
  await $("[role='option']=Role").click();
  await $(`[data-workspace-role-id='${roleA.id}']`).click();
  await $("[data-workspace-slot-index='1']").click();
  await $("#workspace-slot-content").click();
  await $("[role='option']=Role").click();
  await $(`[data-workspace-role-id='${roleB.id}']`).click();
  await submitEditor("/workspaces");
  const workspace = await findWorkspace();
  expect(workspace.slots.filter((slot) => slot.roleId).map((slot) => slot.roleId))
    .toEqual(expect.arrayContaining([roleA.id, roleB.id]));
  return workspace;
}

function expectSession(
  event: Awaited<ReturnType<typeof waitFixtureEvent>>,
  marker: string,
  mode: "late-write" | "observe",
  expectedStored: string | null
): void {
  expect(event.session).toEqual({
    after: {
      cookie: mode === "late-write" ? marker : expectedStored,
      localStorage: expectedStored
    },
    before: { cookie: expectedStored, localStorage: expectedStored },
    marker,
    mode
  });
}

async function waitForWorkspaceSessions(
  afterSequence: number,
  mode: "late-write" | "observe",
  storedA: string | null,
  storedB: string | null
): Promise<void> {
  const [sessionA, sessionB] = await Promise.all([
    waitFixtureEvent({ afterSequence, kind: "session", roleId: FIXTURE_A }),
    waitFixtureEvent({ afterSequence, kind: "session", roleId: FIXTURE_B })
  ]);
  expectSession(sessionA, MARKER_A, mode, storedA);
  expectSession(sessionB, MARKER_B, mode, storedB);
}

async function waitForRunningRoles(
  roleA: Role,
  roleB: Role,
  platform: "macos" | "windows"
): Promise<void> {
  let statuses: RoleStatus[] = [];
  await browser.waitUntil(async () => {
    statuses = await rendererCall("listRoleStatuses");
    return [roleA.id, roleB.id].every((roleId) =>
      statuses.some((status) => status.roleId === roleId && status.state === "running")
    );
  }, { timeout: 45_000, timeoutMsg: "Both Chromium Roles did not reach running" });
  for (const role of [roleA, roleB]) {
    expect(statuses.find((status) => status.roleId === role.id)).toEqual(
      expect.objectContaining({
        hostKind: platform === "macos" ? "appkit-chromium" : "bundled-chromium",
        resolvedEngine: "chromium",
        state: "running"
      })
    );
  }
  await browser.waitUntil(async () => {
    const [a, b] = await Promise.all([
      electronDesktopE2eRoleSessionRuntime(roleA.id),
      electronDesktopE2eRoleSessionRuntime(roleB.id)
    ]);
    return a.currentRuntime?.visible === true && b.currentRuntime?.visible === true &&
      a.currentRuntime.windowId === b.currentRuntime.windowId &&
      a.currentRuntime.parentNativeHostId === b.currentRuntime.parentNativeHostId;
  }, {
    timeout: 45_000,
    timeoutMsg: "Both Chromium Role surfaces did not become visible in the same native host"
  });
}

async function launchWorkspaceInGameWindow(
  workspace: LaunchWorkspace,
  gameWindow: GameWindow,
  roleA: Role,
  roleB: Role,
  platform: "macos" | "windows",
  mode: "late-write" | "observe",
  storedA: string | null,
  storedB: string | null
): Promise<void> {
  const afterSequence = await fixtureCursor();
  await openSection("Workspaces", "/workspaces");
  const card = await $(`[data-selection-id='${workspace.id}']`);
  await card.waitForDisplayed({ timeout: 10_000 });
  await card.moveTo();
  let actions;
  for (const label of ["Workspace actions", "Click for actions or drag to reorder"]) {
    const candidate = await card.$(`button[aria-label='${label}']`);
    if (await candidate.isExisting() && await candidate.isDisplayed()) {
      actions = candidate;
      break;
    }
  }
  if (!actions) throw new Error("Workspace has no visible launch-destination menu");
  await actions.waitForClickable({ timeout: 10_000 });
  await actions.click();
  const openIn = await $('//*[@role="menuitem" and normalize-space(.)="Open in…"]');
  await openIn.waitForDisplayed({ timeout: 10_000 });
  await openIn.moveTo();
  const destination = await $(
    `//*[@role='menuitem'][.//*[normalize-space(.)='${WINDOW_NAME}']]`
  );
  await destination.waitForClickable({ timeout: 10_000 });
  await destination.click();
  await waitForWorkspaceSessions(afterSequence, mode, storedA, storedB);
  await waitForRunningRoles(roleA, roleB, platform);
  await browser.waitUntil(async () => {
    const snapshot = await rendererCall("getAppSnapshot");
    return snapshot.embeddedRuntimeState.windows.some(
      (window) => window.windowId === gameWindow.id && window.tabCount === 1
    );
  }, { timeout: 30_000, timeoutMsg: `${WINDOW_NAME} did not become the exact live owner` });
}

async function restoreGameWindowThroughVisibleUi(
  gameWindow: GameWindow,
  roleA: Role,
  roleB: Role,
  platform: "macos" | "windows",
  storedA: string | null,
  storedB: string | null
): Promise<void> {
  const afterSequence = await fixtureCursor();
  await openSection("Windows", "/game-windows");
  const row = await $(`[data-selection-id='${gameWindow.id}']`);
  await row.waitForDisplayed({ timeout: 10_000 });
  const show = await row.$("button[aria-label='Show']");
  await show.waitForClickable({ timeout: 10_000 });
  await show.click();
  await waitForWorkspaceSessions(afterSequence, "observe", storedA, storedB);
  await waitForRunningRoles(roleA, roleB, platform);
}

async function clickLateWriteButton(
  mainWindowHandle: string,
  fixtureId: string,
  launchUrl: string,
  marker: string
): Promise<void> {
  const afterSequence = await fixtureCursor();
  await clickVisibleElectronRolePageButton(launchUrl, mainWindowHandle);
  const [click, updated] = await Promise.all([
    waitFixtureEvent({ afterSequence, kind: "click", roleId: fixtureId }),
    waitFixtureEvent({
      afterSequence,
      kind: "session-local-storage-updated",
      roleId: fixtureId
    })
  ]);
  expect(click).toMatchObject({ isTrusted: true, targetId: "qa-target" });
  expect(updated.session).toEqual({
    after: { cookie: marker, localStorage: marker },
    before: { cookie: marker, localStorage: null },
    marker,
    mode: "late-write"
  });
}

function expectCanonicalTimestamp(value: string | null | undefined): string {
  if (typeof value !== "string") throw new Error("Verified launch timestamp is missing");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error("Verified launch timestamp is not canonical RFC3339");
  }
  return value;
}

function expectV23Ready(
  inspection: ElectronDesktopE2eRoleSessionMigrationInspection,
  platform: "macos" | "windows",
  targetRevision: number
): void {
  expect(inspection.roleExists).toBe(true);
  expect(inspection.pendingRoleBrowserDataClearOperations).toBe(0);
  expect(inspection.journal).toEqual(expect.objectContaining({
    outcome: "explicitReset",
    phase: "v23Ready",
    platform,
    roleId: inspection.roleId,
    sourceEngine: platform === "macos" ? "wkwebview" : "webview2",
    sourceRevision: 0,
    targetEngine: "chromium",
    targetRevision
  }));
  expect(inspection.journal?.journalRevision).toBeGreaterThan(1);
  expect(inspection.journal?.transferId).toMatch(UUID_PATTERN);
  expectCanonicalTimestamp(inspection.journal?.firstVerifiedLaunchAt);
}

async function inspectLiveRole(
  role: Role,
  platform: "macos" | "windows"
): Promise<ElectronDesktopE2eRoleSessionRuntimeInspection> {
  const paths = await rendererCall("getRolePaths", role.id);
  await rendererCall("getAppSnapshot");
  const inspection = await electronDesktopE2eRoleSessionRuntime(role.id);
  const session = inspection.latestSessionEnsure;
  const runtime = inspection.currentRuntime;
  expect(inspection.roleId).toBe(role.id);
  expect(session.chromiumUserDataDir).toBe(paths.chromiumUserDataDir);
  expect(session.sessionStoragePath).toBe(paths.chromiumUserDataDir);
  expect(session.chromiumPathSha256)
    .toBe(createHash("sha256").update(paths.chromiumUserDataDir).digest("hex"));
  expect(session.sessionStoragePathSha256).toBe(session.chromiumPathSha256);
  expect(session.ensureCount).toBeGreaterThan(0);
  expect(session.nativeSessionInstance).toBeGreaterThan(0);
  expect(runtime).toEqual(expect.objectContaining({
    hostKind: platform === "macos" ? "appkit-chromium" : "bundled-chromium",
    visible: true
  }));
  expect(runtime?.attemptGeneration).toMatch(UUID_PATTERN);
  expect(runtime?.generation).toBeGreaterThan(0);
  expect(runtime?.ownerGeneration).toBeGreaterThan(0);
  expect(runtime?.parentNativeHostId).toBeGreaterThan(0);
  expect(runtime?.topologyRevision).toBeGreaterThan(0);
  expect(runtime?.windowGeneration).toBeGreaterThan(0);
  if (platform === "macos") {
    expect(runtime?.appKitIdentity).toEqual({
      launchGeneration: runtime?.attemptGeneration,
      logicalWindowId: runtime?.windowId,
      nativeGeneration: runtime?.appKitIdentity?.nativeGeneration
    });
    expect(runtime?.appKitIdentity?.nativeGeneration).toBeGreaterThan(0);
  } else {
    expect(runtime?.appKitIdentity).toBeNull();
  }
  return inspection;
}

async function inspectLivePair(
  roleA: Role,
  roleB: Role,
  platform: "macos" | "windows"
): Promise<Readonly<{ a: ElectronDesktopE2eRoleSessionRuntimeInspection; b:
  ElectronDesktopE2eRoleSessionRuntimeInspection }>> {
  const [a, b] = await Promise.all([
    inspectLiveRole(roleA, platform),
    inspectLiveRole(roleB, platform)
  ]);
  expect(a.latestSessionEnsure.chromiumPathSha256)
    .not.toBe(b.latestSessionEnsure.chromiumPathSha256);
  expect(a.latestSessionEnsure.nativeSessionInstance)
    .not.toBe(b.latestSessionEnsure.nativeSessionInstance);
  expect(a.currentRuntime?.windowId).toBe(b.currentRuntime?.windowId);
  expect(a.currentRuntime?.tabId).toBe(b.currentRuntime?.tabId);
  return { a, b };
}

async function stopWindowThroughVisibleUi(windowId: string, roleIds: readonly string[]): Promise<void> {
  await openSection("Windows", "/game-windows");
  await clickEntityMenuAction(windowId, ["Game window actions"], "Stop and close window");
  await browser.waitUntil(async () => {
    const snapshot = await rendererCall("getAppSnapshot");
    return !snapshot.embeddedRuntimeState.windows.some((window) => window.id === windowId)
      && roleIds.every((roleId) =>
        !snapshot.embeddedRuntimeState.tabs.some((tab) => tab.roleIds.includes(roleId))
      );
  }, { timeout: 30_000, timeoutMsg: `Game Window ${windowId} did not stop visibly` });
  for (const roleId of roleIds) {
    expect((await electronDesktopE2eRoleSessionRuntime(roleId)).currentRuntime).toBeNull();
  }
}

async function clearRoleAThroughVisibleUi(role: Role): Promise<void> {
  await openSection("Roles", "/roles");
  await clickEntityMenuAction(
    role.id,
    ["Role actions", "Click for actions or drag to reorder"],
    "Clear saved data"
  );
  await clickDialogButton("Clear data");
  const status = await $("[role='status']");
  await status.waitForDisplayed({ timeout: 40_000 });
  await expect(status).toHaveText(`Saved browser data for "${ROLE_A_NAME}" was cleared.`);
}

async function seedPhase(
  platform: "macos" | "windows",
  mainWindowHandle: string
): Promise<void> {
  const lateUrlA = roleFixtureUrl(FIXTURE_A, MARKER_A, "late-write");
  const lateUrlB = roleFixtureUrl(FIXTURE_B, MARKER_B, "late-write");
  const game = await createGame();
  let roleA = await createRole(game, ROLE_A_NAME, lateUrlA);
  let roleB = await createRole(game, ROLE_B_NAME, lateUrlB);
  const workspace = await createWorkspace(roleA, roleB);
  const gameWindow = await createGameWindow();

  await launchWorkspaceInGameWindow(
    workspace,
    gameWindow,
    roleA,
    roleB,
    platform,
    "late-write",
    null,
    null
  );
  await clickLateWriteButton(mainWindowHandle, FIXTURE_A, lateUrlA, MARKER_A);
  await clickLateWriteButton(mainWindowHandle, FIXTURE_B, lateUrlB, MARKER_B);
  const firstRuntime = await inspectLivePair(roleA, roleB, platform);
  const firstMigrationA = await electronDesktopE2eRoleSessionMigration(roleA.id);
  const firstMigrationB = await electronDesktopE2eRoleSessionMigration(roleB.id);
  expectV23Ready(firstMigrationA, platform, 0);
  expectV23Ready(firstMigrationB, platform, 0);
  expect(firstRuntime.a.currentRuntime?.windowId).toBe(gameWindow.id);
  await stopWindowThroughVisibleUi(gameWindow.id, [roleA.id, roleB.id]);

  roleA = await editRoleLaunchUrl(
    roleA,
    roleFixtureUrl(FIXTURE_A, MARKER_A, "observe")
  );
  roleB = await editRoleLaunchUrl(
    roleB,
    roleFixtureUrl(FIXTURE_B, MARKER_B, "observe")
  );
  await restoreGameWindowThroughVisibleUi(
    gameWindow,
    roleA,
    roleB,
    platform,
    MARKER_A,
    MARKER_B
  );
  const reopened = await inspectLivePair(roleA, roleB, platform);
  expect(reopened.a.latestSessionEnsure.chromiumPathSha256)
    .toBe(firstRuntime.a.latestSessionEnsure.chromiumPathSha256);
  expect(reopened.b.latestSessionEnsure.chromiumPathSha256)
    .toBe(firstRuntime.b.latestSessionEnsure.chromiumPathSha256);
  expect(reopened.a.latestSessionEnsure.nativeSessionInstance)
    .toBe(firstRuntime.a.latestSessionEnsure.nativeSessionInstance);
  expect(reopened.b.latestSessionEnsure.nativeSessionInstance)
    .toBe(firstRuntime.b.latestSessionEnsure.nativeSessionInstance);
  expect(reopened.a.currentRuntime?.generation)
    .toBeGreaterThan(firstRuntime.a.currentRuntime?.generation ?? 0);
  expect(reopened.b.currentRuntime?.generation)
    .toBeGreaterThan(firstRuntime.b.currentRuntime?.generation ?? 0);

  const migrationA = await electronDesktopE2eRoleSessionMigration(roleA.id);
  const migrationB = await electronDesktopE2eRoleSessionMigration(roleB.id);
  expect(migrationA.journal).toEqual(firstMigrationA.journal);
  expect(migrationB.journal).toEqual(firstMigrationB.journal);
  expect(reopened.a.currentRuntime?.windowId).toBe(gameWindow.id);
  await stopWindowThroughVisibleUi(gameWindow.id, [roleA.id, roleB.id]);

  const evidence: SeedEvidence = {
    contractVersion: 1,
    platform,
    roles: {
      a: {
        chromiumPathSha256: reopened.a.latestSessionEnsure.chromiumPathSha256,
        firstVerifiedLaunchAt: expectCanonicalTimestamp(
          migrationA.journal?.firstVerifiedLaunchAt
        ),
        journalRevision: migrationA.journal!.journalRevision,
        roleId: roleA.id,
        targetRevision: 0,
        transferId: migrationA.journal!.transferId
      },
      b: {
        chromiumPathSha256: reopened.b.latestSessionEnsure.chromiumPathSha256,
        firstVerifiedLaunchAt: expectCanonicalTimestamp(
          migrationB.journal?.firstVerifiedLaunchAt
        ),
        journalRevision: migrationB.journal!.journalRevision,
        roleId: roleB.id,
        targetRevision: 0,
        transferId: migrationB.journal!.transferId
      }
    },
    windowId: gameWindow.id,
    workspaceId: workspace.id
  };
  await writeFile(lifecycleEvidencePath(), `${JSON.stringify(evidence, null, 2)}\n`);
}

async function restartPhase(platform: "macos" | "windows"): Promise<void> {
  const seed = JSON.parse(await readFile(lifecycleEvidencePath(), "utf8")) as SeedEvidence;
  expect(seed).toEqual(expect.objectContaining({ contractVersion: 1, platform }));
  const roleA = await findRole(ROLE_A_NAME);
  const roleB = await findRole(ROLE_B_NAME);
  const gameWindow = await findGameWindow();
  const workspace = await findWorkspace();
  expect({ a: roleA.id, b: roleB.id, window: gameWindow.id, workspace: workspace.id })
    .toEqual({
      a: seed.roles.a.roleId,
      b: seed.roles.b.roleId,
      window: seed.windowId,
      workspace: seed.workspaceId
    });

  await restoreGameWindowThroughVisibleUi(
    gameWindow,
    roleA,
    roleB,
    platform,
    MARKER_A,
    MARKER_B
  );
  const restarted = await inspectLivePair(roleA, roleB, platform);
  expect(restarted.a.currentRuntime?.windowId).toBe(gameWindow.id);
  expect(restarted.a.latestSessionEnsure.chromiumPathSha256)
    .toBe(seed.roles.a.chromiumPathSha256);
  expect(restarted.b.latestSessionEnsure.chromiumPathSha256)
    .toBe(seed.roles.b.chromiumPathSha256);
  const beforeClearA = await electronDesktopE2eRoleSessionMigration(roleA.id);
  const beforeClearB = await electronDesktopE2eRoleSessionMigration(roleB.id);
  expectV23Ready(beforeClearA, platform, 0);
  expectV23Ready(beforeClearB, platform, 0);
  expect(beforeClearA.journal).toEqual(expect.objectContaining({
    firstVerifiedLaunchAt: seed.roles.a.firstVerifiedLaunchAt,
    journalRevision: seed.roles.a.journalRevision,
    roleId: seed.roles.a.roleId,
    targetRevision: seed.roles.a.targetRevision,
    transferId: seed.roles.a.transferId
  }));
  expect(beforeClearB.journal).toEqual(expect.objectContaining({
    firstVerifiedLaunchAt: seed.roles.b.firstVerifiedLaunchAt,
    journalRevision: seed.roles.b.journalRevision,
    roleId: seed.roles.b.roleId,
    targetRevision: seed.roles.b.targetRevision,
    transferId: seed.roles.b.transferId
  }));
  await stopWindowThroughVisibleUi(gameWindow.id, [roleA.id, roleB.id]);

  await clearRoleAThroughVisibleUi(roleA);
  const clearedA = await electronDesktopE2eRoleSessionMigration(roleA.id);
  const untouchedB = await electronDesktopE2eRoleSessionMigration(roleB.id);
  expect(clearedA.journal).toEqual(expect.objectContaining({
    firstVerifiedLaunchAt: null,
    outcome: "explicitReset",
    phase: "v23Ready",
    roleId: roleA.id,
    targetRevision: 1
  }));
  expect(clearedA.journal?.journalRevision)
    .toBe((beforeClearA.journal?.journalRevision ?? 0) + 1);
  expect(clearedA.journal?.resetReceiptId).toMatch(/^role-browser-clear:/u);
  expect(clearedA.receipt).toEqual({
    clearedStorages: [
      "cookies", "filesystem", "indexdb", "localstorage", "shadercache",
      "serviceworkers", "cachestorage"
    ],
    cookieReadbackCount: 0,
    evidence: "electron-clear-storage-data-promise-and-cookie-readback",
    operationId: clearedA.receipt?.operationId,
    roleId: roleA.id
  });
  expect(clearedA.journal?.cleanFlushReceiptId)
    .toBe(`chromium-session-clear:${clearedA.receipt?.operationId}`);
  expect(untouchedB.journal).toEqual(beforeClearB.journal);
  expect(untouchedB.receipt).toBeNull();

  await restoreGameWindowThroughVisibleUi(
    gameWindow,
    roleA,
    roleB,
    platform,
    null,
    MARKER_B
  );
  const afterClear = await inspectLivePair(roleA, roleB, platform);
  expect(afterClear.a.currentRuntime?.windowId).toBe(gameWindow.id);
  expect(afterClear.a.latestSessionEnsure.chromiumPathSha256)
    .toBe(seed.roles.a.chromiumPathSha256);
  expect(afterClear.b.latestSessionEnsure.chromiumPathSha256)
    .toBe(seed.roles.b.chromiumPathSha256);
  const relaunchedA = await electronDesktopE2eRoleSessionMigration(roleA.id);
  const stillUntouchedB = await electronDesktopE2eRoleSessionMigration(roleB.id);
  expectV23Ready(relaunchedA, platform, 1);
  expect(relaunchedA.journal?.journalRevision)
    .toBe((clearedA.journal?.journalRevision ?? 0) + 1);
  expect(stillUntouchedB.journal).toEqual(beforeClearB.journal);
  await stopWindowThroughVisibleUi(gameWindow.id, [roleA.id, roleB.id]);
}

describe("Chromium Role Session isolation", () => {
  it("isolates same-origin Session state across close, restart, and visible clear", async () => {
    const probe = await electronDesktopE2eProbe();
    expect(probe.runtimeTarget).toBe(required("RION_STUDIO_E2E_RUNTIME_TARGET"));
    await ensureEnglishUi();
    await acceptLegalAndSkipFirstRun();
    const mainWindowHandle = await browser.getWindowHandle();
    const phase = required("RION_STUDIO_E2E_PHASE");
    if (phase === "chromium-role-session-isolation-seed") {
      await seedPhase(probe.platform, mainWindowHandle);
    } else if (phase === "chromium-role-session-isolation-restart") {
      await restartPhase(probe.platform);
    } else {
      throw new Error(`Unexpected Chromium isolation phase ${phase}`);
    }
  });
});
