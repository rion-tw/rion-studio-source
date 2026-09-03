import { $, browser, expect } from "@wdio/globals";

import type { Role, RoleStatus } from "../../../src/shared/types";
import {
  electronDesktopE2eProbe,
  electronDesktopE2eRetainedV22Precondition,
  electronDesktopE2eRoleSessionMigration,
  electronDesktopE2eRoleSessionRuntime,
  type ElectronDesktopE2eRoleSessionRuntimeInspection,
  type ElectronDesktopE2eRoleSessionMigrationInspection
} from "../support/electron-driver";
import { fixtureCursor, waitFixtureEvent } from "../support/fixture";
import { rendererCall } from "../support/renderer-bridge";
import {
  acceptLegalAndSkipFirstRun,
  clickDialogButton,
  ensureEnglishUi,
  waitForRoute
} from "../support/ui";

// [journey:CHROMIUM-MACOS-APPKIT-ROLE-EXPLICIT-RESET-007]
// [journey:CHROMIUM-WINDOWS-ROLE-EXPLICIT-RESET-007]

const CLEAR_STORAGES = [
  "cookies",
  "filesystem",
  "indexdb",
  "localstorage",
  "shadercache",
  "serviceworkers",
  "cachestorage"
] as const;
const FIXTURE_ROLE_ID = "chromium-explicit-reset";
const GAME_NAME = "Chromium Retained v22 Game";
const ROLE_NAME = "Chromium Retained v22 Role";
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the Chromium explicit-reset journey`);
  return value;
}

async function findRole(): Promise<Role> {
  let role: Role | undefined;
  await browser.waitUntil(async () => {
    role = (await rendererCall("listRoles")).find((candidate) => candidate.name === ROLE_NAME);
    return Boolean(role);
  }, {
    timeout: 15_000,
    timeoutMsg: `Chromium explicit-reset journey did not find ${ROLE_NAME}`
  });
  return role as Role;
}

async function openRolesThroughVisibleNavigation(): Promise<void> {
  const sidebar = await $(".app-main-sidebar");
  await sidebar.waitForDisplayed({ timeout: 20_000 });
  await sidebar.$("button*=Roles").click();
  await waitForRoute("/roles");
}

async function clickVisibleRoleAction(roleId: string, actionLabel: string): Promise<void> {
  const card = await $(`[data-selection-id='${roleId}']`);
  await card.waitForDisplayed({ timeout: 10_000 });
  await card.scrollIntoView({ block: "center", inline: "center" });
  await card.moveTo();
  let trigger;
  for (const label of ["Role actions", "Click for actions or drag to reorder"] as const) {
    const candidate = await card.$(`button[aria-label='${label}']`);
    if (await candidate.isExisting() && await candidate.isDisplayed()) {
      trigger = candidate;
      break;
    }
  }
  if (!trigger) throw new Error(`Role ${roleId} has no visible action trigger`);
  await trigger.moveTo();
  await trigger.waitForDisplayed({ timeout: 10_000 });
  await trigger.waitForClickable({ timeout: 10_000 });
  await trigger.click();
  const menu = await $("[role='menu']");
  await menu.waitForDisplayed({ timeout: 10_000 });
  const action = await menu.$(`.//*[@role='menuitem' and normalize-space(.)='${actionLabel}']`);
  await action.waitForClickable({ timeout: 10_000 });
  await action.click();
}

async function clickVisibleOpen(roleId: string): Promise<void> {
  const card = await $(`[data-selection-id='${roleId}']`);
  await card.waitForDisplayed({ timeout: 10_000 });
  await card.scrollIntoView({ block: "center", inline: "center" });
  await card.moveTo();
  const launch = await card.$("button[aria-label='Open']");
  await launch.moveTo();
  await launch.waitForDisplayed({ timeout: 10_000 });
  await launch.waitForEnabled({ timeout: 20_000 });
  await launch.click();
}

async function waitForRunningRole(roleId: string): Promise<RoleStatus> {
  let status: RoleStatus | undefined;
  await browser.waitUntil(async () => {
    status = (await rendererCall("listRoleStatuses"))
      .find((candidate) => candidate.roleId === roleId);
    return status?.state === "running";
  }, {
    interval: 100,
    timeout: 45_000,
    timeoutMsg: `Role ${roleId} did not visibly reach running state`
  });
  return status as RoleStatus;
}

function expectAtomicV23Ready(
  inspection: ElectronDesktopE2eRoleSessionMigrationInspection,
  platform: "macos" | "windows"
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
    targetRevision: 1
  }));
  expect(Number.isSafeInteger(inspection.journal?.journalRevision)).toBe(true);
  expect(inspection.journal?.journalRevision).toBeGreaterThan(0);
  expect(inspection.journal?.transferId).toMatch(new RegExp(`^${UUID_PATTERN}$`, "u"));
  expect(inspection.journal?.resetReceiptId).toMatch(
    new RegExp(`^role-browser-clear:role-browser-clear-${UUID_PATTERN}$`, "u")
  );
}

function canonicalRfc3339(value: string | null | undefined): string {
  if (typeof value !== "string") {
    throw new Error("The first verified Chromium launch timestamp is missing");
  }
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.valueOf()) || timestamp.toISOString() !== value) {
    throw new Error("The first verified Chromium launch timestamp is not canonical RFC3339");
  }
  return value;
}

async function launchThroughVisibleUi(
  role: Role,
  platform: "macos" | "windows"
): Promise<Readonly<{
  migration: ElectronDesktopE2eRoleSessionMigrationInspection;
  runtime: ElectronDesktopE2eRoleSessionRuntimeInspection;
}>> {
  const afterSequence = await fixtureCursor();
  await clickVisibleOpen(role.id);
  const session = await waitFixtureEvent({
    afterSequence,
    kind: "session",
    roleId: FIXTURE_ROLE_ID
  });
  expect(session.session).toMatchObject({
    after: { cookie: null, localStorage: null },
    before: { cookie: null, localStorage: null },
    marker: FIXTURE_ROLE_ID,
    mode: "observe"
  });
  const status = await waitForRunningRole(role.id);
  expect(status.resolvedEngine).toBe("chromium");
  expect(status.hostKind).toBe(
    required("RION_STUDIO_E2E_RUNTIME_TARGET") === "chromium-v23-macos-appkit"
      ? "appkit-chromium"
      : "bundled-chromium"
  );
  const snapshot = await rendererCall("getAppSnapshot");
  const runtime = await electronDesktopE2eRoleSessionRuntime(role.id);
  const native = runtime.currentRuntime;
  const latestSession = runtime.latestSessionEnsure;
  expect(native).not.toBeNull();
  const tab = snapshot.embeddedRuntimeState.tabs.find((candidate) =>
    candidate.id === native?.tabId
  );
  const window = snapshot.embeddedRuntimeState.windows.find((candidate) =>
    candidate.id === native?.windowId
  );
  expect(runtime.roleId).toBe(role.id);
  expect(latestSession.chromiumUserDataDir).toContain(role.id);
  expect(latestSession.sessionStoragePath).toBe(latestSession.chromiumUserDataDir);
  expect(latestSession.sessionStoragePathSha256).toBe(latestSession.chromiumPathSha256);
  expect(latestSession.ensureCount).toBeGreaterThan(0);
  expect(latestSession.nativeSessionInstance).toBeGreaterThan(0);
  expect(native).toEqual(expect.objectContaining({
    hostKind: status.hostKind,
    visible: true
  }));
  expect(native?.attemptGeneration).toMatch(new RegExp(`^${UUID_PATTERN}$`, "u"));
  expect(native?.generation).toBeGreaterThan(0);
  expect(native?.ownerGeneration).toBeGreaterThan(0);
  expect(native?.parentNativeHostId).toBeGreaterThan(0);
  expect(native?.topologyRevision).toBeGreaterThan(0);
  expect(native?.windowGeneration).toBeGreaterThan(0);
  expect(tab).toEqual(expect.objectContaining({
    active: true,
    hidden: false,
    id: native?.tabId,
    roleIds: [role.id],
    sourceId: role.id,
    type: "role",
    windowId: native?.windowId
  }));
  expect(window).toEqual(expect.objectContaining({
    activeTabId: native?.tabId,
    id: native?.windowId,
    tabCount: 1,
    visible: true,
    windowId: native?.windowId
  }));
  if (platform === "macos") {
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
  return Object.freeze({
    migration: await electronDesktopE2eRoleSessionMigration(role.id),
    runtime
  });
}

async function seedPhase(platform: "macos" | "windows"): Promise<void> {
  const precondition = await electronDesktopE2eRetainedV22Precondition();
  expect(precondition).not.toBeNull();
  expect(precondition).toEqual(expect.objectContaining({
    contractVersion: 1,
    gameName: GAME_NAME,
    platform,
    roleName: ROLE_NAME,
    runtimeContractVersion: 22,
    sourceEngine: platform === "macos" ? "wkwebview" : "webview2"
  }));
  expect(precondition?.launchUrl).toContain(`/${FIXTURE_ROLE_ID}?`);

  await openRolesThroughVisibleNavigation();
  const role = await findRole();
  expect(role.id).toBe(precondition?.roleId);
  expect(role.gameId).toBe(precondition?.gameId);
  expect(role.launchUrl).toBe(precondition?.launchUrl);

  const before = await electronDesktopE2eRoleSessionMigration(role.id);
  expect(before).toEqual({
    journal: null,
    pendingRoleBrowserDataClearOperations: 0,
    receipt: null,
    roleExists: true,
    roleId: role.id
  });

  await clickVisibleOpen(role.id);
  const launchError = await $("[role='alert']");
  await launchError.waitForDisplayed({ timeout: 15_000 });
  expect(await launchError.getText()).toContain(
    "The bundled Chromium runtime cannot satisfy this launch because SessionMigrationRequired."
  );
  expect((await rendererCall("getAppSnapshot")).embeddedRuntimeState.windows).toEqual([]);
  expect(await electronDesktopE2eRoleSessionMigration(role.id)).toEqual(before);

  await clickVisibleRoleAction(role.id, "Clear saved data");
  await clickDialogButton("Clear data");
  const completion = await $("[role='status']");
  await completion.waitForDisplayed({ timeout: 40_000 });
  await expect(completion).toHaveText(`Saved browser data for "${ROLE_NAME}" was cleared.`);

  const after = await electronDesktopE2eRoleSessionMigration(role.id);
  expectAtomicV23Ready(after, platform);
  expect(after.journal?.firstVerifiedLaunchAt).toBeNull();
  expect(after.receipt).toEqual({
    clearedStorages: CLEAR_STORAGES,
    cookieReadbackCount: 0,
    evidence: "electron-clear-storage-data-promise-and-cookie-readback",
    operationId: after.receipt?.operationId,
    roleId: role.id
  });
  expect(after.receipt?.operationId).toMatch(new RegExp(`^${UUID_PATTERN}$`, "u"));
  expect(after.journal?.cleanFlushReceiptId)
    .toBe(`chromium-session-clear:${after.receipt?.operationId}`);

  const afterLaunch = await launchThroughVisibleUi(role, platform);
  expectAtomicV23Ready(afterLaunch.migration, platform);
  expect(afterLaunch.migration.journal?.journalRevision)
    .toBe((after.journal?.journalRevision ?? 0) + 1);
  canonicalRfc3339(afterLaunch.migration.journal?.firstVerifiedLaunchAt);
}

async function restartPhase(platform: "macos" | "windows"): Promise<void> {
  expect(await electronDesktopE2eRetainedV22Precondition()).toBeNull();
  await openRolesThroughVisibleNavigation();
  const role = await findRole();
  const inspection = await electronDesktopE2eRoleSessionMigration(role.id);
  expectAtomicV23Ready(inspection, platform);
  const firstVerifiedLaunchAt = canonicalRfc3339(
    inspection.journal?.firstVerifiedLaunchAt
  );
  const journalRevision = inspection.journal?.journalRevision;
  expect(inspection.receipt).toBeNull();
  expect(inspection.journal?.cleanFlushReceiptId)
    .toMatch(new RegExp(`^chromium-session-clear:${UUID_PATTERN}$`, "u"));
  const afterRestartLaunch = await launchThroughVisibleUi(role, platform);
  expectAtomicV23Ready(afterRestartLaunch.migration, platform);
  expect(afterRestartLaunch.migration.journal?.journalRevision).toBe(journalRevision);
  expect(afterRestartLaunch.migration.journal?.firstVerifiedLaunchAt)
    .toBe(firstVerifiedLaunchAt);
}

describe("Chromium retained-v22 Role explicit reset", () => {
  it("blocks launch, clears through visible UI, and preserves v23Ready across restart", async () => {
    const probe = await electronDesktopE2eProbe();
    expect(probe.runtimeTarget).toBe(required("RION_STUDIO_E2E_RUNTIME_TARGET"));
    await ensureEnglishUi();
    await acceptLegalAndSkipFirstRun();

    const phase = required("RION_STUDIO_E2E_PHASE");
    if (phase === "chromium-role-session-reset-seed") await seedPhase(probe.platform);
    else if (phase === "chromium-role-session-reset-restart") {
      await restartPhase(probe.platform);
    } else throw new Error(`Unexpected Chromium explicit-reset phase ${phase}`);
  });
});
