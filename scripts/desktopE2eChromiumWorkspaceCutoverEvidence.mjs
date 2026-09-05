import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const webOnlyPhases = Object.freeze([
  "chromium-workspace-web-only-seed",
  "chromium-workspace-web-only-restart"
]);
const sharedRolePhase = "chromium-workspace-shared-role";
const recoveryPhase = "chromium-workspaces-recovery";
const phases = Object.freeze([...webOnlyPhases, sharedRolePhase, recoveryPhase]);

export const chromiumWorkspaceCutoverPhaseDependencies = Object.freeze([
  ["chromium-workspace-web-only-restart", ["chromium-workspace-web-only-seed"]]
]);

export const chromiumWorkspaceCutoverPhaseNamespaces = Object.freeze([
  ...webOnlyPhases.map((phase) => [phase, "chromium-workspace-web-only-lifecycle"]),
  [sharedRolePhase, "chromium-workspace-shared-role-lifecycle"],
  [recoveryPhase, "chromium-workspaces-recovery-lifecycle"]
]);

export function isChromiumWorkspaceCutoverPhase(phase) {
  return phases.includes(phase);
}

let webOnlySeedSqliteEvidence;

function exactKeys(candidate, keys) {
  return candidate !== null && typeof candidate === "object" &&
    !Array.isArray(candidate) && Object.keys(candidate).length === keys.length &&
    keys.every((key) => key in candidate);
}

function requireRuntime(condition, message) {
  if (!condition) throw new Error(`Desktop E2E Workspace cutover evidence failed: ${message}`);
}

function requireSqlite(condition, message) {
  if (!condition) throw new Error(`Desktop E2E SQLite evidence failed: ${message}`);
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validBounds(bounds, nonnegativeOrigin = true) {
  return exactKeys(bounds, ["height", "width", "x", "y"]) &&
    [bounds.height, bounds.width, bounds.x, bounds.y].every(Number.isSafeInteger) &&
    bounds.height > 0 && bounds.width > 0 &&
    (!nonnegativeOrigin || bounds.x >= 0 && bounds.y >= 0);
}

function validRect(rect) {
  return exactKeys(rect, ["height", "width", "x", "y"]) &&
    [rect.height, rect.width, rect.x, rect.y]
      .every((value) => typeof value === "number" && Number.isFinite(value)) &&
    rect.height > 0 && rect.width > 0 && rect.x >= 0 && rect.y >= 0 &&
    rect.x + rect.width <= 1.000_001 && rect.y + rect.height <= 1.000_001;
}

function expectedUrl(value, fixtureId) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) &&
      url.pathname === `/role/${fixtureId}`;
  } catch {
    return false;
  }
}

function validAppKitIdentity(identity, observation, platform) {
  if (platform === "windows") return identity === null;
  return exactKeys(identity, [
    "launchGeneration", "logicalWindowId", "nativeGeneration"
  ]) && identity.launchGeneration === observation.attemptGeneration &&
    identity.logicalWindowId === observation.windowId &&
    Number.isSafeInteger(identity.nativeGeneration) && identity.nativeGeneration > 0;
}

function validWebOnlyObservation(observation, platform) {
  if (!exactKeys(observation, [
    "appKitIdentity", "attemptGeneration", "coreSlots", "focused", "hostKind",
    "parentNativeHostId", "phase", "popups", "presentation", "role", "tabId",
    "topologyRevision", "visible", "web", "windowBounds", "windowGeneration",
    "windowId"
  ]) || !Array.isArray(observation.coreSlots) || observation.coreSlots.length !== 1 ||
      !Array.isArray(observation.popups) || observation.popups.length !== 0 ||
      observation.role !== null || observation.presentation !== "normal" ||
      !["activating", "degraded", "ready"].includes(observation.phase) ||
      !validBounds(observation.windowBounds, false) ||
      !Number.isSafeInteger(observation.parentNativeHostId) ||
      observation.parentNativeHostId < 1 ||
      !Number.isSafeInteger(observation.topologyRevision) ||
      observation.topologyRevision < 1 ||
      !Number.isSafeInteger(observation.windowGeneration) ||
      observation.windowGeneration < 1 ||
      observation.hostKind !== (platform === "macos"
        ? "appkit-chromium"
        : "bundled-chromium") ||
      !validAppKitIdentity(observation.appKitIdentity, observation, platform)) {
    return false;
  }
  const slot = observation.coreSlots[0];
  const web = observation.web;
  return exactKeys(slot, ["id", "rect", "roleId", "web"]) &&
    slot.roleId === null && validRect(slot.rect) &&
    exactKeys(slot.web, ["name", "startUrl"]) &&
    slot.web.name === "Chromium Web Only App" &&
    expectedUrl(slot.web.startUrl, "chromium-workspace-web-only") &&
    exactKeys(web, [
      "canGoBack", "canGoForward", "chromeBounds", "chromeShellSession",
      "chromeShellStoragePath", "chromeShellUrl", "chromeVisible", "contentBounds",
      "contentProfilePath", "contentSession", "contentSessionStoragePath",
      "contentUrl", "contentVisible", "containedFullscreen",
      "containedFullscreenRevision", "generation", "isolatedSessions", "slotBounds",
      "slotId", "surfaceId", "tabId", "visible"
    ]) && validBounds(web.chromeBounds) && validBounds(web.contentBounds) &&
    validBounds(web.slotBounds) && web.chromeShellSession ===
      "rion-web-chrome-shell:memory" && web.chromeShellStoragePath === null &&
    web.contentSession === "global-web-persistent" &&
    web.contentSessionStoragePath === web.contentProfilePath &&
    web.contentProfilePath.replaceAll("\\", "/").toLowerCase()
      .endsWith("/web-profiles/global-web/chromium") &&
    web.chromeShellUrl.endsWith("/runtime-web-chrome-electron.html") &&
    (expectedUrl(web.contentUrl, "chromium-workspace-web-only") ||
      observation.phase === "degraded" &&
      web.contentUrl === "http://127.0.0.1:1/rion-navigation-failure") &&
    web.isolatedSessions === true && (
      observation.phase !== "activating" && observation.visible === true &&
        web.visible === true &&
        web.chromeVisible === true && web.contentVisible === true ||
      ["activating", "ready"].includes(observation.phase) &&
        observation.focused === false &&
        observation.visible === false && web.visible === false &&
        web.chromeVisible === false && web.contentVisible === false
    ) &&
    web.containedFullscreen === false && web.containedFullscreenRevision === 0 &&
    web.slotId === slot.id && web.tabId === observation.tabId &&
    web.chromeBounds.x === web.slotBounds.x &&
    web.chromeBounds.y === web.slotBounds.y &&
    web.contentBounds.y === web.chromeBounds.y + web.chromeBounds.height &&
    web.contentBounds.height + web.chromeBounds.height === web.slotBounds.height &&
    web.contentBounds.width === web.slotBounds.width;
}

function validCoreStatus(status, roleId) {
  return exactKeys(status, [
    "automationState", "hostKind", "issueReason", "overlayState", "pageHealth",
    "resolvedEngine", "roleId", "runtimeMode", "state"
  ]) && status.roleId === roleId && status.resolvedEngine === "chromium" &&
    status.runtimeMode === "embedded" && status.state === "running" &&
    ["ready", "unavailable", null].includes(status.automationState) &&
    ["appkit-chromium", "bundled-chromium"].includes(status.hostKind) &&
    ["macro-input-unavailable", "runtime-crashed", "runtime-creation-failed",
      "session-migration-required", "trusted-input-unavailable", null]
      .includes(status.issueReason) &&
    ["ready", "unavailable", null].includes(status.overlayState) &&
    ["healthy", "unresponsive", null].includes(status.pageHealth);
}

function validRoleObservation(observation, platform) {
  if (!exactKeys(observation, [
    "coreOwner", "coreStatus", "nativeOwner", "phase", "placeholders", "roleId"
  ]) || !Array.isArray(observation.placeholders) ||
      !["degraded", "ready"].includes(observation.phase) ||
      !exactKeys(observation.coreOwner, [
        "generation", "roleId", "slotId", "state", "tabId", "windowId"
      ]) || observation.coreOwner.roleId !== observation.roleId ||
      observation.coreOwner.state !== "running" ||
      !Number.isSafeInteger(observation.coreOwner.generation) ||
      observation.coreOwner.generation < 1 ||
      !validCoreStatus(observation.coreStatus, observation.roleId)) return false;
  const native = observation.nativeOwner;
  if (!exactKeys(native, [
    "appKitIdentity", "attemptGeneration", "bounds", "generation", "hostKind",
    "ownerGeneration", "parentNativeHostId", "roleId", "tabId",
    "topologyRevision", "visible", "windowGeneration", "windowId"
  ]) || !validBounds(native.bounds) || !Number.isSafeInteger(native.generation) ||
      native.generation < 1 || native.ownerGeneration !== observation.coreOwner.generation ||
      native.roleId !== observation.roleId || native.tabId !== observation.coreOwner.tabId ||
      native.windowId !== observation.coreOwner.windowId || native.visible !== true ||
      !Number.isSafeInteger(native.parentNativeHostId) || native.parentNativeHostId < 1 ||
      !Number.isSafeInteger(native.topologyRevision) || native.topologyRevision < 1 ||
      !Number.isSafeInteger(native.windowGeneration) || native.windowGeneration < 1 ||
      native.hostKind !== (platform === "macos"
        ? "appkit-chromium"
        : "bundled-chromium") ||
      observation.coreStatus.hostKind !== native.hostKind ||
      !validAppKitIdentity(native.appKitIdentity, native, platform)) return false;
  return observation.placeholders.every((placeholder) =>
    exactKeys(placeholder, [
      "appKitIdentity", "attemptGeneration", "blocked", "bounds", "generation",
      "hostKind", "nativeHostId", "ownerGeneration", "ownerTabName",
      "placeholderId", "roleId", "roleName", "shellSession", "shellStoragePath",
      "shellUrl", "slotId", "tabId", "topologyRevision", "visible",
      "windowGeneration", "windowId"
    ]) && placeholder.blocked === true && validBounds(placeholder.bounds) &&
    placeholder.roleId === observation.roleId &&
    placeholder.ownerGeneration === observation.coreOwner.generation &&
    placeholder.shellSession === "rion-web-chrome-shell:memory" &&
    placeholder.shellStoragePath === null &&
    placeholder.shellUrl.endsWith("/runtime-role-placeholder-electron.html") &&
    placeholder.visible === true && placeholder.tabId !== observation.coreOwner.tabId &&
    placeholder.hostKind === native.hostKind &&
    Number.isSafeInteger(placeholder.nativeHostId) && placeholder.nativeHostId > 0 &&
    validAppKitIdentity(placeholder.appKitIdentity, placeholder, platform)
  );
}

async function readObservations(phaseDirectory, fileName) {
  return JSON.parse(await readFile(resolve(phaseDirectory, fileName), "utf8"));
}

function validateWebOnlyHistory(phase, observations, platform) {
  requireRuntime(
    Array.isArray(observations) && observations.length >= 1 &&
      observations.every((observation) => validWebOnlyObservation(observation, platform)),
    `${phase}: malformed Core/native Web-only history`
  );
  const ready = observations.findIndex(
    (observation) => observation.phase === "ready" && observation.visible
  );
  const degraded = observations.findIndex(
    (observation, index) => index > ready && observation.phase === "degraded"
  );
  const recovered = observations.findIndex(
    (observation, index) => index > degraded && observation.phase === "ready" &&
      observation.visible
  );
  const activating = observations.filter(
    (observation) => observation.phase === "activating"
  );
  const terminal = observations.at(-1);
  if (phase.endsWith("-seed")) {
    requireRuntime(
      ready >= 0 && degraded > ready && recovered > degraded &&
        terminal.phase === "ready" && terminal.visible === true &&
        observations.every((observation, index) =>
          observation.phase !== "activating" ||
          index > degraded && index < recovered &&
          observation.tabId === observations[ready].tabId &&
          observation.web.generation > observations[degraded].web.generation &&
          observation.web.generation === observations[recovered].web.generation &&
          observation.attemptGeneration === observations[recovered].attemptGeneration
        ) && activating.length <= 1 &&
        observations[degraded].tabId === observations[ready].tabId &&
        observations[recovered].tabId === observations[ready].tabId &&
        observations[recovered].web.generation > observations[degraded].web.generation,
      `${phase}: ready/degraded/visible-reopen ordering or generation is incomplete`
    );
  } else {
    requireRuntime(
      ready >= 0 && terminal.phase === "ready" && terminal.visible === true &&
        observations.every((observation) => observation.phase === "ready"),
      `${phase}: restart did not restore the exact ready Web-only tab`
    );
  }
  return {
    contentProfilePath: terminal.web.contentProfilePath,
    hostKind: terminal.hostKind,
    isolatedChromeShell: terminal.web.chromeShellStoragePath === null,
    navigationFailureRecovered: phase.endsWith("-seed"),
    restartVerified: phase.endsWith("-restart"),
    tabId: terminal.tabId,
    windowId: terminal.windowId
  };
}

function validateSharedRoleHistory(phase, observations, platform) {
  requireRuntime(
    Array.isArray(observations) && observations.length >= 2 &&
      observations.every((observation) => validRoleObservation(observation, platform)) &&
      observations.every((observation) => observation.placeholders.length <= 1) &&
      observations[0].placeholders.length === 1 &&
      observations.at(-1).placeholders.length === 1,
    `${phase}: malformed shared-Role placeholder history`
  );
  // Core ownership and the retained-host placeholder are separate ordered
  // projections. A sampled interior revision may therefore have retired the
  // target placeholder before the source placeholder for the new owner is
  // visible. Only that zero-placeholder transfer gap is admissible; both
  // authoritative endpoints still require one exact placeholder.
  const before = observations[0];
  const after = observations.at(-1);
  requireRuntime(
    before.roleId === after.roleId && before.phase === "ready" && after.phase === "ready" &&
      before.coreOwner.tabId !== after.coreOwner.tabId &&
      after.coreOwner.generation > before.coreOwner.generation &&
      after.nativeOwner.generation > before.nativeOwner.generation &&
      before.placeholders[0].tabId === after.coreOwner.tabId &&
      after.placeholders[0].tabId === before.coreOwner.tabId &&
      before.placeholders[0].ownerGeneration === before.coreOwner.generation &&
      after.placeholders[0].ownerGeneration === after.coreOwner.generation,
    `${phase}: terminal Core owner transfer or retained-host placeholder reversal is missing`
  );
  return {
    afterOwnerGeneration: after.coreOwner.generation,
    beforeOwnerGeneration: before.coreOwner.generation,
    hostKind: after.nativeOwner.hostKind,
    roleId: after.roleId,
    targetWindowId: after.coreOwner.windowId
  };
}

function validateRecoveryHistory(phase, observations, platform) {
  requireRuntime(
    Array.isArray(observations) && observations.length >= 6 &&
      observations.every((observation) => validRoleObservation(observation, platform)) &&
      observations.every((observation) => observation.placeholders.length === 0),
    `${phase}: malformed exact Role recovery history`
  );
  const failedIndex = observations.findIndex(
    (observation) => observation.coreStatus.issueReason === "runtime-crashed"
  );
  requireRuntime(failedIndex > 0, `${phase}: no authoritative failing Role was observed`);
  const failed = observations[failedIndex];
  const failedBefore = observations.slice(0, failedIndex).findLast(
    (observation) => observation.roleId === failed.roleId &&
      observation.coreStatus.issueReason === null
  );
  const healthyAfter = observations.slice(failedIndex + 1).find(
    (observation) => observation.roleId !== failed.roleId &&
      observation.coreStatus.issueReason === null &&
      observation.coreStatus.automationState === "ready"
  );
  const healthyBefore = observations.slice(0, failedIndex).findLast(
    (observation) => observation.roleId === healthyAfter?.roleId
  );
  const failedTerminal = observations.findLast(
    (observation) => observation.roleId === failed.roleId
  );
  const healthyTerminal = observations.findLast(
    (observation) => observation.roleId === healthyAfter?.roleId
  );
  requireRuntime(
    failed.phase === "degraded" && failedBefore && healthyBefore && healthyAfter &&
      failed.nativeOwner.generation === failedBefore.nativeOwner.generation &&
      sameValue(failed.coreOwner, failedBefore.coreOwner) &&
      healthyAfter.nativeOwner.generation === healthyBefore.nativeOwner.generation &&
      sameValue(healthyAfter.coreOwner, healthyBefore.coreOwner) &&
      sameValue(healthyAfter.coreStatus, healthyBefore.coreStatus) &&
      failedTerminal.coreStatus.issueReason === null && failedTerminal.phase === "ready" &&
      failedTerminal.nativeOwner.generation > failedBefore.nativeOwner.generation &&
      healthyTerminal.coreStatus.issueReason === null && healthyTerminal.phase === "ready" &&
      healthyTerminal.nativeOwner.generation > healthyBefore.nativeOwner.generation,
    `${phase}: failure isolation, no-auto-recovery, or visible relaunch evidence is incomplete`
  );
  return {
    failedRoleId: failed.roleId,
    failingGenerationAdvancedOnRelaunch: true,
    healthyRoleId: healthyAfter.roleId,
    healthyStatusPreserved: true,
    hostKind: failed.nativeOwner.hostKind,
    visibleCancelTerminal: true
  };
}

export async function validateChromiumWorkspaceCutoverRuntimeEvidence({
  phase,
  phaseDirectory,
  platform
}) {
  if (!isChromiumWorkspaceCutoverPhase(phase)) return undefined;
  if (webOnlyPhases.includes(phase)) {
    return validateWebOnlyHistory(phase, await readObservations(
      phaseDirectory,
      "electron-workspace-web-only-observations.json"
    ), platform);
  }
  const observations = await readObservations(
    phaseDirectory,
    "electron-role-placeholder-observations.json"
  );
  return phase === sharedRolePhase
    ? validateSharedRoleHistory(phase, observations, platform)
    : validateRecoveryHistory(phase, observations, platform);
}

function named(entities, collection, names, phase) {
  const values = entities[collection].filter((entity) => names.includes(entity.name));
  requireSqlite(
    values.length === names.length && new Set(values.map((value) => value.name)).size === names.length,
    `${phase}: exact ${collection} definitions are missing`
  );
  return values;
}

function cleanRestore(settings, phase) {
  const restore = settings.find((setting) => setting.key === "runtimeRestoreSession")?.payload;
  requireSqlite(restore?.cleanExit === true, `${phase}: clean Core/runtime flush is missing`);
  return restore;
}

function validateWebOnlySqlite(phase, entities, settings) {
  const [workspace] = named(
    entities,
    "workspaces",
    ["Chromium Web Only Workspace"],
    phase
  );
  const slots = workspace.payload?.slots;
  requireSqlite(
    Array.isArray(slots) && slots.length === 1 && slots[0].roleId == null &&
      slots[0].web?.name === "Chromium Web Only App" &&
      expectedUrl(slots[0].web?.startUrl, "chromium-workspace-web-only") &&
      validRect(slots[0].rect),
    `${phase}: exact empty-Role Web-only Workspace was not durable`
  );
  requireSqlite(
    entities.roles.every((role) => !role.name.startsWith("Chromium Web Only")),
    `${phase}: Web-only Workspace synthesized a persistent Role`
  );
  cleanRestore(settings, phase);
  const evidence = { slots, workspaceId: workspace.id };
  if (phase.endsWith("-seed")) webOnlySeedSqliteEvidence = evidence;
  else requireSqlite(
    webOnlySeedSqliteEvidence && sameValue(webOnlySeedSqliteEvidence, evidence),
    `${phase}: restart changed the exact Web-only Workspace identity or start URL`
  );
  return {
    cleanExit: true,
    emptyRoleTopology: true,
    restartVerified: phase.endsWith("-restart"),
    workspaceId: workspace.id
  };
}

function validateSharedRoleSqlite(phase, entities, settings) {
  const roles = named(entities, "roles", [
    "Chromium Shared Role",
    "Chromium Shared Workspace A Role",
    "Chromium Shared Workspace B Role"
  ], phase);
  const workspaces = named(entities, "workspaces", [
    "Chromium Shared Workspace A",
    "Chromium Shared Workspace B"
  ], phase);
  const shared = roles.find((role) => role.name === "Chromium Shared Role");
  requireSqlite(workspaces.every((workspace) =>
    workspace.payload?.slots?.length === 2 &&
    workspace.payload.slots.filter((slot) => slot.roleId === shared.id).length === 1
  ), `${phase}: shared Role is not present exactly once in both Workspaces`);
  cleanRestore(settings, phase);
  return {
    cleanExit: true,
    sharedRoleId: shared.id,
    workspaceIds: workspaces.map((workspace) => workspace.id)
  };
}

function validateRecoverySqlite(phase, entities, settings) {
  const roles = named(entities, "roles", [
    "Chromium Workspaces Recovery Healthy",
    "Chromium Workspaces Recovery Failing"
  ], phase);
  const [workspace] = named(
    entities,
    "workspaces",
    ["Chromium Workspaces Recovery"],
    phase
  );
  requireSqlite(
    workspace.payload?.slots?.length === 2 && roles.every((role) =>
      workspace.payload.slots.filter((slot) => slot.roleId === role.id).length === 1
    ) && roles.some((role) => expectedUrl(
      role.payload?.launchUrl,
      "chromium-workspaces-recovery-healthy"
    )) && roles.some((role) => expectedUrl(
      role.payload?.launchUrl,
      "chromium-workspaces-recovery-failing"
    )),
    `${phase}: exact healthy/failing Role Workspace definitions are missing`
  );
  const restore = cleanRestore(settings, phase);
  requireSqlite(
    !Array.isArray(restore.liveWindowIds) || restore.liveWindowIds.length === 0,
    `${phase}: gated relaunch cancellation retained a live Game Window`
  );
  return {
    cancelledLiveWindowCount: restore.liveWindowIds?.length ?? 0,
    cleanExit: true,
    roleIds: roles.map((role) => role.id),
    workspaceId: workspace.id
  };
}

export function validateChromiumWorkspaceCutoverSqliteEvidence(
  phase,
  entities,
  settings
) {
  if (!isChromiumWorkspaceCutoverPhase(phase)) return undefined;
  if (webOnlyPhases.includes(phase)) {
    return validateWebOnlySqlite(phase, entities, settings);
  }
  return phase === sharedRolePhase
    ? validateSharedRoleSqlite(phase, entities, settings)
    : validateRecoverySqlite(phase, entities, settings);
}
