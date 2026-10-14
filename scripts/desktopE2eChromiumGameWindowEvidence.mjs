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

async function validatePresentationStages({ phase, phaseDirectory, platform, windowId }) {
  const stages = JSON.parse(await readFile(
    resolve(phaseDirectory, "game-window-presentation-stages.json"), "utf8"
  ));
  const baselinePresentation = platform === "windows" ? "maximized" : "fullscreen";
  const expectedStages = phase === "chromium-game-window-ui-restart"
    ? ["restart-restored"]
    : ["normal-baseline", "fullscreen-applied", "fullscreen-closed", "fullscreen-reopened",
      "normal-restored", "maximized-applied", "maximized-closed", "maximized-reopened",
      ...(platform === "macos"
        ? ["normal-after-maximize", "fullscreen-baseline"]
        : [])];
  requireRuntime(Array.isArray(stages) && sameValue(stages.map(({ stage }) => stage), expectedStages),
    `${phase}: visible presentation/close/reopen stages are incomplete or reordered`);
  const normalBounds = stages[0]?.saved?.placement?.normalBounds;
  requireRuntime(exactKeys(normalBounds, ["x", "y", "width", "height"]) &&
    Object.values(normalBounds).every(Number.isSafeInteger) &&
    normalBounds.width > 0 && normalBounds.height > 0,
  `${phase}: saved normal bounds are missing or malformed`);
  for (const entry of stages) {
    const presentation = entry.stage.startsWith("normal-") ? "normal"
      : entry.stage.startsWith("fullscreen-") ? "fullscreen"
        : entry.stage.startsWith("maximized-") ? "maximized" : baselinePresentation;
    requireRuntime(entry.saved?.id === windowId &&
      entry.saved?.name === "Chromium E2E Game Window" &&
      sameValue(entry.saved?.tabs, []) &&
      entry.saved?.placement?.presentation === presentation &&
      sameValue(entry.saved?.placement?.normalBounds, normalBounds),
    `${phase}: ${entry.stage} lost the saved presentation or normal bounds`);
    if (entry.stage.endsWith("-closed")) {
      requireRuntime(entry.runtime === null,
        `${phase}: ${entry.stage} did not retire the exact native owner`);
    } else {
      requireRuntime(entry.runtime?.windowId === windowId &&
        entry.runtime?.hostKind === (platform === "macos" ? "appkit-chromium" : "bundled-chromium") &&
        entry.runtime?.visible === true && entry.runtime?.focused === true &&
        sameValue(entry.runtime?.coreTabIds, []) && sameValue(entry.runtime?.nativeTabIds, []) &&
        entry.runtime?.nativeDisplay?.presentation === presentation,
      `${phase}: ${entry.stage} lacks matching native presentation`);
    }
  }
  return { baselinePresentation, normalBounds, stages: expectedStages };
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
  const presentationEvidence = await validatePresentationStages({
    phase, phaseDirectory, platform, windowId: observation?.windowId
  });
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
      && runtime.nativeDisplay.presentation === presentationEvidence.baselinePresentation,
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
    presentation: runtime.nativeDisplay.presentation,
    presentationStages: presentationEvidence.stages,
    savedNormalBounds: presentationEvidence.normalBounds,
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
      && gameWindow.payload.activeTabId === undefined
      && ["fullscreen", "maximized"].includes(gameWindow.payload.placement?.presentation),
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
    savedPresentation: gameWindow.payload.placement.presentation,
    restartVerified: phase === "chromium-game-window-ui-restart",
    windowId: gameWindow.id
  };
}
