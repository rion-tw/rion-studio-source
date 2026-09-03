import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const phases = new Set([
  "chromium-app-recovery-seed",
  "chromium-app-recovery-force",
  "chromium-app-recovery-restore"
]);
let seededSessionGeneration;
let forcedSessionGeneration;

export const chromiumAppRecoveryPhaseDependencies = Object.freeze([
  ["chromium-app-recovery-force", ["chromium-app-recovery-seed"]],
  [
    "chromium-app-recovery-restore",
    ["chromium-app-recovery-seed", "chromium-app-recovery-force"]
  ]
]);

export const chromiumAppRecoveryPhaseNamespaces = Object.freeze([
  ["chromium-app-recovery-seed", "chromium-app-recovery-lifecycle"],
  ["chromium-app-recovery-force", "chromium-app-recovery-lifecycle"],
  ["chromium-app-recovery-restore", "chromium-app-recovery-lifecycle"]
]);

export function isChromiumAppRecoveryPhase(phase) {
  return phases.has(phase);
}

function requireEvidence(condition, message) {
  if (!condition) throw new Error(`Chromium app recovery evidence failed: ${message}`);
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function readLifecycle(phaseDirectory) {
  const candidate = JSON.parse(await readFile(
    resolve(dirname(phaseDirectory), "chromium-app-recovery-evidence.json"),
    "utf8"
  ));
  requireEvidence(candidate?.contractVersion === 1, "lifecycle contract is invalid");
  requireEvidence(
    new Set(["macos", "windows"]).has(candidate.platform),
    "lifecycle platform is invalid"
  );
  requireEvidence(typeof candidate.windowId === "string", "window identity is missing");
  requireEvidence(typeof candidate.tabId === "string", "tab identity is missing");
  requireEvidence(typeof candidate.workspaceId === "string", "Workspace identity is missing");
  requireEvidence(
    typeof candidate.roles?.a?.roleId === "string"
      && typeof candidate.roles?.b?.roleId === "string"
      && candidate.roles.a.roleId !== candidate.roles.b.roleId,
    "two exact Role identities are required"
  );
  return candidate;
}

export async function validateChromiumAppRecoveryRuntimeEvidence({
  phase,
  phaseDirectory,
  platform
}) {
  if (!isChromiumAppRecoveryPhase(phase)) return undefined;
  const lifecycle = await readLifecycle(phaseDirectory);
  const observation = JSON.parse(await readFile(
    resolve(phaseDirectory, "chromium-app-recovery-runtime.json"),
    "utf8"
  ));
  requireEvidence(lifecycle.platform === platform, `${phase}: platform drifted`);
  requireEvidence(
    sameValue(observation.lifecycle, lifecycle),
    `${phase}: runtime observation is not bound to lifecycle evidence`
  );
  const expectedHost = platform === "macos" ? "appkit-chromium" : "bundled-chromium";
  const pair = [observation.native?.a, observation.native?.b];
  for (const [index, role] of pair.entries()) {
    const expected = index === 0 ? lifecycle.roles.a : lifecycle.roles.b;
    requireEvidence(role?.roleId === expected.roleId, `${phase}: Role identity drifted`);
    requireEvidence(
      role.latestSessionEnsure?.chromiumPathSha256 === expected.chromiumPathSha256,
      `${phase}: Chromium Session path identity drifted`
    );
    requireEvidence(
      role.currentRuntime?.hostKind === expectedHost
        && role.currentRuntime?.windowId === lifecycle.windowId
        && role.currentRuntime?.tabId === lifecycle.tabId
        && role.currentRuntime?.visible === true
        && Number.isSafeInteger(role.currentRuntime?.parentNativeHostId)
        && role.currentRuntime.parentNativeHostId > 0,
      `${phase}: native Role/window/tab ownership is invalid`
    );
    if (platform === "macos") {
      requireEvidence(
        role.currentRuntime.appKitIdentity?.logicalWindowId === lifecycle.windowId
          && Number.isSafeInteger(role.currentRuntime.appKitIdentity?.nativeGeneration)
          && role.currentRuntime.appKitIdentity.nativeGeneration > 0,
        `${phase}: retained AppKit host identity is missing`
      );
    } else {
      requireEvidence(
        role.currentRuntime.appKitIdentity === null,
        `${phase}: Windows runtime reported an AppKit identity`
      );
    }
  }
  const nativeWindow = observation.native?.gameWindow?.currentRuntime;
  requireEvidence(
    nativeWindow?.hostKind === expectedHost
      && nativeWindow.windowId === lifecycle.windowId
      && nativeWindow.visible === true
      && sameValue(nativeWindow.coreTabIds, [lifecycle.tabId])
      && sameValue(nativeWindow.nativeTabIds, [lifecycle.tabId]),
    `${phase}: native Game Window ownership is not exact`
  );
  return {
    chromiumSessionContinuity: phase !== "chromium-app-recovery-seed",
    hostKind: expectedHost,
    roleIds: [lifecycle.roles.a.roleId, lifecycle.roles.b.roleId],
    tabId: lifecycle.tabId,
    windowId: lifecycle.windowId
  };
}

export async function validateChromiumAppRecoverySqliteEvidence({
  entities,
  phase,
  phaseDirectory,
  settings
}) {
  if (!isChromiumAppRecoveryPhase(phase)) return undefined;
  const lifecycle = await readLifecycle(phaseDirectory);
  const gameWindow = entities.gameWindows.find(({ id }) => id === lifecycle.windowId);
  requireEvidence(gameWindow?.name === "Chromium Recovery Window", `${phase}: window is missing`);
  requireEvidence(gameWindow.payload?.tabs?.length === 1, `${phase}: expected one saved tab`);
  const tab = gameWindow.payload.tabs[0];
  requireEvidence(
    tab.id === lifecycle.tabId
      && tab.sourceId === lifecycle.workspaceId
      && tab.tabType === "workspace",
    `${phase}: saved Workspace tab identity drifted`
  );
  const roleIds = new Set([
    ...(tab.roleSlots ?? []).map(({ roleId }) => roleId),
    ...(tab.workspaceSlots ?? []).flatMap(({ roleId }) => roleId ? [roleId] : [])
  ]);
  requireEvidence(
    roleIds.size === 2
      && roleIds.has(lifecycle.roles.a.roleId)
      && roleIds.has(lifecycle.roles.b.roleId),
    `${phase}: saved tab lost its exact two-Role topology`
  );
  const session = settings.find(({ key }) => key === "runtimeRestoreSession")?.payload;
  requireEvidence(session?.schemaVersion === 2, `${phase}: schema-v2 session is missing`);
  const expectedCleanExit = phase !== "chromium-app-recovery-force";
  requireEvidence(
    session.cleanExit === expectedCleanExit,
    `${phase}: clean-exit state is incorrect`
  );
  requireEvidence(
    sameValue(session.liveWindowIds, [lifecycle.windowId]),
    `${phase}: live recovery cohort is not exact`
  );
  requireEvidence(
    sameValue(session.restoreInProgressWindowIds, []),
    `${phase}: restore-in-progress state was not terminalized`
  );
  requireEvidence(
    session.lastFocusedWindowId === lifecycle.windowId,
    `${phase}: last-focused native window is incorrect`
  );
  requireEvidence(
    Number.isSafeInteger(session.sessionGeneration) && session.sessionGeneration > 0,
    `${phase}: session generation is invalid`
  );
  if (phase === "chromium-app-recovery-seed") {
    seededSessionGeneration = session.sessionGeneration;
  } else if (phase === "chromium-app-recovery-force") {
    requireEvidence(
      Number.isSafeInteger(seededSessionGeneration)
        && session.sessionGeneration > seededSessionGeneration,
      `${phase}: the clean durability seed did not precede the forced session`
    );
    forcedSessionGeneration = session.sessionGeneration;
  } else {
    requireEvidence(
      Number.isSafeInteger(forcedSessionGeneration)
        && session.sessionGeneration > forcedSessionGeneration,
      `${phase}: recovery and clean shutdown did not advance the session generation`
    );
  }
  return {
    cleanExit: session.cleanExit,
    liveWindowIds: session.liveWindowIds,
    roleIds: [...roleIds].sort(),
    sessionGeneration: session.sessionGeneration,
    tabId: lifecycle.tabId,
    windowId: lifecycle.windowId
  };
}
