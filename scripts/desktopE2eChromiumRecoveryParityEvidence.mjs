import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const mixedPhases = new Set([
  "chromium-mixed-recovery-seed",
  "chromium-mixed-recovery-force",
  "chromium-mixed-recovery-restore"
]);
const windowPhases = new Set([
  "chromium-window-recovery-seed",
  "chromium-window-recovery-force",
  "chromium-window-recovery-restore-force",
  "chromium-window-recovery-discard",
  "chromium-window-recovery-final-show"
]);
const generations = new Map();

export const chromiumRecoveryParityPhaseDependencies = Object.freeze([
  ["chromium-mixed-recovery-force", ["chromium-mixed-recovery-seed"]],
  ["chromium-mixed-recovery-restore", [
    "chromium-mixed-recovery-seed",
    "chromium-mixed-recovery-force"
  ]],
  ["chromium-window-recovery-force", ["chromium-window-recovery-seed"]],
  ["chromium-window-recovery-restore-force", [
    "chromium-window-recovery-seed",
    "chromium-window-recovery-force"
  ]],
  ["chromium-window-recovery-discard", [
    "chromium-window-recovery-seed",
    "chromium-window-recovery-force",
    "chromium-window-recovery-restore-force"
  ]],
  ["chromium-window-recovery-final-show", [
    "chromium-window-recovery-seed",
    "chromium-window-recovery-force",
    "chromium-window-recovery-restore-force",
    "chromium-window-recovery-discard"
  ]]
]);

export const chromiumRecoveryParityPhaseNamespaces = Object.freeze([
  ...[...mixedPhases].map((phase) => [phase, "chromium-mixed-recovery-lifecycle"]),
  ...[...windowPhases].map((phase) => [phase, "chromium-window-recovery-lifecycle"])
]);

export function isChromiumRecoveryParityPhase(phase) {
  return mixedPhases.has(phase) || windowPhases.has(phase);
}

function requireEvidence(condition, message) {
  if (!condition) throw new Error(`Chromium recovery parity evidence failed: ${message}`);
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function expectedHost(platform) {
  return platform === "macos" ? "appkit-chromium" : "bundled-chromium";
}

function requireNativeHost(runtime, platform, windowId, label) {
  requireEvidence(runtime?.hostKind === expectedHost(platform), `${label}: host kind drifted`);
  requireEvidence(runtime.windowId === windowId, `${label}: window identity drifted`);
  requireEvidence(
    Number.isSafeInteger(runtime.parentNativeHostId) && runtime.parentNativeHostId > 0,
    `${label}: parent native host is missing`
  );
  if (platform === "macos") {
    requireEvidence(
      runtime.appKitIdentity?.logicalWindowId === windowId
        && Number.isSafeInteger(runtime.appKitIdentity?.nativeGeneration)
        && runtime.appKitIdentity.nativeGeneration > 0,
      `${label}: retained AppKit identity is missing`
    );
  } else {
    requireEvidence(runtime.appKitIdentity === null, `${label}: Windows reported AppKit`);
  }
}

async function readLifecycle(phaseDirectory, basename) {
  const lifecycle = JSON.parse(await readFile(
    resolve(dirname(phaseDirectory), basename),
    "utf8"
  ));
  requireEvidence(lifecycle?.contractVersion === 1, `${basename}: invalid contract`);
  requireEvidence(new Set(["macos", "windows"]).has(lifecycle.platform),
    `${basename}: invalid platform`);
  return lifecycle;
}

async function readRuntime(phaseDirectory, basename) {
  return JSON.parse(await readFile(resolve(phaseDirectory, basename), "utf8"));
}

async function validateMixedRuntime({ phase, phaseDirectory, platform }) {
  const lifecycle = await readLifecycle(
    phaseDirectory,
    "chromium-mixed-recovery-evidence.json"
  );
  const observation = await readRuntime(
    phaseDirectory,
    "chromium-mixed-recovery-runtime.json"
  );
  requireEvidence(lifecycle.platform === platform, `${phase}: platform drifted`);
  requireEvidence(same(observation.lifecycle, lifecycle), `${phase}: lifecycle drifted`);
  const { gameWindow, roleTab, roleWorkspace, web } = observation.native ?? {};
  requireNativeHost(roleTab?.currentRuntime, platform, lifecycle.windowId, `${phase}: Role tab`);
  requireNativeHost(
    roleWorkspace?.currentRuntime,
    platform,
    lifecycle.windowId,
    `${phase}: Workspace Role`
  );
  requireEvidence(roleTab.currentRuntime.tabId === lifecycle.roleTab.tabId,
    `${phase}: Role tab identity drifted`);
  requireEvidence(roleWorkspace.currentRuntime.tabId === lifecycle.workspace.tabId,
    `${phase}: Workspace tab identity drifted`);
  requireEvidence(
    roleTab.latestSessionEnsure.chromiumPathSha256 === lifecycle.roleTab.chromiumPathSha256
      && roleWorkspace.latestSessionEnsure.chromiumPathSha256 ===
        lifecycle.roleWorkspace.chromiumPathSha256,
    `${phase}: isolated Role Session path drifted`
  );
  requireEvidence(
    roleTab.latestSessionEnsure.chromiumPathSha256 !==
      roleWorkspace.latestSessionEnsure.chromiumPathSha256,
    `${phase}: Role Sessions are not isolated`
  );
  requireNativeHost(web, platform, lifecycle.windowId, `${phase}: Workspace Web`);
  requireEvidence(
    web.tabId === lifecycle.workspace.tabId
      && web.web?.slotId === lifecycle.web.slotId
      && web.web?.contentSession === "global-web-persistent"
      && web.web?.chromeShellSession === "rion-web-chrome-shell:memory"
      && web.web?.isolatedSessions === true,
    `${phase}: Workspace Web Session ownership drifted`
  );
  requireNativeHost(
    gameWindow?.currentRuntime,
    platform,
    lifecycle.windowId,
    `${phase}: Game Window`
  );
  const tabIds = [lifecycle.roleTab.tabId, lifecycle.workspace.tabId];
  requireEvidence(
    same(gameWindow.currentRuntime.coreTabIds, tabIds)
      && same(gameWindow.currentRuntime.nativeTabIds, tabIds),
    `${phase}: Core/native mixed tab topology drifted`
  );
  return {
    globalWebSessionContinuity: phase !== "chromium-mixed-recovery-seed",
    hostKind: expectedHost(platform),
    roleIds: [lifecycle.roleTab.roleId, lifecycle.roleWorkspace.roleId],
    tabIds,
    windowIds: [lifecycle.windowId]
  };
}

async function validateWindowRuntime({ phase, phaseDirectory, platform }) {
  const lifecycle = await readLifecycle(
    phaseDirectory,
    "chromium-window-recovery-evidence.json"
  );
  const observation = await readRuntime(
    phaseDirectory,
    "chromium-window-recovery-runtime.json"
  );
  requireEvidence(lifecycle.platform === platform, `${phase}: platform drifted`);
  requireEvidence(same(observation.lifecycle, lifecycle), `${phase}: lifecycle drifted`);
  if (phase === "chromium-window-recovery-discard") {
    requireEvidence(observation.mode === "discarded", `${phase}: discarded mode is missing`);
    requireEvidence(
      same(observation.native, { roles: [], windows: [] }),
      `${phase}: discarded native cohort is not empty`
    );
  } else {
    requireEvidence(observation.mode === "live", `${phase}: live mode is missing`);
    for (const [index, window] of lifecycle.windows.entries()) {
      const native = observation.native?.windows?.[index]?.currentRuntime;
      requireNativeHost(native, platform, window.windowId, `${phase}: Window ${index}`);
      requireEvidence(
        same(native.coreTabIds, window.tabIds) && same(native.nativeTabIds, window.tabIds),
        `${phase}: Window ${index} tab topology drifted`
      );
    }
    for (const [index, role] of lifecycle.roles.entries()) {
      const native = observation.native?.roles?.[index];
      requireNativeHost(native?.currentRuntime, platform, role.windowId, `${phase}: Role ${index}`);
      requireEvidence(native.currentRuntime.tabId === role.tabId,
        `${phase}: Role ${index} tab identity drifted`);
      requireEvidence(native.latestSessionEnsure.chromiumPathSha256 === role.chromiumPathSha256,
        `${phase}: Role ${index} Session path drifted`);
    }
  }
  return {
    chromiumSessionContinuity: phase !== "chromium-window-recovery-seed",
    hostKind: expectedHost(platform),
    roleIds: lifecycle.roles.map(({ roleId }) => roleId),
    tabIds: lifecycle.windows.flatMap(({ tabIds }) => tabIds),
    windowIds: lifecycle.windows.map(({ windowId }) => windowId)
  };
}

export async function validateChromiumRecoveryParityRuntimeEvidence(input) {
  if (mixedPhases.has(input.phase)) return validateMixedRuntime(input);
  if (windowPhases.has(input.phase)) return validateWindowRuntime(input);
  return undefined;
}

function requireSessionJournal(session, phase, expected) {
  requireEvidence(session?.schemaVersion === 2, `${phase}: schema-v2 journal is missing`);
  requireEvidence(session.cleanExit === expected.cleanExit, `${phase}: cleanExit drifted`);
  requireEvidence(same(session.liveWindowIds, expected.liveWindowIds),
    `${phase}: live cohort drifted`);
  requireEvidence(same(session.restoreInProgressWindowIds, []),
    `${phase}: restore-in-progress cohort did not terminalize`);
  requireEvidence(session.lastFocusedWindowId === expected.lastFocusedWindowId,
    `${phase}: last-focused identity drifted`);
  requireEvidence(Number.isSafeInteger(session.sessionGeneration) && session.sessionGeneration > 0,
    `${phase}: invalid session generation`);
  const namespace = mixedPhases.has(phase) ? "mixed" : "window";
  const previous = generations.get(namespace);
  requireEvidence(previous === undefined || session.sessionGeneration > previous,
    `${phase}: session generation did not advance`);
  generations.set(namespace, session.sessionGeneration);
}

async function validateMixedSqlite({ entities, phase, phaseDirectory, settings }) {
  const lifecycle = await readLifecycle(
    phaseDirectory,
    "chromium-mixed-recovery-evidence.json"
  );
  const gameWindow = entities.gameWindows.find(({ id }) => id === lifecycle.windowId);
  requireEvidence(gameWindow?.name === "Chromium Mixed Recovery Window",
    `${phase}: saved Game Window is missing`);
  requireEvidence(gameWindow.payload.activeTabId === lifecycle.workspace.tabId,
    `${phase}: active Workspace tab drifted`);
  requireEvidence(gameWindow.payload.tabs?.length === 2, `${phase}: expected two mixed tabs`);
  const roleTab = gameWindow.payload.tabs.find(({ id }) => id === lifecycle.roleTab.tabId);
  const workspaceTab = gameWindow.payload.tabs.find(({ id }) => id === lifecycle.workspace.tabId);
  requireEvidence(
    roleTab?.tabType === "role" && roleTab.sourceId === lifecycle.roleTab.roleId,
    `${phase}: exact Role tab is missing`
  );
  requireEvidence(
    workspaceTab?.tabType === "workspace"
      && workspaceTab.sourceId === lifecycle.workspace.id
      && workspaceTab.workspaceSlots?.some(({ roleId }) =>
        roleId === lifecycle.roleWorkspace.roleId)
      && workspaceTab.workspaceSlots?.some(({ id, web }) =>
        id === lifecycle.web.slotId && web?.name === "Chromium Mixed Recovery Web"),
    `${phase}: exact Workspace Role/Web topology is missing`
  );
  const session = settings.find(({ key }) => key === "runtimeRestoreSession")?.payload;
  requireSessionJournal(session, phase, {
    cleanExit: phase !== "chromium-mixed-recovery-force",
    lastFocusedWindowId: lifecycle.windowId,
    liveWindowIds: [lifecycle.windowId]
  });
  return {
    cleanExit: session.cleanExit,
    liveWindowIds: session.liveWindowIds,
    sessionGeneration: session.sessionGeneration,
    tabIds: [lifecycle.roleTab.tabId, lifecycle.workspace.tabId],
    windowIds: [lifecycle.windowId]
  };
}

async function validateWindowSqlite({ entities, phase, phaseDirectory, settings }) {
  const lifecycle = await readLifecycle(
    phaseDirectory,
    "chromium-window-recovery-evidence.json"
  );
  for (const window of lifecycle.windows) {
    const saved = entities.gameWindows.find(({ id }) => id === window.windowId);
    requireEvidence(saved?.name === window.name, `${phase}: saved Window ${window.name} missing`);
    requireEvidence(saved.payload.activeTabId === window.activeTabId,
      `${phase}: Window ${window.name} active tab drifted`);
    requireEvidence(same(saved.payload.tabs?.map(({ id }) => id), window.tabIds),
      `${phase}: Window ${window.name} exact tab topology drifted`);
  }
  const session = settings.find(({ key }) => key === "runtimeRestoreSession")?.payload;
  const dormant = phase === "chromium-window-recovery-discard";
  const liveWindowIds = dormant ? [] : lifecycle.windows.map(({ windowId }) => windowId);
  requireSessionJournal(session, phase, {
    cleanExit: !new Set([
      "chromium-window-recovery-force",
      "chromium-window-recovery-restore-force"
    ]).has(phase),
    lastFocusedWindowId: dormant ? null : lifecycle.windows.at(-1).windowId,
    liveWindowIds
  });
  return {
    cleanExit: session.cleanExit,
    liveWindowIds: session.liveWindowIds,
    sessionGeneration: session.sessionGeneration,
    tabIds: lifecycle.windows.flatMap(({ tabIds }) => tabIds),
    windowIds: lifecycle.windows.map(({ windowId }) => windowId)
  };
}

export async function validateChromiumRecoveryParitySqliteEvidence(input) {
  if (mixedPhases.has(input.phase)) return validateMixedSqlite(input);
  if (windowPhases.has(input.phase)) return validateWindowSqlite(input);
  return undefined;
}
