import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

let seedPersistenceEvidence;

function exactKeys(candidate, keys) {
  return candidate !== null
    && typeof candidate === "object"
    && !Array.isArray(candidate)
    && Object.keys(candidate).length === keys.length
    && keys.every((key) => key in candidate);
}

function requireRuntime(condition, message) {
  if (!condition) throw new Error(`Desktop E2E native runtime evidence failed: ${message}`);
}

function requireSqlite(condition, message) {
  if (!condition) throw new Error(`Desktop E2E SQLite evidence failed: ${message}`);
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function validateChromiumGameWindowRuntimeEvidence({
  phase,
  phaseDirectory,
  platform
}) {
  if (!phase.startsWith("chromium-game-window-ui-")) return undefined;
  const observations = JSON.parse(await readFile(
    resolve(phaseDirectory, "electron-game-window-runtime-observations.json"),
    "utf8"
  ));
  requireRuntime(
    Array.isArray(observations) && observations.length === 1,
    `${phase}: expected exactly one observed permanent Game Window owner`
  );
  const observation = observations[0];
  const runtime = observation?.currentRuntime;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
  requireRuntime(
    exactKeys(observation, ["currentRuntime", "windowId"])
      && uuid.test(observation.windowId)
      && exactKeys(runtime, [
        "appKitIdentity",
        "appKitStatusPresentation",
        "coreTabIds",
        "focused",
        "hostKind",
        "nativeDisplay",
        "nativeTabIds",
        "parentNativeHostId",
        "topologyRevision",
        "visible",
        "windowGeneration",
        "windowId"
      ]),
    `${phase}: current Game Window native runtime evidence is missing or malformed`
  );
  const expectedHostKind = platform === "macos"
    ? "appkit-chromium"
    : "bundled-chromium";
  requireRuntime(
    runtime.windowId === observation.windowId
      && runtime.hostKind === expectedHostKind
      && runtime.focused === true
      && runtime.visible === true
      && sameValue(runtime.coreTabIds, [])
      && sameValue(runtime.nativeTabIds, [])
      && Number.isSafeInteger(runtime.parentNativeHostId)
      && runtime.parentNativeHostId > 0
      && Number.isSafeInteger(runtime.windowGeneration)
      && runtime.windowGeneration > 0
      && Number.isSafeInteger(runtime.topologyRevision)
      && runtime.topologyRevision > 0
      && exactKeys(runtime.nativeDisplay, [
        "bounds", "displayId", "presentation", "scaleFactor", "workArea"
      ])
      && [runtime.nativeDisplay.bounds, runtime.nativeDisplay.workArea].every(
        (bounds) => exactKeys(bounds, ["x", "y", "width", "height"])
          && [bounds.x, bounds.y, bounds.width, bounds.height]
            .every(Number.isSafeInteger)
          && bounds.width > 0 && bounds.height > 0
      )
      && Number.isSafeInteger(runtime.nativeDisplay.displayId)
      && Number.isFinite(runtime.nativeDisplay.scaleFactor)
      && runtime.nativeDisplay.scaleFactor > 0
      && runtime.nativeDisplay.presentation === "normal",
    `${phase}: empty Game Window lacks exact focused Core/native ownership`
  );
  if (platform === "macos") {
    requireRuntime(
      exactKeys(runtime.appKitIdentity, [
        "launchGeneration",
        "logicalWindowId",
        "nativeGeneration"
      ])
        && uuid.test(runtime.appKitIdentity.launchGeneration)
        && runtime.appKitIdentity.logicalWindowId === observation.windowId
        && Number.isSafeInteger(runtime.appKitIdentity.nativeGeneration)
        && runtime.appKitIdentity.nativeGeneration > 0
        && runtime.appKitStatusPresentation === "ready",
      `${phase}: retained AppKit Game Window identity is not exact`
    );
  } else {
    requireRuntime(
      runtime.appKitIdentity === null,
      `${phase}: Windows Game Window unexpectedly reported an AppKit identity`
    );
    requireRuntime(
      runtime.appKitStatusPresentation === null,
      `${phase}: Windows Game Window unexpectedly reported AppKit status chrome`
    );
  }
  return {
    appKitIdentity: runtime.appKitIdentity,
    coreTabIds: runtime.coreTabIds,
    focused: runtime.focused,
    hostKind: runtime.hostKind,
    nativeTabIds: runtime.nativeTabIds,
    parentNativeHostId: runtime.parentNativeHostId,
    topologyRevision: runtime.topologyRevision,
    visible: runtime.visible,
    windowGeneration: runtime.windowGeneration,
    windowId: observation.windowId
  };
}

export function validateChromiumGameWindowSqliteEvidence(phase, entities) {
  const windows = entities.gameWindows.filter(
    (window) => window.name === "Chromium E2E Game Window"
  );
  requireSqlite(
    windows.length === 1,
    `${phase}: expected exactly one renamed permanent Chromium Game Window`
  );
  const gameWindow = windows[0];
  requireSqlite(
    Array.isArray(gameWindow.payload?.tabs)
      && gameWindow.payload.tabs.length === 0
      && gameWindow.payload.activeTabId === undefined,
    `${phase}: permanent Chromium Game Window did not remain empty`
  );
  const evidence = {
    id: gameWindow.id,
    name: gameWindow.name,
    placement: gameWindow.payload.placement,
    targetDisplay: gameWindow.payload.targetDisplay
  };
  if (phase === "chromium-game-window-ui-seed") {
    seedPersistenceEvidence = evidence;
  } else {
    requireSqlite(
      seedPersistenceEvidence !== undefined && sameValue(seedPersistenceEvidence, evidence),
      `${phase}: restart changed the permanent Game Window identity or placement`
    );
  }
  return {
    emptyTabSetPersisted: true,
    restartVerified: phase === "chromium-game-window-ui-restart",
    windowId: gameWindow.id
  };
}
