import { $, browser, expect } from "@wdio/globals";

import type { AppSnapshot, Game, LaunchWorkspace, Macro, Role } from "../../../src/shared/types";
import {
  detachTerminatedApplicationSession,
  probe,
  rendererCall,
  requireEnvironment,
  shutdown,
  waitEvent
} from "../support/control";
import {
  installRendererEventJournal,
  rendererEventCursor,
  waitForCollectionProjection,
  waitForGameWindowProjection,
  waitForRuntimeProjection
} from "../support/renderer-events";
import { waitForTranscriptEvent } from "../support/transcript";
import {
  acceptLegalAndSkipFirstRun,
  clickConfirmation,
  clickDialogButton,
  clickEntityMenuAction,
  dragEntityTo,
  ensureEnglishUi,
  navigate,
  selectEntityItems,
  setEditorTitle,
  submitEditor
} from "../support/ui";

// [journey:APP-FULL-CRUD-001]
// [journey:APP-CRUD-REORDER-002]
// [journey:APP-QUIT-GUARD-002]

const PRIMARY_GAME_NAME = "E2E Smoke Game Edited";
const PRIMARY_ROLE_NAME = "E2E Smoke Role";
const EDITED_ROLE_NAME = "E2E P1 Role Edited";
const COPIED_ROLE_NAME = `${EDITED_ROLE_NAME} Copy`;
const RECOVERY_ROLE_NAME = "E2E P1 Recovery Role";
const PRIMARY_WORKSPACE_NAME = "E2E Smoke Workspace";
const EDITED_WORKSPACE_NAME = "E2E P1 Workspace Edited";
const COPIED_WORKSPACE_NAME = `${EDITED_WORKSPACE_NAME} Copy`;
const RECOVERY_WORKSPACE_NAME = "E2E P1 Recovery Workspace";
const PRIMARY_MACRO_NAME = "E2E Smoke Macro";
const EDITED_MACRO_NAME = "E2E P1 Macro Edited";
const COPIED_MACRO_NAME = `${EDITED_MACRO_NAME} Copy`;
const UNUSED_GAME_NAME = "E2E P1 Unused Game";
const RECOVERY_GAME_NAME = "E2E P1 Recovery Game";
const UNSAVED_GAME_NAME = "E2E P1 Unsaved Game";
const RECOVERY_WINDOW_NAME = "E2E P1 Game Window";
const RECOVERY_FIXTURE_ID = "e2e-p1-recovery-role";

const ROLE_ORDER = [COPIED_ROLE_NAME, EDITED_ROLE_NAME, RECOVERY_ROLE_NAME];
const WORKSPACE_ORDER = [COPIED_WORKSPACE_NAME, EDITED_WORKSPACE_NAME, RECOVERY_WORKSPACE_NAME];

function requireNamed<T extends { name: string }>(items: T[], name: string): T {
  const item = items.find((candidate) => candidate.name === name);
  if (!item) throw new Error(`Required P1 entity ${name} is unavailable`);
  return item;
}

async function waitForFinalFlush(transcriptPath: string, requestedAfter: string): Promise<void> {
  const event = await waitForTranscriptEvent(
    transcriptPath,
    (candidate) => candidate.kind === "application-final-flush-complete"
      && candidate.timestamp >= requestedAfter
  );
  expect((event.details as { complete?: boolean }).complete).toBe(true);
}

async function shutdownAndWaitForFlush(): Promise<void> {
  const control = await probe();
  const requestedAfter = new Date().toISOString();
  await shutdown().catch(() => undefined);
  await waitForFinalFlush(control.transcriptPath, requestedAfter);
  detachTerminatedApplicationSession();
}

async function preparePhase(): Promise<void> {
  await ensureEnglishUi();
  await acceptLegalAndSkipFirstRun();
  await installRendererEventJournal();
}

async function editNamedEntity(
  routePrefix: "macros" | "roles" | "workspaces",
  entityId: string,
  nextName: string,
  collection: "launchWorkspaces" | "macros" | "roles"
): Promise<void> {
  await navigate(`/${routePrefix}/${entityId}/edit`);
  await setEditorTitle(nextName);
  await submitEditor(`/${routePrefix}`);
  await waitForCollectionProjection({ collection, names: [nextName] });
}

async function createGame(name: string, fixtureId: string): Promise<Game> {
  await navigate("/games/new");
  await setEditorTitle(name);
  await $("#game-launch-url").setValue(
    `${requireEnvironment("RION_STUDIO_E2E_FIXTURE_ORIGIN")}/role/${fixtureId}`
  );
  await submitEditor("/games");
  const snapshot = await waitForCollectionProjection({ collection: "games", names: [name] });
  return requireNamed(snapshot.games, name);
}

async function createRole(name: string, game: Game): Promise<Role> {
  await navigate(`/roles/new?gameId=${game.id}`);
  await setEditorTitle(name);
  await submitEditor("/roles");
  const snapshot = await waitForCollectionProjection({ collection: "roles", names: [name] });
  return requireNamed(snapshot.roles, name);
}

async function duplicateRole(role: Role): Promise<Role> {
  await navigate("/roles");
  await clickEntityMenuAction(
    role.id,
    "Click for actions or drag to reorder",
    "Duplicate"
  );
  const snapshot = await waitForCollectionProjection({
    collection: "roles",
    names: [COPIED_ROLE_NAME]
  });
  return requireNamed(snapshot.roles, COPIED_ROLE_NAME);
}

async function createRecoveryWorkspace(primaryRole: Role, recoveryRole: Role): Promise<LaunchWorkspace> {
  await navigate("/workspaces/new");
  await setEditorTitle(RECOVERY_WORKSPACE_NAME);
  await $("[data-workspace-layout-option='two_columns']").click();
  await $(`[data-workspace-role-id='${primaryRole.id}']`).click();
  await $("[data-workspace-slot-index='1']").click();
  await $(`[data-workspace-role-id='${recoveryRole.id}']`).click();
  await submitEditor("/workspaces");
  const snapshot = await waitForCollectionProjection({
    collection: "launchWorkspaces",
    names: [RECOVERY_WORKSPACE_NAME]
  });
  return requireNamed(snapshot.launchWorkspaces, RECOVERY_WORKSPACE_NAME);
}

async function duplicateWorkspace(workspace: LaunchWorkspace): Promise<LaunchWorkspace> {
  await navigate("/workspaces");
  await clickEntityMenuAction(
    workspace.id,
    "Click for actions or drag to reorder",
    "Duplicate"
  );
  const snapshot = await waitForCollectionProjection({
    collection: "launchWorkspaces",
    names: [COPIED_WORKSPACE_NAME]
  });
  return requireNamed(snapshot.launchWorkspaces, COPIED_WORKSPACE_NAME);
}

async function duplicateMacro(macro: Macro): Promise<Macro> {
  await navigate("/macros");
  await clickEntityMenuAction(macro.id, "Macro actions", "Duplicate");
  const snapshot = await waitForCollectionProjection({
    collection: "macros",
    names: [COPIED_MACRO_NAME]
  });
  return requireNamed(snapshot.macros, COPIED_MACRO_NAME);
}

async function reorderRoles(source: Role, target: Role): Promise<void> {
  await navigate("/roles");
  const cursor = await rendererEventCursor();
  await dragEntityTo(source.id, target.id, "Click for actions or drag to reorder");
  await waitForCollectionProjection({
    afterSequence: cursor,
    collection: "roles",
    orderedNames: ROLE_ORDER
  });
}

async function reorderWorkspaces(source: LaunchWorkspace, target: LaunchWorkspace): Promise<void> {
  await navigate("/workspaces");
  const cursor = await rendererEventCursor();
  await dragEntityTo(source.id, target.id, "Click for actions or drag to reorder");
  await waitForCollectionProjection({
    afterSequence: cursor,
    collection: "launchWorkspaces",
    orderedNames: WORKSPACE_ORDER
  });
}

async function createRecoveryGameWindow(): Promise<void> {
  await navigate("/game-windows");
  const createCursor = await rendererEventCursor();
  await $("button=New game window").click();
  const createdWindows = await waitForGameWindowProjection({
    afterSequence: createCursor,
    tabCount: 0
  });
  const created = createdWindows[0];
  if (!created) throw new Error("P1 Game Window was not created through the UI");

  const renameCursor = await rendererEventCursor();
  await clickEntityMenuAction(created.id, "Game window actions", "Rename");
  await $("#rename-game-window-name").setValue(RECOVERY_WINDOW_NAME);
  await (await $("dialog[open]")).$("button=Save").click();
  await waitForGameWindowProjection({
    afterSequence: renameCursor,
    name: RECOVERY_WINDOW_NAME,
    windowId: created.id
  });

  const showCursor = await rendererEventCursor();
  await $(`[data-selection-id='${created.id}'] button[aria-label='Show']`).click();
  await waitForRuntimeProjection({
    afterSequence: showCursor,
    windowId: created.id
  });
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

  await editNamedEntity("roles", primaryRole.id, EDITED_ROLE_NAME, "roles");
  await editNamedEntity(
    "workspaces",
    primaryWorkspace.id,
    EDITED_WORKSPACE_NAME,
    "launchWorkspaces"
  );
  await editNamedEntity("macros", primaryMacro.id, EDITED_MACRO_NAME, "macros");

  await createGame(UNUSED_GAME_NAME, "e2e-p1-unused-role");
  const recoveryGame = await createGame(RECOVERY_GAME_NAME, RECOVERY_FIXTURE_ID);
  const recoveryRole = await createRole(RECOVERY_ROLE_NAME, recoveryGame);
  const editedRole = requireNamed(await rendererCall("listRoles"), EDITED_ROLE_NAME);
  const copiedRole = await duplicateRole(editedRole);
  const recoveryWorkspace = await createRecoveryWorkspace(editedRole, recoveryRole);
  const editedWorkspace = requireNamed(
    await rendererCall("listLaunchWorkspaces"),
    EDITED_WORKSPACE_NAME
  );
  const copiedWorkspace = await duplicateWorkspace(editedWorkspace);
  const editedMacro = requireNamed(await rendererCall("listMacros"), EDITED_MACRO_NAME);
  await duplicateMacro(editedMacro);

  await reorderRoles(copiedRole, editedRole);
  await reorderWorkspaces(copiedWorkspace, editedWorkspace);
  await createRecoveryGameWindow();
  expect(primaryGame.defaultLaunchUrl).toContain("e2e-smoke-role");
  expect(recoveryWorkspace.slots.filter((slot) => slot.roleId).length).toBe(2);
  await shutdownAndWaitForFlush();
}

async function confirmBulkDelete(
  route: string,
  ids: readonly string[],
  collection: "games" | "launchWorkspaces" | "macros" | "roles",
  absentNames: string[]
): Promise<AppSnapshot> {
  await navigate(route);
  await selectEntityItems(ids);
  await $(`button=Delete ${ids.length}`).click();
  await clickConfirmation("Delete");
  return waitForCollectionProjection({ absentNames, collection });
}

async function cleanupPersistedEntities(): Promise<void> {
  const gameWindows = await rendererCall("listGameWindows");
  if (gameWindows.length > 0) {
    await navigate("/game-windows");
    for (const gameWindow of gameWindows) {
      const showAfterSequence = (await probe()).latestSequence;
      await $(`[data-selection-id='${gameWindow.id}'] button[aria-label='Show']`).click();
      await waitEvent({
        afterSequence: showAfterSequence,
        kind: "window-context-initialized",
        windowId: gameWindow.id
      });
      await waitForRuntimeProjection({ windowId: gameWindow.id });
      const cursor = await rendererEventCursor();
      const deleteAfterSequence = (await probe()).latestSequence;
      await clickEntityMenuAction(gameWindow.id, "Game window actions", "Delete window");
      await clickConfirmation("Delete");
      await waitEvent({
        afterSequence: deleteAfterSequence,
        kind: "window-destroyed",
        windowId: gameWindow.id
      });
      await waitForGameWindowProjection({
        afterSequence: cursor,
        absent: true,
        windowId: gameWindow.id
      });
    }
    expect(await rendererCall("listGameWindows")).toHaveLength(0);
  }

  const macros = await rendererCall("listMacros");
  const macroIds = [EDITED_MACRO_NAME, COPIED_MACRO_NAME]
    .map((name) => requireNamed(macros, name).id);
  await navigate("/macros");
  await selectEntityItems(macroIds);
  await $("button=Delete 2").click();
  await clickConfirmation("Cancel");
  expect((await rendererCall("listMacros")).filter((macro) => macroIds.includes(macro.id))).toHaveLength(2);
  await $("button=Delete 2").click();
  await clickConfirmation("Delete");
  await waitForCollectionProjection({
    absentNames: [EDITED_MACRO_NAME, COPIED_MACRO_NAME],
    collection: "macros"
  });

  const games = await rendererCall("listGames");
  const primaryGame = requireNamed(games, PRIMARY_GAME_NAME);
  const recoveryGame = requireNamed(games, RECOVERY_GAME_NAME);
  const unusedGame = requireNamed(games, UNUSED_GAME_NAME);
  await navigate("/games");
  await selectEntityItems([primaryGame.id, recoveryGame.id, unusedGame.id]);
  await $("button=Delete 3").click();
  await clickConfirmation("Delete");
  await waitForCollectionProjection({
    absentNames: [UNUSED_GAME_NAME],
    collection: "games",
    names: [PRIMARY_GAME_NAME, RECOVERY_GAME_NAME]
  });
  const partialNotice = await $("[role='status']");
  await expect(partialNotice).toHaveText(expect.stringContaining("Deleted 1; skipped 2."));
  await expect(partialNotice).toHaveText(expect.stringContaining("2 in use"));

  const workspaces = await rendererCall("listLaunchWorkspaces");
  await confirmBulkDelete(
    "/workspaces",
    WORKSPACE_ORDER.map((name) => requireNamed(workspaces, name).id),
    "launchWorkspaces",
    WORKSPACE_ORDER
  );

  const roles = await rendererCall("listRoles");
  await confirmBulkDelete(
    "/roles",
    ROLE_ORDER.map((name) => requireNamed(roles, name).id),
    "roles",
    ROLE_ORDER
  );

  const retainedGames = await rendererCall("listGames");
  await confirmBulkDelete(
    "/games",
    [PRIMARY_GAME_NAME, RECOVERY_GAME_NAME]
      .map((name) => requireNamed(retainedGames, name).id),
    "games",
    [PRIMARY_GAME_NAME, RECOVERY_GAME_NAME]
  );
}

async function exerciseUnsavedQuitGuard(): Promise<void> {
  await navigate("/games/new");
  await setEditorTitle(UNSAVED_GAME_NAME);
  const control = await probe();

  await shutdown(false);
  await clickDialogButton("Keep editing");
  expect(await $("#app-editor-form [role='textbox'][contenteditable]").getText()).toBe(UNSAVED_GAME_NAME);
  expect(await browser.execute(() => window.location.hash)).toContain("/games/new");

  const requestedAfter = new Date().toISOString();
  await shutdown(false);
  const dialog = await $("dialog[open]");
  await dialog.waitForExist({ timeout: 10_000 });
  await dialog.$("button=Discard changes").click().catch(() => undefined);
  await waitForFinalFlush(control.transcriptPath, requestedAfter);
  detachTerminatedApplicationSession();
}

async function guardCleanupPhase(): Promise<void> {
  await preparePhase();
  await cleanupPersistedEntities();
  await exerciseUnsavedQuitGuard();
}

async function finalRestartPhase(): Promise<void> {
  await preparePhase();
  const snapshot = await rendererCall("getAppSnapshot");
  for (const entities of [
    snapshot.games,
    snapshot.roles,
    snapshot.launchWorkspaces,
    snapshot.macros
  ]) {
    expect(entities.some((entity) => entity.name.startsWith("E2E "))).toBe(false);
  }
  expect(snapshot.gameWindows).toHaveLength(0);
  expect(snapshot.games.some((game) => game.name === UNSAVED_GAME_NAME)).toBe(false);
  await shutdownAndWaitForFlush();
}

describe("full desktop P1 UI journeys", () => {
  it(`runs ${requireEnvironment("RION_STUDIO_E2E_PHASE")} through visible user actions`, async () => {
    const phase = requireEnvironment("RION_STUDIO_E2E_PHASE");
    if (phase === "p1-mutations") await mutationPhase();
    else if (phase === "p1-guard-cleanup") await guardCleanupPhase();
    else if (phase === "p1-final-restart") await finalRestartPhase();
    else throw new Error(`Unknown full desktop P1 phase: ${phase}`);
  });
});
