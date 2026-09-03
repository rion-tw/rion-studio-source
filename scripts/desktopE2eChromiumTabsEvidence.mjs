import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const phases = new Set([
  "chromium-tabs-visible-seed",
  "chromium-tabs-visible-restart"
]);

let seedPersistenceEvidence;

function requireRuntime(condition, message) {
  if (!condition) throw new Error(`Desktop E2E native runtime evidence failed: ${message}`);
}

function requireSqlite(condition, message) {
  if (!condition) throw new Error(`Desktop E2E SQLite evidence failed: ${message}`);
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export const chromiumTabsPhaseDependencies = [[
  "chromium-tabs-visible-restart",
  ["chromium-tabs-visible-seed"]
], [
  "chromium-native-window-display-extended",
  ["chromium-tabs-visible-restart"]
]];

export const chromiumTabsPhaseNamespaces = [
  ["chromium-tabs-visible-seed", "chromium-tabs-visible-lifecycle"],
  ["chromium-tabs-visible-restart", "chromium-tabs-visible-lifecycle"],
  ["chromium-native-window-display-extended", "chromium-tabs-visible-lifecycle"]
];

export function isChromiumTabsPhase(phase) {
  return phases.has(phase);
}

export async function validateChromiumTabsRuntimeEvidence({
  phase,
  phaseDirectory,
  platform
}) {
  if (!isChromiumTabsPhase(phase)) return undefined;
  const observations = JSON.parse(await readFile(
    resolve(phaseDirectory, "chromium-tabs-topology-observations.json"),
    "utf8"
  ));
  const requiredStages = phase === "chromium-tabs-visible-seed"
    ? [
        "baseline",
        "reordered",
        "moved-existing",
        ...(platform === "windows" ? ["windows-geometry"] : []),
        "detached-with-successor",
        "hidden",
        "revealed",
        "seed-distributed-final"
      ]
    : ["restart-distributed", "restart-consolidated"];
  requireRuntime(
    Array.isArray(observations) && sameValue(
      observations.map((observation) => observation.stage),
      requiredStages
    ),
    `${phase}: exact visible native topology transition history is incomplete`
  );
  const expectedHostKind = platform === "macos" ? "appkit-chromium" : "bundled-chromium";
  const expectedInspectionHost = platform === "macos" ? "appkit" : "windows";
  for (const observation of observations) {
    requireRuntime(
      observation.platform === platform && sameValue(observation.shellErrors, []) &&
        Array.isArray(observation.windows),
      `${phase}/${observation.stage}: platform or shell-error evidence is invalid`
    );
    for (const window of observation.windows) {
      const persistedIds = window.persistedTabs.map((tab) => tab.id);
      requireRuntime(
        new Set(persistedIds).size === persistedIds.length,
        `${phase}/${observation.stage}: persisted tab identity is ambiguous`
      );
      if (!window.owner) {
        requireRuntime(
          window.logical === null && window.native === null &&
            window.runtimeTabs.length === 0,
          `${phase}/${observation.stage}: dormant window retained a native owner`
        );
        continue;
      }
      const runtimeIds = window.runtimeTabs.map((tab) => tab.id);
      const visible = window.native.surfaces.filter((surface) => surface.visible);
      requireRuntime(
        window.logical?.id === window.id && window.owner.windowId === window.id &&
          window.owner.hostKind === expectedHostKind &&
          sameValue(runtimeIds, persistedIds) &&
          sameValue(window.owner.coreTabIds, persistedIds) &&
          sameValue(window.owner.nativeTabIds, persistedIds) &&
          sameValue(window.native.tabIds, persistedIds) &&
          window.native.hostKind === expectedInspectionHost &&
          window.native.windowGeneration === window.owner.windowGeneration &&
          window.native.topologyRevision === window.owner.topologyRevision &&
          Number.isSafeInteger(window.owner.parentNativeHostId) &&
          window.owner.parentNativeHostId > 0 &&
          Number.isSafeInteger(window.owner.windowGeneration) &&
          window.owner.windowGeneration > 0 &&
          Number.isSafeInteger(window.owner.topologyRevision) &&
          window.owner.topologyRevision > 0 &&
          visible.length === 1 &&
          visible[0]?.tabId === window.persistedActiveTabId,
        `${phase}/${observation.stage}: Core/native/generation/parent fence diverged`
      );
      requireRuntime(
        platform === "macos"
          ? window.owner.appKitIdentity?.logicalWindowId === window.id &&
              window.owner.appKitIdentity.nativeGeneration > 0 &&
              window.native.native?.appKit?.tabStripOnScreen === true
          : window.owner.appKitIdentity === null &&
              window.native.native?.appKit === undefined,
        `${phase}/${observation.stage}: platform native host identity is invalid`
      );
    }
  }

  const byStage = new Map(observations.map((observation) => [
    observation.stage,
    observation
  ]));
  const names = {
    alpha: "Chromium Tabs Alpha",
    beta: "Chromium Tabs Beta",
    delta: "Chromium Tabs Delta",
    gamma: "Chromium Tabs Gamma"
  };
  const topology = (stage, windowName, expectedNames, activeName, hiddenNames = []) => {
    const observation = byStage.get(stage);
    const window = observation?.windows.find((candidate) => candidate.name === windowName);
    const ids = expectedNames.map((name) => observation?.roleTabIds?.[name]);
    requireRuntime(
      window && ids.every((id) => typeof id === "string") &&
        sameValue(window.persistedTabs.map((tab) => tab.id), ids) &&
        window.persistedActiveTabId === observation.roleTabIds[activeName] &&
        sameValue(
          window.persistedTabs.filter((tab) => tab.hidden).map((tab) => tab.name),
          hiddenNames
        ),
      `${phase}/${stage}: ${windowName} did not retain the expected tab transition`
    );
    return window;
  };

  if (phase === "chromium-tabs-visible-seed") {
    topology("baseline", "Chromium Tabs Window", [names.alpha, names.beta, names.gamma], names.gamma);
    topology("reordered", "Chromium Tabs Window", [names.gamma, names.alpha, names.beta], names.gamma);
    topology("moved-existing", "Chromium Tabs Window", [names.gamma, names.alpha], names.gamma);
    topology("moved-existing", "Chromium Tabs Target Window", [names.delta, names.beta], names.beta);
    topology("detached-with-successor", "Chromium Tabs Window", [names.alpha], names.alpha);
    topology("hidden", "Chromium Tabs Target Window", [names.delta, names.beta], names.delta, [names.beta]);
    topology("revealed", "Chromium Tabs Target Window", [names.delta, names.beta], names.beta);
    const detached = byStage.get("detached-with-successor").windows.find(
      (window) => window.persistedTabs.some((tab) => tab.name === names.gamma)
    );
    requireRuntime(
      detached && detached.name !== "Chromium Tabs Window" &&
        detached.name !== "Chromium Tabs Target Window" &&
        sameValue(detached.persistedTabs.map((tab) => tab.name), [names.gamma]) &&
        detached.persistedActiveTabId === detached.persistedTabs[0]?.id,
      `${phase}: selected detach did not create one exact native window`
    );
    if (platform === "windows") {
      const geometry = byStage.get("windows-geometry")?.geometry;
      for (const lane of [geometry?.source, geometry?.target]) {
        requireRuntime(
          lane && lane.before && lane.resized &&
            lane.before.contentBounds.width !== lane.resized.contentBounds.width &&
            lane.before.contentBounds.height !== lane.resized.contentBounds.height &&
            lane.resized.viewport.width === lane.resized.contentBounds.width &&
            lane.resized.viewport.height ===
              lane.resized.contentBounds.y + lane.resized.contentBounds.height,
          `${phase}: Windows resize did not preserve exact controller viewport bounds`
        );
      }
      requireRuntime(
        sameValue(geometry.source.resized.contentBounds, geometry.source.restored.contentBounds) &&
          sameValue(geometry.source.resized.viewport, geometry.source.restored.viewport) &&
          geometry.source.resized.resizeEventCount ===
            geometry.source.restored.resizeEventCount,
        `${phase}: Windows minimize/restore changed bounds or emitted resize`
      );
    }
    const final = byStage.get("seed-distributed-final");
    requireRuntime(
      final.windows.every((window) => window.owner === null),
      `${phase}: distributed seed did not finish dormant`
    );
    seedPersistenceEvidence = {
      distributed: final.windows.map((window) => ({
        activeTabId: window.persistedActiveTabId,
        id: window.id,
        name: window.name,
        tabs: window.persistedTabs
      })).sort((left, right) => left.id.localeCompare(right.id)),
      roleTabIds: final.roleTabIds
    };
  } else {
    const restart = byStage.get("restart-distributed");
    const distributed = restart.windows.map((window) => ({
      activeTabId: window.persistedActiveTabId,
      id: window.id,
      name: window.name,
      tabs: window.persistedTabs
    })).sort((left, right) => left.id.localeCompare(right.id));
    requireRuntime(
      seedPersistenceEvidence &&
        sameValue(restart.roleTabIds, seedPersistenceEvidence.roleTabIds) &&
        sameValue(distributed, seedPersistenceEvidence.distributed),
      `${phase}: restart changed distributed tab/window identity or hidden state`
    );
    topology("restart-consolidated", "Chromium Tabs Window", [names.gamma, names.alpha, names.beta], names.beta);
    topology("restart-consolidated", "Chromium Tabs Target Window", [names.delta], names.delta);
  }
  return {
    hostKind: expectedInspectionHost,
    observationCount: observations.length,
    restartVerified: phase === "chromium-tabs-visible-restart",
    stages: requiredStages
  };
}

export function validateChromiumTabsSqliteEvidence(phase, entities, settings) {
  if (!isChromiumTabsPhase(phase)) return undefined;
  const windows = entities.gameWindows.filter(
    (window) => ["Chromium Tabs Window", "Chromium Tabs Target Window"]
      .includes(window.name)
  );
  const games = entities.games.filter((game) => game.name === "Chromium Tabs Game");
  const roleNames = [
    "Chromium Tabs Alpha",
    "Chromium Tabs Beta",
    "Chromium Tabs Gamma",
    "Chromium Tabs Delta"
  ];
  const roles = entities.roles.filter((role) => roleNames.includes(role.name));
  requireSqlite(games.length === 1, `${phase}: exact tab Game is not uniquely persisted`);
  requireSqlite(roles.length === 4, `${phase}: exact four tab Roles are not persisted`);
  requireSqlite(windows.length === 2, `${phase}: source/target Game Windows are not persisted`);
  const source = windows.find((window) => window.name === "Chromium Tabs Window");
  const target = windows.find((window) => window.name === "Chromium Tabs Target Window");
  const detached = entities.gameWindows.find((window) =>
    window.payload?.tabs?.some((tab) => tab.name === "Chromium Tabs Gamma") &&
    window.id !== source?.id
  );
  const expectedSource = phase === "chromium-tabs-visible-seed"
    ? [roleNames[0]]
    : [roleNames[2], roleNames[0], roleNames[1]];
  const expectedTarget = phase === "chromium-tabs-visible-seed"
    ? [roleNames[3], roleNames[1]]
    : [roleNames[3]];
  requireSqlite(
    source && target &&
      sameValue(source.payload?.tabs?.map((tab) => tab.name), expectedSource) &&
      sameValue(target.payload?.tabs?.map((tab) => tab.name), expectedTarget) &&
      source.payload?.activeTabId === source.payload?.tabs?.at(-1)?.id &&
      target.payload?.activeTabId === target.payload?.tabs?.at(-1)?.id &&
      (phase === "chromium-tabs-visible-seed"
        ? detached?.payload?.tabs?.length === 1 &&
          detached.payload.tabs[0]?.name === roleNames[2]
        : detached === undefined),
    `${phase}: distributed or consolidated saved tab topology drifted`
  );
  const session = settings.find(
    (setting) => setting.key === "runtimeRestoreSession"
  )?.payload;
  requireSqlite(
    session?.cleanExit === true && sameValue(session.liveWindowIds, []),
    `${phase}: dormant tab phase did not finish with an exact clean restore journal`
  );
  const evidence = {
    gameId: games[0].id,
    roleIds: roles.map((role) => role.id).sort(),
    sourceTabIds: source.payload.tabs.map((tab) => tab.id),
    sourceWindowId: source.id,
    targetTabIds: target.payload.tabs.map((tab) => tab.id),
    targetWindowId: target.id
  };
  return {
    cleanExit: true,
    restartVerified: phase === "chromium-tabs-visible-restart",
    ...evidence
  };
}
