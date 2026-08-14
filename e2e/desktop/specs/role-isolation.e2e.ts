import { $, browser, expect } from "@wdio/globals";

import type {
  EmbeddedRuntimeState,
  EmbeddedRuntimeTabSummary,
  Game,
  LaunchWorkspace,
  Role
} from "../../../src/shared/types";
import {
  detachTerminatedApplicationSession,
  injectDuplicateRoleCookieCheckpoint,
  probe,
  rendererCall,
  requireEnvironment,
  runtimeUiAction,
  shutdown,
  waitEvent,
  windowSnapshot
} from "../support/control";
import {
  type FixtureEvent,
  fixtureCursor,
  fixtureRequest,
  waitFixtureEvent
} from "../support/fixture";

import {
  installRendererEventJournal,
  rendererEventCursor,
  waitForCollectionProjection,
  waitForRoleProjection,
  waitForRuntimeProjection
} from "../support/renderer-events";
import { waitForTranscriptEvent } from "../support/transcript";
import {
  acceptLegalAndSkipFirstRun,
  clickDialogButton,
  clickEntityMenuAction,
  ensureEnglishUi,
  navigate,
  submitEditor
} from "../support/ui";

// [journey:ROLE-SESSION-ISOLATION-003]
// [journey:WORKSPACE-SHARED-ROLE-003]
// [state-combination:WINDOWS-ROLE-CHECKPOINT-COLLISION-002]

const SESSION_GAME_NAME = "E2E P1 Session Isolation Game";
const SESSION_ROLE_A_NAME = "E2E P1 Session Role A";
const SESSION_ROLE_B_NAME = "E2E P1 Session Role B";
const SESSION_FIXTURE_A = "p1-session-role-a";
const SESSION_FIXTURE_B = "p1-session-role-b";
const SESSION_MARKER_A = "session-marker-a";
const SESSION_MARKER_B = "session-marker-b";

const SHARED_GAME_NAME = "E2E P1 Shared Ownership Game";
const SHARED_ROLE_NAME = "E2E P1 Shared Role";
const UNIQUE_ROLE_A_NAME = "E2E P1 Workspace A Role";
const UNIQUE_ROLE_B_NAME = "E2E P1 Workspace B Role";
const WORKSPACE_A_NAME = "E2E P1 Shared Workspace A";
const WORKSPACE_B_NAME = "E2E P1 Shared Workspace B";
const SHARED_FIXTURE = "p1-shared-role";
const UNIQUE_FIXTURE_A = "p1-shared-unique-a";
const UNIQUE_FIXTURE_B = "p1-shared-unique-b";

function requireNamed<T extends { name: string }>(items: T[], name: string): T {
  const item = items.find((candidate) => candidate.name === name);
  if (!item) throw new Error(`Required role-isolation entity ${name} is unavailable`);
  return item;
}

function fixtureUrl(fixtureId: string, mode: "observe" | "seed", marker: string): string {
  const query = new URLSearchParams({ marker, mode });
  return `${requireEnvironment("RION_STUDIO_E2E_FIXTURE_ORIGIN")}/role/${fixtureId}?${query}`;
}

async function bootstrap(resetFixture = true): Promise<void> {
  await ensureEnglishUi();
  await acceptLegalAndSkipFirstRun();
  await installRendererEventJournal();
  if (resetFixture) await fixtureRequest("/api/reset", {});
}

async function shutdownAndWaitForFlush(): Promise<void> {
  const control = await probe();
  const requestedAfter = new Date().toISOString();
  await shutdown().catch(() => undefined);
  const event = await waitForTranscriptEvent(
    control.transcriptPath,
    (candidate) => candidate.kind === "application-final-flush-complete"
      && candidate.timestamp >= requestedAfter
  );
  expect((event.details as { complete?: boolean }).complete).toBe(true);
  detachTerminatedApplicationSession();
}

async function launchVisibleRole(role: Role, fixtureId: string): Promise<FixtureEvent> {
  await navigate("/roles");
  const rendererCursor = await rendererEventCursor();
  const sessionCursor = await fixtureCursor();
  await $(`[data-selection-id='${role.id}'] button[aria-label='Open']`).click();
  const [session] = await Promise.all([
    waitFixtureEvent({ afterSequence: sessionCursor, kind: "session", roleId: fixtureId }),
    waitForRoleProjection({
      afterSequence: rendererCursor,
      roleId: role.id,
      state: "running"
    })
  ]);
  return session;
}

async function stopRole(role: Role): Promise<void> {
  const control = await probe();
  const requestedAfter = new Date().toISOString();
  const cursor = await rendererEventCursor();
  await browser.execute((roleId) => {
    void window.rionStudio.stopRole(roleId).catch(() => undefined);
  }, role.id);
  const terminal = process.platform === "darwin"
    ? await waitForTranscriptEvent(
        control.transcriptPath,
        (event) => event.kind === `browser-role-stop-terminal:${role.id}`
          && event.timestamp >= requestedAfter
      )
    : await waitEvent({
        afterSequence: control.latestSequence,
        kind: `browser-role-stop-terminal:${role.id}`
      });
  expect(terminal.details).toMatchObject({ errorCode: null, ok: true, roleId: role.id });
  await waitForRoleProjection({ afterSequence: cursor, absent: true, roleId: role.id });
}

async function reopenStoppedRoleFromVisiblePlaceholder(
  role: Role,
  fixtureId: string
): Promise<FixtureEvent> {
  const before = await rendererCall("getEmbeddedRuntimeState");
  const tab = before.tabs.find((candidate) => candidate.sourceId === role.id);
  if (!tab) throw new Error(`Stopped role tab for ${role.name} is unavailable`);
  const slot = requireRoleSlot(tab, role.id);
  expect(slot.state).toBe("available");
  expect(slot.owner).toBeUndefined();

  await waitEvent({
    afterSequence: 0,
    kind: `role-placeholder-ready:${tab.id}:${role.id}`,
    windowId: tab.windowId
  });

  await navigate("/roles");
  const selectionCursor = await rendererEventCursor();
  await $(`[data-selection-id='${role.id}'] button[aria-label='Open']`).click();
  await waitForRuntimeProjection({
    activeTabId: tab.id,
    afterSequence: selectionCursor,
    windowId: tab.windowId
  });
  const selected = await windowSnapshot(tab.windowId);
  expect(selected.kernel?.selectedTabId).toBe(tab.id);

  const controlCursor = (await probe()).latestSequence;
  const roleCursor = await rendererEventCursor();
  const sessionCursor = await fixtureCursor();
  await runtimeUiAction(tab.windowId, {
    action: "pressRoleSlot",
    roleId: role.id,
    tabId: tab.id,
    windowGeneration: selected.windowGeneration
  });
  const [session] = await Promise.all([
    waitFixtureEvent({ afterSequence: sessionCursor, kind: "session", roleId: fixtureId }),
    waitForRoleProjection({ afterSequence: roleCursor, roleId: role.id, state: "running" }),
    waitEvent({
      afterSequence: controlCursor,
      kind: "runtime-ui-action-submitted",
      windowId: tab.windowId
    })
  ]);
  return session;
}

async function editRoleUrl(role: Role, launchUrl: string): Promise<Role> {
  await navigate(`/roles/${role.id}/edit`);
  const cursor = await rendererEventCursor();
  await $("#role-launch-url").setValue(launchUrl);
  await submitEditor("/roles");
  const snapshot = await waitForCollectionProjection({
    afterSequence: cursor,
    collection: "roles",
    names: [role.name]
  });
  const updated = requireNamed(snapshot.roles, role.name);
  expect(updated.launchUrl).toBe(launchUrl);
  return updated;
}

function expectSession(
  event: FixtureEvent,
  input: { before: string | null; marker: string; mode: "observe" | "seed" }
): void {
  expect(event.kind).toBe("session");
  expect(event.session).toMatchObject({
    after: { cookie: input.mode === "seed" ? input.marker : input.before, localStorage: input.mode === "seed" ? input.marker : input.before },
    before: { cookie: input.before, localStorage: input.before },
    marker: input.marker,
    mode: input.mode
  });
}

async function sessionSeedPhase(): Promise<void> {
  await bootstrap();
  const game = await rendererCall("createGame", {
    defaultLaunchUrl: fixtureUrl(SESSION_FIXTURE_A, "seed", SESSION_MARKER_A),
    name: SESSION_GAME_NAME
  });
  let roleA = await rendererCall("createRole", {
    gameId: game.id,
    launchUrl: fixtureUrl(SESSION_FIXTURE_A, "seed", SESSION_MARKER_A),
    name: SESSION_ROLE_A_NAME
  });
  let roleB = await rendererCall("createRole", {
    gameId: game.id,
    launchUrl: fixtureUrl(SESSION_FIXTURE_B, "seed", SESSION_MARKER_B),
    name: SESSION_ROLE_B_NAME
  });

  expectSession(await launchVisibleRole(roleA, SESSION_FIXTURE_A), {
    before: null,
    marker: SESSION_MARKER_A,
    mode: "seed"
  });
  expectSession(await launchVisibleRole(roleB, SESSION_FIXTURE_B), {
    before: null,
    marker: SESSION_MARKER_B,
    mode: "seed"
  });
  await stopRole(roleA);
  await stopRole(roleB);
  if (process.platform === "win32") {
    expect(await injectDuplicateRoleCookieCheckpoint(roleA.id)).toMatchObject({
      duplicateCount: 2,
      roleId: roleA.id
    });
  }

  roleA = await editRoleUrl(
    roleA,
    fixtureUrl(SESSION_FIXTURE_A, "observe", SESSION_MARKER_A)
  );
  roleB = await editRoleUrl(
    roleB,
    fixtureUrl(SESSION_FIXTURE_B, "observe", SESSION_MARKER_B)
  );
  expect(roleA.launchUrl).not.toBe(roleB.launchUrl);
  await shutdownAndWaitForFlush();
}

async function clearRoleDataFromVisibleUi(role: Role): Promise<void> {
  await navigate("/roles");
  const cursor = await rendererEventCursor();
  await clickEntityMenuAction(
    role.id,
    "Click for actions or drag to reorder",
    "Clear saved data"
  );
  await clickDialogButton("Clear data");
  const completionNotice = await $("[role='status']");
  const errorNotice = await $("[role='alert']");
  await browser.waitUntil(
    async () => (await completionNotice.isExisting()) || (await errorNotice.isExisting()),
    {
      interval: 100,
      timeout: 40_000,
      timeoutMsg: `Role browser data clear did not expose a visible terminal for ${role.name}`
    }
  );
  if (await errorNotice.isExisting()) {
    throw new Error(
      `Role browser data clear failed for ${role.name}: ${await errorNotice.getText()}`
    );
  }
  await expect(completionNotice).toHaveText(
    `Saved browser data for "${role.name}" was cleared.`
  );
  await waitForRoleProjection({ afterSequence: cursor, absent: true, roleId: role.id });
  await $(`[data-selection-id='${role.id}'] button[aria-label='Open']`)
    .waitForEnabled({ timeout: 20_000 });
}

async function deleteSessionEntities(game: Game, roles: Role[]): Promise<void> {
  for (const role of roles) {
    await rendererCall("stopRole", role.id).catch(() => undefined);
    await rendererCall("deleteRole", role.id);
  }
  await rendererCall("deleteGame", game.id);
}

async function sessionIsolationPhase(): Promise<void> {
  await bootstrap();
  const game = requireNamed(await rendererCall("listGames"), SESSION_GAME_NAME);
  const roles = await rendererCall("listRoles");
  const roleA = requireNamed(roles, SESSION_ROLE_A_NAME);
  const roleB = requireNamed(roles, SESSION_ROLE_B_NAME);
  expect(roleA.launchUrl).toContain("mode=observe");
  expect(roleB.launchUrl).toContain("mode=observe");

  expectSession(await launchVisibleRole(roleA, SESSION_FIXTURE_A), {
    before: SESSION_MARKER_A,
    marker: SESSION_MARKER_A,
    mode: "observe"
  });
  expectSession(await launchVisibleRole(roleB, SESSION_FIXTURE_B), {
    before: SESSION_MARKER_B,
    marker: SESSION_MARKER_B,
    mode: "observe"
  });

  await clearRoleDataFromVisibleUi(roleA);
  await waitForRoleProjection({ roleId: roleB.id, state: "running" });
  expectSession(await reopenStoppedRoleFromVisiblePlaceholder(roleA, SESSION_FIXTURE_A), {
    before: null,
    marker: SESSION_MARKER_A,
    mode: "observe"
  });

  await stopRole(roleB);
  expectSession(await reopenStoppedRoleFromVisiblePlaceholder(roleB, SESSION_FIXTURE_B), {
    before: SESSION_MARKER_B,
    marker: SESSION_MARKER_B,
    mode: "observe"
  });
  await stopRole(roleA);
  await stopRole(roleB);
  await deleteSessionEntities(game, [roleA, roleB]);
  await shutdownAndWaitForFlush();
}

function requireRuntimeTab(runtime: EmbeddedRuntimeState, sourceId: string): EmbeddedRuntimeTabSummary {
  const tab = runtime.tabs.find((candidate) => candidate.sourceId === sourceId);
  if (!tab) throw new Error(`Runtime tab for source ${sourceId} is unavailable`);
  return tab;
}

function requireRoleSlot(tab: EmbeddedRuntimeTabSummary, roleId: string) {
  const slot = tab.slots.find((candidate) => candidate.roleId === roleId);
  if (!slot) throw new Error(`Runtime role slot ${roleId} is unavailable in tab ${tab.id}`);
  return slot;
}

async function createSharedScenario(): Promise<{
  game: Game;
  roles: [Role, Role, Role];
  workspaces: [LaunchWorkspace, LaunchWorkspace];
}> {
  const origin = requireEnvironment("RION_STUDIO_E2E_FIXTURE_ORIGIN");
  const game = await rendererCall("createGame", {
    defaultLaunchUrl: `${origin}/role/${SHARED_FIXTURE}`,
    name: SHARED_GAME_NAME
  });
  const shared = await rendererCall("createRole", {
    gameId: game.id,
    launchUrl: `${origin}/role/${SHARED_FIXTURE}`,
    name: SHARED_ROLE_NAME
  });
  const uniqueA = await rendererCall("createRole", {
    gameId: game.id,
    launchUrl: `${origin}/role/${UNIQUE_FIXTURE_A}`,
    name: UNIQUE_ROLE_A_NAME
  });
  const uniqueB = await rendererCall("createRole", {
    gameId: game.id,
    launchUrl: `${origin}/role/${UNIQUE_FIXTURE_B}`,
    name: UNIQUE_ROLE_B_NAME
  });
  const workspaceA = await rendererCall("createLaunchWorkspace", {
    name: WORKSPACE_A_NAME,
    slots: [{ roleId: shared.id }, { roleId: uniqueA.id }],
    template: "two_columns"
  });
  const workspaceB = await rendererCall("createLaunchWorkspace", {
    name: WORKSPACE_B_NAME,
    slots: [{ roleId: shared.id }, { roleId: uniqueB.id }],
    template: "two_columns"
  });
  return { game, roles: [shared, uniqueA, uniqueB], workspaces: [workspaceA, workspaceB] };
}

async function launchVisibleWorkspace(
  workspace: LaunchWorkspace,
  fixtureIds: string[],
  roleSlots: Array<{
    ownedByTargetTab?: boolean;
    ownerTabId?: string;
    roleId: string;
    state: "blocked" | "running";
  }>
): Promise<EmbeddedRuntimeState> {
  await navigate("/workspaces");
  const runtimeCursor = await rendererEventCursor();
  const sessionCursor = await fixtureCursor();
  await $(`[data-selection-id='${workspace.id}'] button[aria-label='Open workspace']`).click();
  const waits = fixtureIds.map((roleId) => waitFixtureEvent({
    afterSequence: sessionCursor,
    kind: "session",
    roleId
  }));
  const [runtime] = await Promise.all([
    waitForRuntimeProjection({
      afterSequence: runtimeCursor,
      roleSlots,
      sourceId: workspace.id
    }),
    ...waits
  ]);
  return runtime;
}

function expectOwnedSlot(
  tab: EmbeddedRuntimeTabSummary,
  role: Role,
  ownerTabId: string,
  state: "blocked" | "running"
): void {
  const slot = requireRoleSlot(tab, role.id);
  expect(slot.state).toBe(state);
  expect(slot.owner?.tabId).toBe(ownerTabId);
  if (state === "running") expect(slot.owner?.slotId).toBe(slot.slotId);
}

async function closeWorkspaceTab(
  workspace: LaunchWorkspace,
  ownedRoleIds: string[]
): Promise<EmbeddedRuntimeState> {
  const before = await rendererCall("getEmbeddedRuntimeState");
  const tab = requireRuntimeTab(before, workspace.id);
  let snapshot = await windowSnapshot(tab.windowId);
  if (snapshot.kernel?.selectedTabId !== tab.id) {
    const activationCursor = (await probe()).latestSequence;
    await runtimeUiAction(tab.windowId, {
      action: "activateTab",
      tabId: tab.id,
      windowGeneration: snapshot.windowGeneration
    });
    const activation = await waitEvent({
      afterSequence: activationCursor,
      kind: "runtime-tab-activation-terminal",
      windowId: tab.windowId
    });
    expect(activation.details).toMatchObject({ status: "completed", tabId: tab.id });
    snapshot = await windowSnapshot(tab.windowId);
    expect(snapshot.kernel?.selectedTabId).toBe(tab.id);
  }
  const controlCursor = (await probe()).latestSequence;
  const roleCursor = await rendererEventCursor();
  const closesWindow = snapshot.kernel?.tabs.length === 1;
  await runtimeUiAction(tab.windowId, {
    action: "closeTab",
    tabId: tab.id,
    windowGeneration: snapshot.windowGeneration
  });
  const terminal = await waitEvent({
    afterSequence: controlCursor,
    kind: "runtime-tab-close-terminal",
    windowId: tab.windowId
  });
  expect(terminal.details).toMatchObject({
    error: null,
    status: "completed",
    tabId: tab.id
  });
  await Promise.all(ownedRoleIds.map((roleId) => waitForRoleProjection({
    absent: true,
    afterSequence: roleCursor,
    roleId
  })));
  if (closesWindow) {
    await waitEvent({
      afterSequence: controlCursor,
      kind: "window-destroyed",
      windowId: tab.windowId
    });
  } else {
    const remaining = await windowSnapshot(tab.windowId);
    expect(remaining.kernel?.tabs.some((candidate) => candidate.tabId === tab.id)).toBe(false);
  }
  const after = await rendererCall("getEmbeddedRuntimeState");
  expect(after.tabs.some((candidate) => candidate.sourceId === workspace.id)).toBe(false);
  return after;
}

async function sharedOwnershipPhase(): Promise<void> {
  await bootstrap();
  const scenario = await createSharedScenario();
  const [shared, uniqueA, uniqueB] = scenario.roles;
  const [workspaceA, workspaceB] = scenario.workspaces;

  let runtime = await launchVisibleWorkspace(
    workspaceA,
    [SHARED_FIXTURE, UNIQUE_FIXTURE_A],
    [
      { ownedByTargetTab: true, roleId: shared.id, state: "running" },
      { ownedByTargetTab: true, roleId: uniqueA.id, state: "running" }
    ]
  );
  const tabA = requireRuntimeTab(runtime, workspaceA.id);
  expectOwnedSlot(tabA, shared, tabA.id, "running");
  expectOwnedSlot(tabA, uniqueA, tabA.id, "running");

  runtime = await launchVisibleWorkspace(
    workspaceB,
    [UNIQUE_FIXTURE_B],
    [
      { ownerTabId: tabA.id, roleId: shared.id, state: "blocked" },
      { ownedByTargetTab: true, roleId: uniqueB.id, state: "running" }
    ]
  );
  const tabB = requireRuntimeTab(runtime, workspaceB.id);
  expectOwnedSlot(tabB, shared, tabA.id, "blocked");
  expectOwnedSlot(tabB, uniqueB, tabB.id, "running");
  expectOwnedSlot(requireRuntimeTab(runtime, workspaceA.id), uniqueA, tabA.id, "running");

  const targetBefore = await windowSnapshot(tabB.windowId);
  expect(targetBefore.kernel?.selectedTabId).toBe(tabB.id);
  await waitEvent({
    afterSequence: 0,
    kind: `role-placeholder-ready:${tabB.id}:${shared.id}`,
    windowId: tabB.windowId
  });
  const controlCursor = (await probe()).latestSequence;
  const runtimeCursor = await rendererEventCursor();
  const fixtureAfter = await fixtureCursor();
  await runtimeUiAction(tabB.windowId, {
    action: "pressRoleSlot",
    roleId: shared.id,
    tabId: tabB.id,
    windowGeneration: targetBefore.windowGeneration
  });
  const [claimed] = await Promise.all([
    waitForRuntimeProjection({
      afterSequence: runtimeCursor,
      roleSlots: [
        {
          ownedByTargetTab: true,
          roleId: shared.id,
          state: "running",
          tabId: tabB.id
        },
        {
          ownedByTargetTab: true,
          roleId: uniqueB.id,
          state: "running",
          tabId: tabB.id
        }
      ],
      sourceId: workspaceB.id
    }),
    waitFixtureEvent({
      afterSequence: fixtureAfter,
      kind: "session",
      roleId: SHARED_FIXTURE
    }),
    waitEvent({
      afterSequence: controlCursor,
      kind: "runtime-ui-action-submitted",
      windowId: tabB.windowId
    })
  ]);

  const claimedA = requireRuntimeTab(claimed, workspaceA.id);
  const claimedB = requireRuntimeTab(claimed, workspaceB.id);
  expectOwnedSlot(claimedA, shared, claimedB.id, "blocked");
  expectOwnedSlot(claimedA, uniqueA, claimedA.id, "running");
  expectOwnedSlot(claimedB, shared, claimedB.id, "running");
  expectOwnedSlot(claimedB, uniqueB, claimedB.id, "running");
  expect((await windowSnapshot(tabA.windowId)).kernel?.selectedTabId).toBe(
    tabA.windowId === tabB.windowId ? tabB.id : tabA.id
  );
  expect((await windowSnapshot(tabB.windowId)).kernel?.selectedTabId).toBe(tabB.id);

  const afterClosingA = await closeWorkspaceTab(workspaceA, [uniqueA.id]);
  const survivingB = requireRuntimeTab(afterClosingA, workspaceB.id);
  expectOwnedSlot(survivingB, shared, survivingB.id, "running");
  expectOwnedSlot(survivingB, uniqueB, survivingB.id, "running");
  await closeWorkspaceTab(workspaceB, [shared.id, uniqueB.id]);

  await rendererCall("deleteLaunchWorkspace", workspaceA.id);
  await rendererCall("deleteLaunchWorkspace", workspaceB.id);
  for (const role of scenario.roles) await rendererCall("deleteRole", role.id);
  await rendererCall("deleteGame", scenario.game.id);
  await shutdownAndWaitForFlush();
}

describe("role session isolation and shared workspace ownership journeys", () => {
  it(`runs ${requireEnvironment("RION_STUDIO_E2E_PHASE")} with isolated native stores`, async () => {
    const phase = requireEnvironment("RION_STUDIO_E2E_PHASE");
    if (phase === "p1-role-session-seed") await sessionSeedPhase();
    else if (phase === "p1-role-session-isolation") await sessionIsolationPhase();
    else if (phase === "p1-workspace-shared-role") await sharedOwnershipPhase();
    else throw new Error(`Unknown role isolation phase: ${phase}`);
  });
});
