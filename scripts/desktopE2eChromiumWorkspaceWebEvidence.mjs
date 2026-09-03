import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const phases = Object.freeze([
  "chromium-workspace-web-slot-seed",
  "chromium-workspace-web-slot-restart"
]);

export const chromiumWorkspaceWebPhaseDependencies = Object.freeze([
  [
    "chromium-workspace-web-slot-seed",
    ["chromium-entity-persistence-seed", "chromium-entity-persistence-restart"]
  ],
  [
    "chromium-workspace-web-slot-restart",
    [
      "chromium-entity-persistence-seed",
      "chromium-entity-persistence-restart",
      "chromium-workspace-web-slot-seed"
    ]
  ]
]);

export const chromiumWorkspaceWebPhaseNamespaces = Object.freeze(
  phases.map((phase) => [phase, "chromium-entity-persistence-lifecycle"])
);

export function isChromiumWorkspaceWebPhase(phase) {
  return phases.includes(phase);
}

let seedSqliteEvidence;

function exactKeys(candidate, keys) {
  return candidate !== null && typeof candidate === "object" &&
    !Array.isArray(candidate) && Object.keys(candidate).length === keys.length &&
    keys.every((key) => key in candidate);
}

function requireRuntime(condition, message) {
  if (!condition) throw new Error(`Desktop E2E Workspace Web evidence failed: ${message}`);
}

function requireSqlite(condition, message) {
  if (!condition) throw new Error(`Desktop E2E SQLite evidence failed: ${message}`);
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function canonicalRestartSlots(slots) {
  return slots.map((slot) => ({
    ...slot,
    rect: Object.fromEntries(Object.entries(slot.rect).map(([key, value]) => [
      key,
      Math.round(value * 1e12) / 1e12
    ]))
  }));
}

function validBounds(bounds) {
  return exactKeys(bounds, ["height", "width", "x", "y"]) &&
    [bounds.height, bounds.width, bounds.x, bounds.y].every(Number.isSafeInteger) &&
    bounds.height > 0 && bounds.width > 0 && bounds.x >= 0 && bounds.y >= 0;
}

function validNativeBounds(bounds) {
  return exactKeys(bounds, ["height", "width", "x", "y"]) &&
    [bounds.height, bounds.width, bounds.x, bounds.y].every(Number.isSafeInteger) &&
    bounds.height > 0 && bounds.width > 0;
}

function validRect(rect) {
  return exactKeys(rect, ["height", "width", "x", "y"]) &&
    [rect.height, rect.width, rect.x, rect.y]
      .every((value) => typeof value === "number" && Number.isFinite(value)) &&
    rect.height > 0 && rect.width > 0 && rect.x >= 0 && rect.y >= 0 &&
    rect.x + rect.width <= 1.000_001 && rect.y + rect.height <= 1.000_001;
}

function expectedWebUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) &&
      url.pathname === "/role/chromium-workspace-web-slot" &&
      url.searchParams.get("mode") === "seed" &&
      url.searchParams.get("marker") === "chromium-workspace-web-slot-marker";
  } catch {
    return false;
  }
}

function validObservation(observation, platform) {
  if (!exactKeys(observation, [
    "appKitIdentity", "attemptGeneration", "coreSlots", "focused", "hostKind",
    "parentNativeHostId", "phase", "popups", "presentation", "role", "tabId",
    "topologyRevision", "visible", "web", "windowBounds", "windowGeneration",
    "windowId"
  ]) || !Array.isArray(observation.coreSlots) || observation.coreSlots.length !== 2 ||
      !Array.isArray(observation.popups) || observation.popups.length !== 0 ||
      observation.presentation !== "normal" || !validNativeBounds(observation.windowBounds) ||
      !Number.isSafeInteger(observation.parentNativeHostId) ||
      observation.parentNativeHostId < 1 ||
      !Number.isSafeInteger(observation.topologyRevision) ||
      observation.topologyRevision < 1 ||
      !Number.isSafeInteger(observation.windowGeneration) ||
      observation.windowGeneration < 1 || observation.visible !== true ||
      observation.hostKind !== (platform === "macos"
        ? "appkit-chromium"
        : "bundled-chromium") || observation.phase !== "ready") {
    return false;
  }
  const webSlots = observation.coreSlots.filter((slot) =>
    exactKeys(slot, ["id", "rect", "roleId", "web"]) && slot.web !== null &&
    validRect(slot.rect) && expectedWebUrl(slot.web?.startUrl)
  );
  const roleSlots = observation.coreSlots.filter((slot) =>
    exactKeys(slot, ["id", "rect", "roleId", "web"]) &&
    typeof slot.roleId === "string" && slot.web === null && validRect(slot.rect)
  );
  const web = observation.web;
  if (webSlots.length !== 1 || roleSlots.length !== 1 || !exactKeys(web, [
    "canGoBack", "canGoForward", "chromeBounds", "chromeShellSession",
    "chromeShellStoragePath", "chromeShellUrl", "chromeVisible", "contentBounds",
    "contentVisible",
    "contentProfilePath", "contentSession", "contentSessionStoragePath",
    "contentUrl", "containedFullscreen", "containedFullscreenRevision",
    "generation", "isolatedSessions", "slotBounds", "slotId", "surfaceId",
    "tabId", "visible"
  ]) || !validBounds(web.chromeBounds) || !validBounds(web.contentBounds) ||
      !validBounds(web.slotBounds) || web.chromeShellSession !==
        "rion-web-chrome-shell:memory" || web.chromeShellStoragePath !== null ||
      web.contentSession !== "global-web-persistent" ||
      web.contentSessionStoragePath !== web.contentProfilePath ||
      !web.contentProfilePath.replaceAll("\\", "/").toLowerCase()
        .endsWith("/web-profiles/global-web/chromium") ||
      !web.chromeShellUrl.endsWith("/runtime-web-chrome-electron.html") ||
      !expectedWebUrl(web.contentUrl) || web.isolatedSessions !== true ||
      web.visible !== true || web.chromeVisible !== true ||
      web.contentVisible !== true || web.containedFullscreen !== false ||
      web.containedFullscreenRevision !== 0 || web.slotId !== webSlots[0].id ||
      web.tabId !== observation.tabId ||
      web.chromeBounds.x !== web.slotBounds.x ||
      web.chromeBounds.y !== web.slotBounds.y ||
      web.contentBounds.y !== web.chromeBounds.y + web.chromeBounds.height ||
      web.contentBounds.height + web.chromeBounds.height !== web.slotBounds.height ||
      web.contentBounds.width !== web.slotBounds.width) {
    return false;
  }
  if (!exactKeys(observation.role, [
    "bounds", "generation", "roleId", "visible"
  ]) || !validBounds(observation.role.bounds) ||
      observation.role.roleId !== roleSlots[0].roleId ||
      !Number.isSafeInteger(observation.role.generation) ||
      observation.role.generation < 1 || observation.role.visible !== true) {
    return false;
  }
  return platform === "macos"
    ? exactKeys(observation.appKitIdentity, [
        "launchGeneration", "logicalWindowId", "nativeGeneration"
      ]) && observation.appKitIdentity.launchGeneration === observation.attemptGeneration &&
      observation.appKitIdentity.logicalWindowId === observation.windowId &&
      Number.isSafeInteger(observation.appKitIdentity.nativeGeneration) &&
      observation.appKitIdentity.nativeGeneration > 0
    : observation.appKitIdentity === null;
}

export async function validateChromiumWorkspaceWebRuntimeEvidence({
  phase,
  phaseDirectory,
  platform
}) {
  if (!isChromiumWorkspaceWebPhase(phase)) return undefined;
  const observations = JSON.parse(await readFile(resolve(
    phaseDirectory,
    "electron-workspace-web-runtime-observations.json"
  ), "utf8"));
  requireRuntime(
    Array.isArray(observations) && observations.length >= 1 &&
      observations.every((observation) => validObservation(observation, platform)),
    `${phase}: malformed Core/native paired-Web observation history`
  );
  const first = observations[0];
  const terminal = observations.at(-1);
  requireRuntime(
    observations.every((observation) =>
      observation.windowId === first.windowId &&
      observation.windowGeneration === first.windowGeneration
    ) && observations.every((observation, index) => index === 0 ||
      observation.topologyRevision >= observations[index - 1].topologyRevision),
    `${phase}: native window identity or Core topology moved backwards`
  );
  const terminalWebSlot = terminal.coreSlots.find((slot) => slot.web !== null);
  if (phase === "chromium-workspace-web-slot-seed") {
    const initialWebSlot = first.coreSlots.find((slot) => slot.web !== null);
    requireRuntime(
      observations.length >= 2 &&
        terminal.topologyRevision > first.topologyRevision &&
        terminalWebSlot.rect.width > initialWebSlot.rect.width + 0.03 &&
        terminal.web.slotBounds.width > first.web.slotBounds.width + 20,
      `${phase}: real native pointer drag did not advance durable Core/native layout`
    );
  } else {
    requireRuntime(
      terminalWebSlot.rect.width > 0.53,
      `${phase}: restart lost the persisted resized Web slot`
    );
  }
  return {
    contentProfilePath: terminal.web.contentProfilePath,
    hostKind: terminal.hostKind,
    isolatedChromeShell: terminal.web.chromeShellStoragePath === null,
    resizedWebWidth: terminalWebSlot.rect.width,
    restartVerified: phase === "chromium-workspace-web-slot-restart",
    windowId: terminal.windowId
  };
}

export function validateChromiumWorkspaceWebSqliteEvidence(phase, entities, settings) {
  const workspaces = entities.workspaces.filter(
    (workspace) => workspace.name === "Chromium Workspace Web Slot"
  );
  const windows = entities.gameWindows.filter(
    (window) => window.name === "Chromium Workspace Web Window"
  );
  const roles = entities.roles.filter((role) => role.name === "Chromium Entity Role Edited");
  requireSqlite(workspaces.length === 1, `${phase}: exact mixed Workspace is missing`);
  requireSqlite(windows.length === 1, `${phase}: exact saved Game Window is missing`);
  requireSqlite(roles.length === 1, `${phase}: dependency Role is missing`);
  const workspace = workspaces[0];
  const slots = workspace.payload?.slots;
  const templateWebSlots = slots?.filter((slot) => expectedWebUrl(slot.web?.startUrl)) ?? [];
  const templateRoleSlots = slots?.filter((slot) => slot.roleId === roles[0].id) ?? [];
  requireSqlite(
    slots?.length === 2 && templateWebSlots.length === 1 &&
      templateRoleSlots.length === 1 &&
      templateWebSlots[0].web.name === "Chromium Workspace Web fixture" &&
      validRect(templateWebSlots[0].rect) &&
      Math.abs(templateWebSlots[0].rect.width - 0.5) < 1e-12 &&
      validRect(templateRoleSlots[0].rect) &&
      Math.abs(templateRoleSlots[0].rect.width - 0.5) < 1e-12,
    `${phase}: mixed Web App + Role Workspace template or configured start URL was not durable`
  );
  const gameWindow = windows[0];
  const workspaceTabs = gameWindow.payload?.tabs?.filter((tab) =>
    tab.tabType === "workspace" && tab.sourceId === workspace.id
  ) ?? [];
  const workspaceTab = workspaceTabs[0];
  const persistedSlots = workspaceTab?.workspaceSlots;
  const persistedWebSlots = persistedSlots?.filter(
    (slot) => expectedWebUrl(slot.web?.startUrl)
  ) ?? [];
  const persistedRoleSlots = persistedSlots?.filter(
    (slot) => slot.roleId === roles[0].id
  ) ?? [];
  requireSqlite(
    gameWindow.payload?.tabs?.length === 1 && workspaceTabs.length === 1 &&
      gameWindow.payload.activeTabId === workspaceTab.id &&
      persistedSlots?.length === 2 && persistedWebSlots.length === 1 &&
      persistedRoleSlots.length === 1 &&
      persistedWebSlots[0].web.name === "Chromium Workspace Web fixture" &&
      validRect(persistedWebSlots[0].rect) &&
      persistedWebSlots[0].rect.width > 0.53 &&
      validRect(persistedRoleSlots[0].rect) &&
      sameValue(workspaceTab.roleSlots, [{
        rect: persistedRoleSlots[0].rect,
        roleId: roles[0].id,
        slotId: persistedRoleSlots[0].id
      }]),
    `${phase}: resized mixed layout was not durable in the saved Game Window snapshot`
  );
  const cleanExit = settings.find(
    (setting) => setting.key === "runtimeRestoreSession"
  )?.payload?.cleanExit;
  requireSqlite(cleanExit === true, `${phase}: Core/runtime clean-exit snapshot is missing`);
  const evidence = {
    gameWindowId: gameWindow.id,
    roleId: roles[0].id,
    persistedSlots: canonicalRestartSlots(persistedSlots),
    tabId: workspaceTab.id,
    templateSlots: canonicalRestartSlots(slots),
    workspaceId: workspace.id
  };
  if (phase === "chromium-workspace-web-slot-seed") {
    seedSqliteEvidence = evidence;
  } else {
    requireSqlite(
      seedSqliteEvidence !== undefined && sameValue(seedSqliteEvidence, evidence),
      `${phase}: restart changed the exact persisted Workspace identity or layout`
    );
  }
  return {
    cleanExit,
    gameWindowId: gameWindow.id,
    resizedWebWidth: persistedWebSlots[0].rect.width,
    restartVerified: phase === "chromium-workspace-web-slot-restart",
    workspaceId: workspace.id
  };
}
