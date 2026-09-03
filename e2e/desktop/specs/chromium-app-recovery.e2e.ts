import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { $, browser, expect } from "@wdio/globals";

import type { EmbeddedRuntimeState, Game, GameWindow, LaunchWorkspace, Role, RoleStatus } from
  "../../../src/shared/types";
import {
  electronDesktopE2eGameWindowRuntime,
  electronDesktopE2eProbe,
  electronDesktopE2eRoleSessionRuntime
} from "../support/electron-driver";
import { clickVisibleElectronRolePageButton } from
  "../support/electron-role-surface";
import { fixtureCursor, waitFixtureEvent } from "../support/fixture";
import { forceTerminateProcessTree } from "../support/process";
import { rendererCall } from "../support/renderer-bridge";
import {
  acceptLegalAndSkipFirstRun,
  clickWorkspaceCreateAction,
  ensureEnglishUi,
  navigate,
  setEditorName,
  submitEditor,
  waitForRoute
} from "../support/ui";

// [journey:CHROMIUM-MACOS-APPKIT-APP-RECOVERY-015]
// [journey:CHROMIUM-WINDOWS-APP-RECOVERY-015]

const GAME_NAME = "Chromium Recovery Game";
const ROLE_A_NAME = "Chromium Recovery Role A";
const ROLE_B_NAME = "Chromium Recovery Role B";
const WORKSPACE_NAME = "Chromium Recovery Workspace";
const WINDOW_NAME = "Chromium Recovery Window";
const FIXTURE_A = "chromium-recovery-a";
const FIXTURE_B = "chromium-recovery-b";
const MARKER_A = "chromium-recovery-marker-a";
const MARKER_B = "chromium-recovery-marker-b";

interface RecoveryLifecycleEvidence {
  contractVersion: 1;
  platform: "macos" | "windows";
  roles: Readonly<Record<"a" | "b", Readonly<{
    chromiumPathSha256: string;
    roleId: string;
  }>>>;
  tabId: string;
  windowId: string;
  workspaceId: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the Chromium recovery journey`);
  return value;
}

function fixtureUrl(fixtureId: string, marker: string): string {
  const url = new URL(`/role/${fixtureId}`, required("RION_STUDIO_E2E_FIXTURE_ORIGIN"));
  url.searchParams.set("marker", marker);
  url.searchParams.set("mode", "late-write");
  return url.href;
}

function lifecycleEvidencePath(): string {
  return resolve(
    dirname(required("RION_STUDIO_E2E_ARTIFACT_DIR")),
    "chromium-app-recovery-evidence.json"
  );
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
    if (await candidate.isExisting() && await candidate.isDisplayed()) {
      trigger = candidate;
      break;
    }
  }
  if (!trigger) throw new Error(`Entity ${entityId} has no visible action trigger`);
  await trigger.waitForClickable({ timeout: 10_000 });
  await trigger.click();
  const action = await $(`//*[@role='menuitem' and normalize-space(.)='${actionLabel}']`);
  await action.waitForClickable({ timeout: 10_000 });
  await action.click();
}

async function findEntity<Value extends { name: string }>(
  name: string,
  read: () => Promise<Value[]>
): Promise<Value> {
  let entity: Value | undefined;
  await browser.waitUntil(async () => {
    entity = (await read()).find((candidate) => candidate.name === name);
    return entity !== undefined;
  }, { timeout: 15_000, timeoutMsg: `Did not find persisted entity ${name}` });
  return entity!;
}

async function createGame(): Promise<Game> {
  await openSection("Games", "/games");
  await $("button=New game").click();
  await waitForRoute("/games/new");
  await setEditorName(GAME_NAME);
  await $("#game-launch-url").setValue(fixtureUrl(FIXTURE_A, MARKER_A));
  await submitEditor("/games");
  return findEntity(GAME_NAME, () => rendererCall("listGames"));
}

async function createRole(game: Game, name: string, launchUrl: string): Promise<Role> {
  await openSection("Games", "/games");
  await clickEntityMenuAction(game.id, ["Game actions"], "Add role");
  await waitForRoute(`/roles/new?gameId=${game.id}`);
  await setEditorName(name);
  await $("#role-launch-url").setValue(launchUrl);
  await submitEditor("/roles");
  return findEntity(name, () => rendererCall("listRoles"));
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
  return findEntity(WORKSPACE_NAME, () => rendererCall("listLaunchWorkspaces"));
}

async function createGameWindow(): Promise<GameWindow> {
  await openSection("Windows", "/game-windows");
  const existing = new Set((await rendererCall("listGameWindows")).map(({ id }) => id));
  await $("button=New game window").click();
  let created: GameWindow | undefined;
  await browser.waitUntil(async () => {
    created = (await rendererCall("listGameWindows"))
      .find(({ id }) => !existing.has(id));
    return created !== undefined;
  }, { timeout: 15_000, timeoutMsg: "Visible UI did not create a Game Window" });
  await clickEntityMenuAction(created!.id, ["Game window actions"], "Rename");
  const input = await $("#rename-game-window-name");
  await input.clearValue();
  await input.setValue(WINDOW_NAME);
  await (await $("dialog[open]")).$("button=Save").click();
  return findEntity(WINDOW_NAME, () => rendererCall("listGameWindows"));
}

function expectSession(
  event: Awaited<ReturnType<typeof waitFixtureEvent>>,
  marker: string,
  expectedStored: string | null
): void {
  expect(event.session).toEqual({
    after: { cookie: marker, localStorage: expectedStored },
    before: { cookie: expectedStored, localStorage: expectedStored },
    marker,
    mode: "late-write"
  });
}

async function waitForSessions(afterSequence: number, expectedStored: string | null): Promise<void> {
  const [a, b] = await Promise.all([
    waitFixtureEvent({ afterSequence, kind: "session", roleId: FIXTURE_A }),
    waitFixtureEvent({ afterSequence, kind: "session", roleId: FIXTURE_B })
  ]);
  expectSession(a, MARKER_A, expectedStored === null ? null : MARKER_A);
  expectSession(b, MARKER_B, expectedStored === null ? null : MARKER_B);
}

async function waitForRunningRoles(
  roles: readonly Role[],
  platform: "macos" | "windows"
): Promise<void> {
  let statuses: RoleStatus[] = [];
  await browser.waitUntil(async () => {
    statuses = await rendererCall("listRoleStatuses");
    return roles.every((role) => statuses.some(
      (status) => status.roleId === role.id && status.state === "running"
    ));
  }, { timeout: 45_000, timeoutMsg: "Recovered Chromium Roles did not reach running" });
  for (const role of roles) {
    expect(statuses.find(({ roleId }) => roleId === role.id)).toEqual(
      expect.objectContaining({
        hostKind: platform === "macos" ? "appkit-chromium" : "bundled-chromium",
        resolvedEngine: "chromium",
        state: "running"
      })
    );
  }
}

async function launchWorkspace(
  workspace: LaunchWorkspace,
  gameWindow: GameWindow,
  roles: readonly [Role, Role],
  platform: "macos" | "windows"
): Promise<void> {
  const cursor = await fixtureCursor();
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
  if (!actions) throw new Error("Workspace has no visible destination menu");
  await actions.click();
  const openIn = await $('//*[@role="menuitem" and normalize-space(.)="Open in…"]');
  await openIn.waitForClickable({ timeout: 10_000 });
  await openIn.click();
  const destination = await $(
    `//*[@role='menuitem'][.//*[normalize-space(.)='${WINDOW_NAME}']]`
  );
  await destination.waitForClickable({ timeout: 10_000 });
  await destination.click();
  try {
    await browser.waitUntil(async () => {
      const saved = (await rendererCall("listGameWindows"))
        .find(({ id }) => id === gameWindow.id);
      const runtime = await rendererCall("getEmbeddedRuntimeState");
      return saved?.tabs.length === 1
        && saved.tabs[0]?.sourceId === workspace.id
        && runtime.windows.some(({ id, visible }) => id === gameWindow.id && visible);
    }, { timeout: 45_000, timeoutMsg: "Visible destination did not launch the Workspace" });
  } catch (error) {
    const [snapshot, bodyText] = await Promise.all([
      rendererCall("getAppSnapshot"),
      browser.execute(() => document.body.innerText)
    ]);
    await writeFile(
      resolve(required("RION_STUDIO_E2E_ARTIFACT_DIR"), "launch-diagnostic.json"),
      `${JSON.stringify({ bodyText, snapshot }, null, 2)}\n`
    );
    throw error;
  }
  await waitForSessions(cursor, null);
  await waitForRunningRoles(roles, platform);
}

async function clickSessionMarkers(
  mainWindowHandle: string,
  roles: readonly [Role, Role]
): Promise<void> {
  for (const [index, [fixtureId, marker]] of [
    [FIXTURE_A, MARKER_A],
    [FIXTURE_B, MARKER_B]
  ].entries()) {
    const cursor = await fixtureCursor();
    await clickVisibleElectronRolePageButton(roles[index]!.launchUrl, mainWindowHandle);
    const [click, updated] = await Promise.all([
      waitFixtureEvent({ afterSequence: cursor, kind: "click", roleId: fixtureId }),
      waitFixtureEvent({
        afterSequence: cursor,
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
}

async function inspectNativePair(
  roles: readonly [Role, Role],
  windowId: string,
  platform: "macos" | "windows"
) {
  const [a, b, gameWindow] = await Promise.all([
    electronDesktopE2eRoleSessionRuntime(roles[0].id),
    electronDesktopE2eRoleSessionRuntime(roles[1].id),
    electronDesktopE2eGameWindowRuntime(windowId)
  ]);
  for (const inspection of [a, b]) {
    expect(inspection.currentRuntime).toEqual(expect.objectContaining({
      hostKind: platform === "macos" ? "appkit-chromium" : "bundled-chromium",
      visible: true,
      windowId
    }));
    expect(inspection.currentRuntime?.parentNativeHostId).toBeGreaterThan(0);
    if (platform === "macos") {
      expect(inspection.currentRuntime?.appKitIdentity).toEqual(expect.objectContaining({
        logicalWindowId: windowId
      }));
      expect(inspection.currentRuntime?.appKitIdentity?.nativeGeneration).toBeGreaterThan(0);
    } else {
      expect(inspection.currentRuntime?.appKitIdentity).toBeNull();
    }
  }
  expect(a.currentRuntime?.tabId).toBe(b.currentRuntime?.tabId);
  expect(a.latestSessionEnsure.chromiumPathSha256)
    .not.toBe(b.latestSessionEnsure.chromiumPathSha256);
  expect(gameWindow.currentRuntime).toEqual(expect.objectContaining({
    coreTabIds: [a.currentRuntime?.tabId],
    hostKind: platform === "macos" ? "appkit-chromium" : "bundled-chromium",
    nativeTabIds: [a.currentRuntime?.tabId],
    visible: true,
    windowId
  }));
  return { a, b, gameWindow };
}

async function writeRuntimeObservation(
  lifecycle: RecoveryLifecycleEvidence,
  native: Awaited<ReturnType<typeof inspectNativePair>>
): Promise<void> {
  await writeFile(
    resolve(required("RION_STUDIO_E2E_ARTIFACT_DIR"), "chromium-app-recovery-runtime.json"),
    `${JSON.stringify({ lifecycle, native }, null, 2)}\n`
  );
}

async function readLifecycleEvidence(
  platform: "macos" | "windows"
): Promise<RecoveryLifecycleEvidence> {
  const lifecycle = JSON.parse(
    await readFile(lifecycleEvidencePath(), "utf8")
  ) as RecoveryLifecycleEvidence;
  expect(lifecycle).toEqual(expect.objectContaining({ contractVersion: 1, platform }));
  return lifecycle;
}

async function persistedRecoveryEntities(lifecycle: RecoveryLifecycleEvidence): Promise<{
  gameWindow: GameWindow;
  roles: readonly [Role, Role];
  workspace: LaunchWorkspace;
}> {
  const roleA = await findEntity(ROLE_A_NAME, () => rendererCall("listRoles"));
  const roleB = await findEntity(ROLE_B_NAME, () => rendererCall("listRoles"));
  const workspace = await findEntity(
    WORKSPACE_NAME,
    () => rendererCall("listLaunchWorkspaces")
  );
  const gameWindow = await findEntity(WINDOW_NAME, () => rendererCall("listGameWindows"));
  expect({
    roleA: roleA.id,
    roleB: roleB.id,
    windowId: gameWindow.id,
    workspaceId: workspace.id
  }).toEqual({
    roleA: lifecycle.roles.a.roleId,
    roleB: lifecycle.roles.b.roleId,
    windowId: lifecycle.windowId,
    workspaceId: lifecycle.workspaceId
  });
  return { gameWindow, roles: [roleA, roleB], workspace };
}

async function seedPhase(
  platform: "macos" | "windows",
  mainWindowHandle: string
): Promise<void> {
  const game = await createGame();
  const roles = [
    await createRole(game, ROLE_A_NAME, fixtureUrl(FIXTURE_A, MARKER_A)),
    await createRole(game, ROLE_B_NAME, fixtureUrl(FIXTURE_B, MARKER_B))
  ] as const;
  const workspace = await createWorkspace(...roles);
  const gameWindow = await createGameWindow();
  await launchWorkspace(workspace, gameWindow, roles, platform);
  await clickSessionMarkers(mainWindowHandle, roles);
  const native = await inspectNativePair(roles, gameWindow.id, platform);
  const tabId = native.a.currentRuntime?.tabId;
  if (!tabId) throw new Error("Recovery seed has no exact live Chromium tab identity");

  const lifecycle: RecoveryLifecycleEvidence = {
    contractVersion: 1,
    platform,
    roles: {
      a: { chromiumPathSha256: native.a.latestSessionEnsure.chromiumPathSha256, roleId: roles[0].id },
      b: { chromiumPathSha256: native.b.latestSessionEnsure.chromiumPathSha256, roleId: roles[1].id }
    },
    tabId,
    windowId: gameWindow.id,
    workspaceId: workspace.id
  };
  await writeFile(lifecycleEvidencePath(), `${JSON.stringify(lifecycle, null, 2)}\n`);
  await writeRuntimeObservation(lifecycle, native);
}

async function forcePhase(
  platform: "macos" | "windows",
  processId: number
): Promise<void> {
  const lifecycle = await readLifecycleEvidence(platform);
  const { gameWindow, roles } = await persistedRecoveryEntities(lifecycle);
  const dormant = await rendererCall("getEmbeddedRuntimeState");
  expect(dormant.recovery).toBeUndefined();
  expect(dormant.windows).toEqual([]);

  const cursor = await fixtureCursor();
  await openSection("Windows", "/game-windows");
  const card = await $(`[data-selection-id='${gameWindow.id}']`);
  await card.waitForDisplayed({ timeout: 10_000 });
  const show = await card.$("button[aria-label='Show']");
  await show.waitForClickable({ timeout: 10_000 });
  await show.click();
  await browser.waitUntil(async () => {
    const runtime = await rendererCall("getEmbeddedRuntimeState");
    return runtime.windows.some(
      ({ id, visible }) => id === lifecycle.windowId && visible
    ) && runtime.tabs.some(({ id }) => id === lifecycle.tabId);
  }, { timeout: 45_000, timeoutMsg: "Visible Show did not reopen the recovery seed" });
  await waitForSessions(cursor, "stored");
  await waitForRunningRoles(roles, platform);
  const native = await inspectNativePair(roles, gameWindow.id, platform);
  expect(native.a.currentRuntime?.tabId).toBe(lifecycle.tabId);
  expect(native.a.latestSessionEnsure.chromiumPathSha256)
    .toBe(lifecycle.roles.a.chromiumPathSha256);
  expect(native.b.latestSessionEnsure.chromiumPathSha256)
    .toBe(lifecycle.roles.b.chromiumPathSha256);
  await writeRuntimeObservation(lifecycle, native);
  await writeFile(
    resolve(required("RION_STUDIO_E2E_ARTIFACT_DIR"), "forced-termination.json"),
    `${JSON.stringify({ pid: processId, requestedAt: new Date().toISOString() }, null, 2)}\n`
  );
  await forceTerminateProcessTree(processId);
}

async function restorePhase(platform: "macos" | "windows"): Promise<void> {
  const lifecycle = await readLifecycleEvidence(platform);
  const { gameWindow, roles: [roleA, roleB] } =
    await persistedRecoveryEntities(lifecycle);

  await navigate("/dashboard");
  const awaiting = await rendererCall("getEmbeddedRuntimeState");
  expect(awaiting.recovery).toEqual(expect.objectContaining({
    reason: "unclean-exit",
    tabCount: 1,
    windowCount: 1
  }));
  expect(awaiting.savedWindows?.find(({ id }) => id === gameWindow.id)?.state)
    .toBe("awaiting-recovery");
  expect(awaiting.windows).toEqual([]);

  const cursor = await fixtureCursor();
  const restore = await $("button=Restore session");
  await restore.waitForDisplayed({ timeout: 10_000 });
  await restore.waitForClickable({ timeout: 10_000 });
  await restore.click();
  let observedRuntime: EmbeddedRuntimeState | undefined;
  try {
    await browser.waitUntil(async () => {
      observedRuntime = await rendererCall("getEmbeddedRuntimeState");
      return observedRuntime.windows.some(
        ({ id, visible }) => id === gameWindow.id && visible
      ) && observedRuntime.tabs.some(({ id }) => id === lifecycle.tabId);
    }, { timeout: 45_000, timeoutMsg: "Visible Restore session did not hydrate native topology" });
  } catch (error) {
    const bodyText = await browser.execute(() => document.body.innerText);
    await writeFile(
      resolve(required("RION_STUDIO_E2E_ARTIFACT_DIR"), "restore-diagnostic.json"),
      `${JSON.stringify({ bodyText, observedRuntime }, null, 2)}\n`
    );
    throw error;
  }
  await waitForSessions(cursor, "stored");
  await waitForRunningRoles([roleA, roleB], platform);
  await browser.waitUntil(async () => {
    const runtime = await rendererCall("getEmbeddedRuntimeState");
    return runtime.recovery === undefined
      && runtime.windows.some(({ id, visible }) => id === gameWindow.id && visible)
      && runtime.tabs.some(({ id }) => id === lifecycle.tabId);
  }, { timeout: 45_000, timeoutMsg: "Visible Restore session did not terminalize recovery" });
  const native = await inspectNativePair([roleA, roleB], gameWindow.id, platform);
  expect(native.a.currentRuntime?.tabId).toBe(lifecycle.tabId);
  expect(native.a.latestSessionEnsure.chromiumPathSha256)
    .toBe(lifecycle.roles.a.chromiumPathSha256);
  expect(native.b.latestSessionEnsure.chromiumPathSha256)
    .toBe(lifecycle.roles.b.chromiumPathSha256);
  await writeRuntimeObservation(lifecycle, native);
}

describe("Chromium application crash recovery", () => {
  it("restores one exact two-Role Chromium window through the visible dashboard action", async () => {
    const phase = required("RION_STUDIO_E2E_PHASE");
    const probe = await electronDesktopE2eProbe();
    expect(probe.runtimeTarget).toBe(required("RION_STUDIO_E2E_RUNTIME_TARGET"));
    await ensureEnglishUi();
    await acceptLegalAndSkipFirstRun();
    const mainWindowHandle = await browser.getWindowHandle();
    if (phase === "chromium-app-recovery-seed") {
      await seedPhase(probe.platform, mainWindowHandle);
    } else if (phase === "chromium-app-recovery-force") {
      await forcePhase(probe.platform, probe.processId);
    } else if (phase === "chromium-app-recovery-restore") {
      await restorePhase(probe.platform);
    } else {
      throw new Error(`Unexpected Chromium recovery phase ${phase}`);
    }
  });
});
