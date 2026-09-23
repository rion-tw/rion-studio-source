import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const phases = Object.freeze([
  "chromium-fullscreen-toolbar-seed",
  "chromium-fullscreen-toolbar-restart"
]);

export const chromiumFullscreenToolbarPhaseDependencies = Object.freeze([
  [
    "chromium-fullscreen-toolbar-seed",
    ["chromium-entity-persistence-seed", "chromium-entity-persistence-restart"]
  ],
  [
    "chromium-fullscreen-toolbar-restart",
    [
      "chromium-entity-persistence-seed",
      "chromium-entity-persistence-restart",
      "chromium-fullscreen-toolbar-seed"
    ]
  ]
]);

export const chromiumFullscreenToolbarPhaseNamespaces = Object.freeze(
  phases.map((phase) => [phase, "chromium-entity-persistence-lifecycle"])
);

export function isChromiumFullscreenToolbarPhase(phase) {
  return phases.includes(phase);
}

function requireRuntime(condition, message) {
  if (!condition) {
    throw new Error(`Desktop E2E fullscreen-toolbar evidence failed: ${message}`);
  }
}

function exactKeys(candidate, keys) {
  return candidate !== null && typeof candidate === "object" &&
    !Array.isArray(candidate) && Object.keys(candidate).length === keys.length &&
    keys.every((key) => key in candidate);
}

function validCommon(observation, platform) {
  const native = observation?.native;
  const surfaces = observation?.surfaces;
  return exactKeys(observation, [
    "hostKind", "native", "presentation", "surfaces", "tabIds",
    "topologyRevision", "windowGeneration", "windowId", "workspaceTabs",
    ...(observation && "nativeWindowHandle" in observation ? ["nativeWindowHandle"] : [])
  ]) && (!("nativeWindowHandle" in observation) || (platform === "windows" &&
    typeof observation.nativeWindowHandle === "string" &&
    /^[1-9]\d*$/u.test(observation.nativeWindowHandle))) && exactKeys(native, platform === "macos" ? [
    "alwaysShowToolbarInFullScreen", "appKit", "fullscreen",
    "nativeControlsVisible", "nativeWindowControlCount", "projectionRevision",
    "revealed", "toolbarVisible", "topologyRevision", "windowGeneration", "windowId"
  ] : [
    "alwaysShowToolbarInFullScreen", "fullscreen", "nativeControlsVisible",
    "nativeWindowControlCount", "projectionRevision", "revealed",
    "toolbarVisible", "topologyRevision", "windowGeneration", "windowId",
    "workspaceBackground"
  ]) && (platform === "macos" ||
    ["material", "black"].includes(native.workspaceBackground)) &&
    observation.hostKind === (platform === "macos" ? "appkit" : "windows") &&
    native.windowId === observation.windowId &&
    native.windowGeneration === observation.windowGeneration &&
    native.topologyRevision === observation.topologyRevision &&
    Number.isSafeInteger(observation.windowGeneration) && observation.windowGeneration > 0 &&
    Number.isSafeInteger(observation.topologyRevision) && observation.topologyRevision > 0 &&
    Number.isSafeInteger(native.projectionRevision) && native.projectionRevision > 0 &&
    Array.isArray(observation.tabIds) && observation.tabIds.length > 0 &&
    new Set(observation.tabIds).size === observation.tabIds.length &&
    Array.isArray(observation.workspaceTabs) &&
    observation.workspaceTabs.every((workspace) =>
      exactKeys(workspace, ["slots", "sourceId", "tabId"]) &&
      observation.tabIds.includes(workspace.tabId) &&
      Array.isArray(workspace.slots) && workspace.slots.length > 0
    ) &&
    Array.isArray(surfaces) && surfaces.some((surface) =>
      surface.kind === "role" && surface.visible === true &&
      Number.isSafeInteger(surface.bounds?.height) && surface.bounds.height > 0
    ) && new Set(surfaces.map((surface) => surface.id)).size === surfaces.length &&
    surfaces.every((surface) => observation.tabIds.includes(surface.tabId)) &&
    native.nativeControlsVisible === (native.nativeWindowControlCount > 0) &&
    native.fullscreen === (observation.presentation === "fullscreen");
}

function isHidden(observation, platform) {
  const native = observation.native;
  const common = observation.presentation === "fullscreen" && native.fullscreen &&
    !native.alwaysShowToolbarInFullScreen && !native.toolbarVisible &&
    !native.nativeControlsVisible && native.nativeWindowControlCount === 0;
  if (!common) return false;
  if (platform === "windows") {
    return observation.surfaces.some((surface) =>
      surface.kind === "role" && surface.visible && surface.bounds.y === 2
    );
  }
  const appKit = native.appKit;
  const geometryKeys = [
    ...(appKit && "nativeLifecycle" in appKit ? ["nativeLifecycle"] : []),
    ...(appKit && "tabScreenBounds" in appKit ? ["tabScreenBounds"] : []),
    ...(appKit && "fullscreenControlScreenBounds" in appKit
      ? ["fullscreenControlScreenBounds"]
      : [])
  ];
  return exactKeys(appKit, [
    "accessoryOnScreen", "accessoryVisibleHeight", "addButtonOnScreen",
    "fullscreenHostReady", "presentationAutoHideToolbar", "revealLocked",
    "tabCloseButtonEnabledCount", "tabStripOnScreen", "toolbarPinned",
    "visibleTrafficLightCount", "windowNameOnScreen",
    ...geometryKeys
  ]) && appKit.fullscreenHostReady && appKit.presentationAutoHideToolbar &&
    !appKit.accessoryOnScreen && !appKit.tabStripOnScreen &&
    !appKit.toolbarPinned && appKit.visibleTrafficLightCount === 0;
}

function isRevealed(observation, platform) {
  const native = observation.native;
  const common = observation.presentation === "fullscreen" && native.fullscreen &&
    !native.alwaysShowToolbarInFullScreen && native.revealed && native.toolbarVisible &&
    native.nativeControlsVisible && native.nativeWindowControlCount === 3;
  if (!common) return false;
  return platform === "windows"
    ? observation.surfaces.some((surface) =>
      surface.kind === "role" && surface.visible && surface.bounds.y === 40
    )
    : native.appKit?.presentationAutoHideToolbar === true &&
      native.appKit.accessoryOnScreen === true &&
      native.appKit.tabStripOnScreen === true &&
      native.appKit.visibleTrafficLightCount === 3;
}

function isPinned(observation, platform) {
  const native = observation.native;
  const common = observation.presentation === "fullscreen" && native.fullscreen &&
    native.alwaysShowToolbarInFullScreen && native.toolbarVisible &&
    native.nativeControlsVisible && native.nativeWindowControlCount === 3;
  return common && (platform === "windows"
    ? observation.surfaces.some((surface) =>
      surface.kind === "role" && surface.visible && surface.bounds.y === 40
    )
    : native.appKit?.toolbarPinned === true);
}

function findAfter(observations, start, predicate) {
  for (let index = start + 1; index < observations.length; index += 1) {
    if (predicate(observations[index])) return index;
  }
  return -1;
}

function normalBaseline(observation) {
  return observation.presentation === "normal" && !observation.native.fullscreen &&
    observation.native.alwaysShowToolbarInFullScreen === false &&
    observation.native.toolbarVisible;
}

function validateMacosLifecycle(observations, hidden, pinned, hiddenAfterPinned, phase) {
  for (const observation of observations.slice(hidden, hiddenAfterPinned + 1)) {
    const native = observation.native;
    const lifecycle = native.appKit?.nativeLifecycle;
    requireRuntime(exactKeys(lifecycle,
      ["menuBarReveal", "toolbarReveal", "sequence", "onActiveSpace"]) &&
      [lifecycle.menuBarReveal, lifecycle.toolbarReveal].every(value =>
        Number.isFinite(value) && value >= 0 && value <= 1) &&
      Number.isSafeInteger(lifecycle.sequence) && lifecycle.sequence > 0 &&
      typeof lifecycle.onActiveSpace === "boolean",
    `${phase}: missing native reveal lifecycle`);
    if (!native.alwaysShowToolbarInFullScreen) {
      requireRuntime(native.appKit.presentationAutoHideToolbar &&
        Math.abs(lifecycle.menuBarReveal - lifecycle.toolbarReveal) < 0.001 &&
        (lifecycle.menuBarReveal > 0 || !native.toolbarVisible),
      `${phase}: controls appeared outside the native menu-bar reveal`);
    }
  }
  let cursor = pinned;
  for (let cycle = 0; cycle < 2; cycle++) {
    const shown = findAfter(observations, cursor, observation =>
      isPinned(observation, "macos") &&
      observation.native.appKit.nativeLifecycle.menuBarReveal >= 0.999);
    const retracted = findAfter(observations, shown, observation =>
      isPinned(observation, "macos") &&
      observation.native.appKit.nativeLifecycle.menuBarReveal <= 0.001 &&
      observation.native.appKit.nativeLifecycle.toolbarReveal === 1);
    requireRuntime(shown > cursor && retracted > shown && retracted < hiddenAfterPinned,
      `${phase}: pinned controls did not survive two native menu-bar cycles`);
    cursor = retracted;
  }
  for (const [start, end] of [[hidden, pinned], [pinned, hiddenAfterPinned]]) {
    const departed = findAfter(observations, start, observation =>
      observation.native.appKit?.nativeLifecycle?.onActiveSpace === false);
    const returned = findAfter(observations, departed, observation =>
      observation.native.appKit?.nativeLifecycle?.onActiveSpace === true);
    requireRuntime(departed > start && returned > departed && returned < end,
      `${phase}: native Space departure/return was not observed in both policies`);
  }
}

export async function validateChromiumFullscreenToolbarRuntimeEvidence({
  phase,
  phaseDirectory,
  platform
}) {
  if (!isChromiumFullscreenToolbarPhase(phase)) return undefined;
  const observations = JSON.parse(await readFile(
    resolve(phaseDirectory, "electron-fullscreen-toolbar-observations.json"),
    "utf8"
  ));
  requireRuntime(
    Array.isArray(observations) && observations.length >= 2 &&
      observations.every((observation) => validCommon(observation, platform)),
    `${phase}: malformed or empty Core/native observation history`
  );
  const windowIds = new Set(observations.map((observation) => observation.windowId));
  const windowGenerations = new Set(
    observations.map((observation) => observation.windowGeneration)
  );
  requireRuntime(
    windowIds.size === 1 && windowGenerations.size === 1,
    `${phase}: fullscreen history crossed a logical/native window generation`
  );
  requireRuntime(
    observations.every((observation, index) => index === 0 ||
      observation.topologyRevision >= observations[index - 1].topologyRevision),
    `${phase}: Core topology revisions moved backwards`
  );
  requireRuntime(
    observations.some((observation) => isHidden(observation, platform)),
    `${phase}: no exact offscreen auto-hide state was observed`
  );
  if (phase === "chromium-fullscreen-toolbar-seed") {
    const normal = findAfter(observations, -1, normalBaseline);
    const hidden = findAfter(observations, normal,
      (observation) => isHidden(observation, platform));
    const revealed = findAfter(observations, hidden,
      (observation) => isRevealed(observation, platform));
    const hiddenAfterReveal = findAfter(observations, revealed,
      (observation) => isHidden(observation, platform));
    const pinned = findAfter(observations, hiddenAfterReveal,
      (observation) => isPinned(observation, platform));
    const hiddenAfterPinned = findAfter(observations, pinned,
      (observation) => isHidden(observation, platform));
    requireRuntime(
      normal >= 0 && hidden > normal && revealed > hidden &&
        hiddenAfterReveal > revealed && pinned > hiddenAfterReveal &&
        hiddenAfterPinned > pinned,
      `${phase}: normal/hidden/revealed/hidden/pinned/hidden ordering is incomplete`
    );
    if (platform === "windows") {
      const shown = observations[revealed].surfaces.filter(surface =>
        surface.kind === "role" && surface.visible);
      for (const surface of shown) {
        const bounds = surface.bounds;
        for (const index of [hidden, hiddenAfterReveal, hiddenAfterPinned, pinned]) {
          const peer = observations[index].surfaces.find(candidate =>
            candidate.id === surface.id && candidate.tabId === surface.tabId &&
            candidate.kind === "role" && candidate.visible);
          const inset = index === pinned ? 40 : 2;
          requireRuntime(peer && bounds.y === 40 && peer.bounds.y === inset &&
            peer.bounds.x === bounds.x && peer.bounds.width === bounds.width &&
            peer.bounds.height - bounds.height === 40 - inset &&
            peer.bounds.y + peer.bounds.height === bounds.y + bounds.height,
          `${phase}: fullscreen toolbar geometry changed outside its exact inset`);
        }
      }
    } else {
      const baseline = observations[hidden].surfaces.filter(surface =>
        surface.kind === "role" && surface.visible);
      validateMacosLifecycle(observations, hidden, pinned, hiddenAfterPinned, phase);
      for (const current of observations.slice(hidden, hiddenAfterPinned + 1)
        .filter(observation => !observation.native.alwaysShowToolbarInFullScreen)) {
        for (const surface of baseline) {
          const peer = current.surfaces.find(candidate =>
            candidate.id === surface.id && candidate.tabId === surface.tabId &&
            candidate.kind === "role" && candidate.visible);
          const a = surface.bounds;
          const b = peer?.bounds;
          requireRuntime(b && b.x === a.x && b.y === a.y &&
            b.width === a.width && b.height === a.height,
          `${phase}: AppKit auto-hide moved Chromium content`);
        }
      }
    }
  }
  const terminal = observations.at(-1);
  requireRuntime(
    terminal.presentation === "normal" && !terminal.native.fullscreen &&
      terminal.native.alwaysShowToolbarInFullScreen === false,
    `${phase}: terminal baseline was not normal plus persisted auto-hide`
  );
  return {
    autoHideObserved: true,
    historyLength: observations.length,
    nativeHost: terminal.hostKind,
    pinnedAndRevealed: phase === "chromium-fullscreen-toolbar-seed",
    restartVerified: phase === "chromium-fullscreen-toolbar-restart",
    windowId: terminal.windowId
  };
}

export function validateChromiumFullscreenToolbarSqliteEvidence(
  phase,
  entities,
  settings
) {
  const roles = entities.roles.filter((role) => role.name === "Chromium Entity Role Edited");
  const preferences = settings.find(
    (setting) => setting.key === "runtimeWindowPreferences"
  )?.payload;
  const restore = settings.find(
    (setting) => setting.key === "runtimeRestoreSession"
  )?.payload;
  requireRuntime(roles.length === 1, `${phase}: exact live Role is missing`);
  requireRuntime(
    preferences?.alwaysShowToolbarInFullScreen === false,
    `${phase}: persisted toolbar baseline is not auto-hide`
  );
  requireRuntime(
    restore?.cleanExit === true,
    `${phase}: fullscreen phase did not reach a clean Core/runtime flush`
  );
  return {
    baselinePersisted: true,
    cleanExit: true,
    restartVerified: phase === "chromium-fullscreen-toolbar-restart",
    roleId: roles[0].id
  };
}
