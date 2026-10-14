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

function requireMixedPlacement(candidate, lifecycle, label) {
  requireEvidence(lifecycle.placement?.presentation === "maximized" &&
    candidate?.presentation === "maximized" && same(candidate, lifecycle.placement),
  `${label}: saved maximized placement or normal bounds drifted`);
  const bounds = candidate.normalBounds;
  requireEvidence(bounds && [bounds.x, bounds.y, bounds.width, bounds.height]
    .every(Number.isSafeInteger) && bounds.width > 0 && bounds.height > 0,
  `${label}: saved normal bounds are invalid`);
}

function canonicalMixedSlots(slots) {
  return slots?.map(({ id, rect, roleId, web }) => ({ id, rect,
    roleId: roleId ?? null, web: web ?? null }));
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
  const { gameWindow, roleTab, roleWorkspace, web, toolbar } = observation.native ?? {};
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
  requireMixedPlacement(observation.saved?.placement, lifecycle, phase);
  requireEvidence(observation.saved?.id === lifecycle.windowId &&
    observation.saved?.activeTabId === lifecycle.workspace.tabId &&
    observation.runtimeState?.activeTabId === lifecycle.workspace.tabId &&
    observation.runtimeState?.visible === true && observation.runtimeState?.projectionPending === false &&
    same(observation.runtimeState?.restoreInProgressWindowIds, []),
  `${phase}: populated restore did not reach its exact terminal cohort`);
  requireEvidence(gameWindow.currentRuntime.nativeDisplay?.presentation === "maximized" &&
    web.presentation === "maximized" && toolbar?.presentation === "maximized" &&
    toolbar.windowId === lifecycle.windowId &&
    toolbar.windowGeneration === gameWindow.currentRuntime.windowGeneration &&
    toolbar.topologyRevision === gameWindow.currentRuntime.topologyRevision &&
    same(toolbar.tabIds, tabIds),
  `${phase}: native populated maximize or ownership fence drifted`);
  requireEvidence(Array.isArray(lifecycle.workspace.slots) && lifecycle.workspace.slots.length === 2 &&
    lifecycle.workspace.slots.every(({ rect }) => rect &&
      [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) &&
      rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0 &&
      rect.x + rect.width <= 1.000_001 && rect.y + rect.height <= 1.000_001) &&
    same(web.coreSlots, lifecycle.workspace.slots) &&
    same(toolbar.workspaceTabs?.find(({ tabId }) => tabId === lifecycle.workspace.tabId)?.slots,
      lifecycle.workspace.slots),
  `${phase}: normalized Workspace slot layout drifted`);
  const activation = observation.viewportActivation;
  const activeRoleToolbar = activation?.roleTab?.toolbar;
  const activeRoleSurface = activeRoleToolbar?.surfaces?.find(({ id }) => id === lifecycle.roleTab.roleId);
  const visibleReceipt = (event, afterSequence, fixtureId) =>
    event?.kind === "visibility" && event.hidden === false && event.roleId === fixtureId &&
    Number.isSafeInteger(afterSequence) && afterSequence >= 0 &&
    Number.isSafeInteger(event.sequence) && event.sequence > afterSequence;
  requireEvidence(activation?.roleTab?.activeTabId === lifecycle.roleTab.tabId &&
    activeRoleToolbar?.windowId === lifecycle.windowId && activeRoleToolbar.presentation === "maximized" &&
    Number.isSafeInteger(activeRoleToolbar.windowGeneration) && activeRoleToolbar.windowGeneration > 0 &&
    Number.isSafeInteger(activeRoleToolbar.topologyRevision) && activeRoleToolbar.topologyRevision > 0 &&
    activeRoleToolbar.native?.windowGeneration === activeRoleToolbar.windowGeneration &&
    activeRoleToolbar.native?.topologyRevision === activeRoleToolbar.topologyRevision &&
    activeRoleSurface?.tabId === lifecycle.roleTab.tabId && activeRoleSurface.visible === true &&
    visibleReceipt(activation.roleTab.visibilityEvent, activation.roleTab.afterSequence,
      "chromium-mixed-recovery-role-tab") &&
    activation.workspace?.activeTabId === lifecycle.workspace.tabId &&
    web.role?.visible === true && web.web?.visible === true &&
    visibleReceipt(activation.workspace.visibilityEvents?.roleWorkspace, activation.workspace.afterSequence,
      "chromium-mixed-recovery-role-workspace") &&
    visibleReceipt(activation.workspace.visibilityEvents?.web, activation.workspace.afterSequence,
      "chromium-mixed-recovery-web"),
  `${phase}: document viewport was not read after its exact visible native tab activation`);
  const bounds = {
    roleTab: activeRoleSurface?.bounds,
    roleWorkspace: web.role?.roleId === lifecycle.roleWorkspace.roleId ? web.role.bounds : null,
    web: web.web?.contentBounds
  };
  for (const [name, expected] of Object.entries(bounds)) {
    const viewport = observation.viewports?.[name];
    requireEvidence(expected && Number.isSafeInteger(expected.width) && expected.width > 0 &&
      Number.isSafeInteger(expected.height) && expected.height > 0 &&
      viewport?.visibility === "visible" && viewport.renderFrames === 2 &&
      viewport.width === expected.width && viewport.height === expected.height,
    `${phase}: ${name} document viewport does not match its native surface`);
  }
  requireEvidence(web.web.slotBounds?.height ===
    web.web.chromeBounds?.height + web.web.contentBounds.height,
  `${phase}: Workspace Web chrome/content viewport layout drifted`);
  if (phase === "chromium-mixed-recovery-restore" && platform === "windows") {
    const background = await readRuntime(phaseDirectory, "mixed-restored-background-native.json");
    const owner = background.gameWindow?.currentRuntime;
    const launcher = background.launcherFocus;
    requireEvidence(owner?.windowId === lifecycle.windowId && owner.visible === true &&
      owner.focused === false && owner.nativeDisplay?.presentation === "maximized" &&
      owner.windowGeneration === gameWindow.currentRuntime.windowGeneration &&
      owner.parentNativeHostId === gameWindow.currentRuntime.parentNativeHostId &&
      launcher?.launcherFocused === true && launcher.runtimeNativeFocused === false &&
      launcher.focusedNativeHostId === launcher.launcherNativeHostId &&
      Number.isSafeInteger(launcher.launcherNativeHostId) && launcher.launcherNativeHostId > 0 &&
      launcher.launcherNativeHostId !== owner.parentNativeHostId &&
      launcher.nativeForeground?.launcher?.parentWasForeground === true &&
      launcher.nativeForeground?.launcher?.parentVisible === true &&
      launcher.nativeForeground?.launcher?.parentMinimized === false &&
      launcher.nativeForeground?.runtime?.parentWasForeground === false &&
      launcher.nativeForeground?.runtime?.parentVisible === true &&
      launcher.nativeForeground?.runtime?.parentMinimized === false,
    `${phase}: background native maximize reclaimed the launcher's focus`);
  }
  return {
    globalWebSessionContinuity: phase !== "chromium-mixed-recovery-seed",
    hostKind: expectedHost(platform),
    roleIds: [lifecycle.roleTab.roleId, lifecycle.roleWorkspace.roleId],
    savedPresentation: "maximized",
    savedNormalBounds: lifecycle.placement.normalBounds,
    populatedDocumentViewportsVerified: true,
    normalizedWorkspaceSlotsVerified: true,
    backgroundRestoreFocusNeutralityVerified: phase === "chromium-mixed-recovery-restore" && platform === "windows",
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
  requireMixedPlacement(gameWindow.payload?.placement, lifecycle, phase);
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
        id === lifecycle.web.slotId && web?.lastUrl?.includes(lifecycle.web.marker)),
    `${phase}: exact Workspace Role/Web topology is missing`
  );
  requireEvidence(same(canonicalMixedSlots(workspaceTab.workspaceSlots), lifecycle.workspace.slots),
    `${phase}: saved normalized Workspace slot layout drifted`);
  const session = settings.find(({ key }) => key === "runtimeRestoreSession")?.payload;
  requireSessionJournal(session, phase, {
    cleanExit: phase !== "chromium-mixed-recovery-force",
    lastFocusedWindowId: lifecycle.windowId,
    liveWindowIds: [lifecycle.windowId]
  });
  return {
    cleanExit: session.cleanExit,
    savedPresentation: gameWindow.payload.placement.presentation,
    savedNormalBounds: gameWindow.payload.placement.normalBounds,
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
  const liveWindowIds = dormant
    ? []
    : lifecycle.windows.map(({ windowId }) => windowId).sort();
  requireSessionJournal(session, phase, {
    cleanExit: !new Set([
      "chromium-window-recovery-force",
      "chromium-window-recovery-restore-force"
    ]).has(phase),
    lastFocusedWindowId: dormant ? undefined : lifecycle.windows.at(-1).windowId,
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
