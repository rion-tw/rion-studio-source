import { $, expect } from "@wdio/globals";

import type { GameWindow, LaunchWorkspace, Role } from "../../../src/shared/types";
import {
  detachTerminatedApplicationSession,
  inputDiagnostics,
  probe,
  rendererCall,
  requireEnvironment,
  shutdown,
  waitEvent,
  windowSnapshot
} from "../support/control";
import { expectAppKitTabsFitTitlebar } from "../support/geometry";
import {
  installRendererEventJournal,
  rendererEventCursor,
  waitForCollectionProjection,
  waitForGameWindowProjection,
  waitForRoleProjection,
  waitForRuntimeProjection
} from "../support/renderer-events";
import { waitForTranscriptEvent } from "../support/transcript";
import {
  acceptLegalAndSkipFirstRun,
  clickConfirmation,
  clickEntityMenuAction,
  ensureEnglishUi,
  navigate
} from "../support/ui";

// [journey:WORKSPACES-RECOVERY-002]

const EDITED_ROLE_NAME = "E2E P1 Role Edited";
const COPIED_ROLE_NAME = `${EDITED_ROLE_NAME} Copy`;
const RECOVERY_ROLE_NAME = "E2E P1 Recovery Role";
const EDITED_WORKSPACE_NAME = "E2E P1 Workspace Edited";
const COPIED_WORKSPACE_NAME = `${EDITED_WORKSPACE_NAME} Copy`;
const RECOVERY_WORKSPACE_NAME = "E2E P1 Recovery Workspace";
const EDITED_MACRO_NAME = "E2E P1 Macro Edited";
const COPIED_MACRO_NAME = `${EDITED_MACRO_NAME} Copy`;
const RECOVERY_WINDOW_NAME = "E2E P1 Game Window";
const PRIMARY_FIXTURE_ID = "e2e-smoke-role";
const RECOVERY_FIXTURE_ID = "e2e-p1-recovery-role";

const ROLE_ORDER = [COPIED_ROLE_NAME, EDITED_ROLE_NAME, RECOVERY_ROLE_NAME];
const WORKSPACE_ORDER = [COPIED_WORKSPACE_NAME, EDITED_WORKSPACE_NAME, RECOVERY_WORKSPACE_NAME];

function requireNamed<T extends { name: string }>(items: T[], name: string): T {
  const item = items.find((candidate) => candidate.name === name);
  if (!item) throw new Error(`Required recovery entity ${name} is unavailable`);
  return item;
}

async function fixturePost(path: string, body: unknown): Promise<void> {
  const response = await fetch(`${requireEnvironment("RION_STUDIO_E2E_FIXTURE_ORIGIN")}${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
  if (!response.ok) throw new Error(`Fixture ${path} failed with ${response.status}`);
}

async function waitForFixtureEvent(path: string): Promise<void> {
  const response = await fetch(
    `${requireEnvironment("RION_STUDIO_E2E_FIXTURE_ORIGIN")}${path}`,
    { signal: AbortSignal.timeout(55_000) }
  );
  if (!response.ok) throw new Error(`Fixture event ${path} failed with ${response.status}`);
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

async function stopWindowFromUi(windowId: string): Promise<void> {
  const control = await probe();
  await navigate("/game-windows");
  await clickEntityMenuAction(windowId, "Game window actions", "Stop and close window");
  await waitEvent({
    afterSequence: control.latestSequence,
    kind: "window-destroyed",
    windowId
  });
}

async function verifyPersistedMutations(): Promise<{
  primaryRole: Role;
  recoveryRole: Role;
  recoveryWindow: GameWindow;
  recoveryWorkspace: LaunchWorkspace;
}> {
  const roleSnapshot = await waitForCollectionProjection({
    collection: "roles",
    names: ROLE_ORDER,
    orderedNames: ROLE_ORDER
  });
  const workspaceSnapshot = await waitForCollectionProjection({
    collection: "launchWorkspaces",
    names: WORKSPACE_ORDER,
    orderedNames: WORKSPACE_ORDER
  });
  await waitForCollectionProjection({
    collection: "macros",
    names: [EDITED_MACRO_NAME, COPIED_MACRO_NAME]
  });
  const primaryRole = requireNamed(roleSnapshot.roles, EDITED_ROLE_NAME);
  const recoveryRole = requireNamed(roleSnapshot.roles, RECOVERY_ROLE_NAME);
  const recoveryWorkspace = requireNamed(
    workspaceSnapshot.launchWorkspaces,
    RECOVERY_WORKSPACE_NAME
  );
  const recoveryWindow = requireNamed(
    await waitForGameWindowProjection({ name: RECOVERY_WINDOW_NAME }),
    RECOVERY_WINDOW_NAME
  );
  await navigate("/game-windows");
  await $(`[data-selection-id='${recoveryWindow.id}'] button[aria-label='Show']`).click();
  await waitForRuntimeProjection({ windowId: recoveryWindow.id });
  expect(recoveryWorkspace.slots.some((slot) => slot.roleId === primaryRole.id)).toBe(true);
  expect(recoveryWorkspace.slots.some((slot) => slot.roleId === recoveryRole.id)).toBe(true);
  return { primaryRole, recoveryRole, recoveryWindow, recoveryWorkspace };
}

async function exercisePartialFailureAndManualRestart(
  workspace: LaunchWorkspace,
  primaryRole: Role,
  recoveryRole: Role,
  expectedWindowId: string
): Promise<string> {
  await fixturePost("/api/navigation-failure", {
    enabled: true,
    roleId: RECOVERY_FIXTURE_ID
  });
  const controlCursor = (await probe()).latestSequence;
  await navigate("/workspaces");
  await $(`[data-selection-id='${workspace.id}'] button[aria-label='Open workspace']`).click();
  await waitForFixtureEvent(
    `/api/navigation-failures/${RECOVERY_FIXTURE_ID}/attempted`
  );
  const restartRequired = await waitEvent({
    afterSequence: controlCursor,
    kind: "input-fence-event",
    timeoutMs: 60_000
  });
  expect(restartRequired.details).toMatchObject({
    event: "restart-required",
    roleId: recoveryRole.id
  });
  await waitForRoleProjection({
    roleId: primaryRole.id,
    state: "running"
  });
  await waitForRoleProjection({
    roleId: recoveryRole.id,
    state: "running"
  });
  const runtime = await waitForRuntimeProjection({
    roleIds: [primaryRole.id, recoveryRole.id],
    sourceId: workspace.id
  });
  const runtimeTab = runtime.tabs.find((tab) => tab.sourceId === workspace.id);
  if (!runtimeTab) throw new Error("Recovery workspace runtime tab is unavailable");
  expect(runtimeTab.windowId).toBe(expectedWindowId);
  const degraded = await windowSnapshot(runtimeTab.windowId);
  expectAppKitTabsFitTitlebar(degraded);
  const degradedTab = degraded.kernel?.tabs.find((tab) => tab.sourceId === workspace.id);
  expect(degradedTab?.launchPhase).toBe("degraded");
  const degradedGeneration = degraded.roleSurfaceGenerations[recoveryRole.id];
  expect(degradedGeneration).toBeGreaterThan(0);
  expect((await inputDiagnostics()).roles).toEqual(expect.arrayContaining([
    expect.objectContaining({
      restartRequired: true,
      roleId: recoveryRole.id
    })
  ]));

  await stopWindowFromUi(runtimeTab.windowId);
  await fixturePost("/api/navigation-failure", {
    enabled: false,
    roleId: RECOVERY_FIXTURE_ID
  });
  const restartCursor = await rendererEventCursor();
  await navigate("/workspaces");
  await $(`[data-selection-id='${workspace.id}'] button[aria-label='Open workspace']`).click();
  await waitForRoleProjection({
    afterSequence: restartCursor,
    roleId: recoveryRole.id,
    state: "running"
  });
  const restartedRuntime = await waitForRuntimeProjection({
    afterSequence: restartCursor,
    roleIds: [primaryRole.id, recoveryRole.id],
    sourceId: workspace.id
  });
  const restartedTab = restartedRuntime.tabs.find((tab) => tab.sourceId === workspace.id);
  if (!restartedTab) throw new Error("Manually restarted workspace tab is unavailable");
  const restarted = await windowSnapshot(restartedTab.windowId);
  expectAppKitTabsFitTitlebar(restarted);
  expect(restarted.roleSurfaceGenerations[recoveryRole.id]).toBeGreaterThan(0);
  expect((await inputDiagnostics()).roles).toEqual(expect.arrayContaining([
    expect.objectContaining({
      restartRequired: false,
      roleId: recoveryRole.id
    })
  ]));
  const cleanupCursor = await rendererEventCursor();
  await rendererCall("stopGameWindowTab", restartedTab.id);
  await waitForRuntimeProjection({
    absent: true,
    afterSequence: cleanupCursor,
    sourceId: workspace.id
  });
  return expectedWindowId;
}

async function exerciseLaunchCancellation(
  workspace: LaunchWorkspace,
  primaryRole: Role,
  recoveryRole: Role,
  windowId: string
): Promise<void> {
  await fixturePost("/api/gate", { roleId: PRIMARY_FIXTURE_ID });
  await fixturePost("/api/gate", { roleId: RECOVERY_FIXTURE_ID });
  const cursor = await rendererEventCursor();
  await navigate("/workspaces");
  await $(`[data-selection-id='${workspace.id}'] button[aria-label='Open workspace']`).click();
  await Promise.all([
    waitForFixtureEvent(`/api/gates/${PRIMARY_FIXTURE_ID}/waiting`),
    waitForFixtureEvent(`/api/gates/${RECOVERY_FIXTURE_ID}/waiting`)
  ]);
  const relaunchRuntime = await waitForRuntimeProjection({
    afterSequence: cursor,
    sourceId: workspace.id
  });
  const relaunchTab = relaunchRuntime.tabs.find((tab) => tab.sourceId === workspace.id);
  if (!relaunchTab) throw new Error("Gated workspace relaunch tab is unavailable");
  await stopWindowFromUi(relaunchTab.windowId);
  await waitForRoleProjection({ absent: true, roleId: primaryRole.id });
  await waitForRoleProjection({ absent: true, roleId: recoveryRole.id });
  await waitForRuntimeProjection({ absent: true, sourceId: workspace.id });
  await waitForRuntimeProjection({ absent: true, windowId: relaunchTab.windowId });
  await expect($(`[data-selection-id='${windowId}']`)).toHaveText(
    expect.stringContaining("Not open")
  );
}

async function deleteRecoveryWindow(windowId: string, workspaceId: string): Promise<void> {
  const cursor = await rendererEventCursor();
  await navigate("/game-windows");
  await clickEntityMenuAction(windowId, "Game window actions", "Delete window");
  await clickConfirmation("Delete");
  await waitForGameWindowProjection({ afterSequence: cursor, absent: true, windowId });
  await waitForRuntimeProjection({ absent: true, sourceId: workspaceId });
}

async function createCancellationWindow(): Promise<GameWindow> {
  await navigate("/game-windows");
  const createCursor = await rendererEventCursor();
  await $("button=New game window").click();
  const windows = await waitForGameWindowProjection({
    afterSequence: createCursor,
    tabCount: 0
  });
  const created = windows.find((candidate) => candidate.tabs.length === 0);
  if (!created) throw new Error("Cancellation Game Window was not created through the UI");
  const showCursor = await rendererEventCursor();
  await $(`[data-selection-id='${created.id}'] button[aria-label='Show']`).click();
  await waitForRuntimeProjection({ afterSequence: showCursor, windowId: created.id });
  return created;
}

async function releaseCancellationGates(): Promise<void> {
  await fixturePost("/api/release", { roleId: PRIMARY_FIXTURE_ID });
  await fixturePost("/api/release", { roleId: RECOVERY_FIXTURE_ID });
}

async function recoveryPhase(): Promise<void> {
  await ensureEnglishUi();
  await acceptLegalAndSkipFirstRun();
  await installRendererEventJournal();
  const {
    primaryRole,
    recoveryRole,
    recoveryWindow,
    recoveryWorkspace
  } = await verifyPersistedMutations();
  const windowId = await exercisePartialFailureAndManualRestart(
    recoveryWorkspace,
    primaryRole,
    recoveryRole,
    recoveryWindow.id
  );
  await deleteRecoveryWindow(windowId, recoveryWorkspace.id);
  const cancellationWindow = await createCancellationWindow();
  await exerciseLaunchCancellation(
    recoveryWorkspace,
    primaryRole,
    recoveryRole,
    cancellationWindow.id
  );
  await releaseCancellationGates();
  const retainedWindows = await rendererCall("listGameWindows");
  expect(retainedWindows.some((candidate) => candidate.id === windowId)).toBe(false);
  expect(retainedWindows.some((candidate) => candidate.id === cancellationWindow.id)).toBe(true);
  await shutdownAndWaitForFlush();
}

describe("workspace partial failure and cancellation journey", () => {
  it("keeps one failed role live until a visible manual restart and cancels a gated relaunch", async () => {
    const phase = requireEnvironment("RION_STUDIO_E2E_PHASE");
    if (phase !== "p1-workspace-recovery") {
      throw new Error(`Unknown workspace recovery phase: ${phase}`);
    }
    await recoveryPhase();
  });
});
