import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const phase = "chromium-macro-standby-recovery";

export const chromiumMacroStandbyPhaseDependencies = Object.freeze([]);
export const chromiumMacroStandbyPhaseNamespaces = Object.freeze([
  [phase, "chromium-macro-standby-recovery"]
]);

export function isChromiumMacroStandbyPhase(candidate) {
  return candidate === phase;
}

function requireEvidence(condition, message) {
  if (!condition) throw new Error(`Chromium Macro standby evidence failed: ${message}`);
}

function exactKeys(candidate, keys) {
  return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate) &&
    Object.keys(candidate).sort().join("|") === [...keys].sort().join("|");
}

function requireLifecycle(receipt, event, platform) {
  requireEvidence(exactKeys(receipt, ["before", "event", "terminal"]),
    `${event}: lifecycle receipt shape drifted`);
  requireEvidence(receipt.event === event, `${event}: lifecycle event drifted`);
  requireEvidence(
    receipt.terminal.lifecycleEpoch === receipt.before.lifecycleEpoch + 1 &&
      receipt.terminal.revision === receipt.before.revision + 2 &&
      receipt.terminal.platform === platform &&
      receipt.terminal.state === (event === "suspend" ? "suspended" : "active"),
    `${event}: exact terminal projection drifted`
  );
}

function requireKeyObservation(observation, input) {
  requireEvidence(exactKeys(observation, ["receipt", "request", "sequence"]),
    `${input.label}: observation shape drifted`);
  const { receipt, request } = observation;
  requireEvidence(
    request.roleId === input.roleId && request.origin === "macro" &&
      request.intent === input.intent && request.action?.type === "key" &&
      request.action.code === "KeyS" && request.action.phase === input.actionPhase &&
      receipt.requestId === request.requestId && receipt.roleId === request.roleId &&
      receipt.inputEpoch === request.inputEpoch && receipt.status === "applied" &&
      receipt.errorCode === null && receipt.errorMessage === null,
    `${input.label}: Core/native trusted-input identity drifted`
  );
  if (input.intent === "cleanup") {
    requireEvidence(receipt.confirmedInputNeutrality === true,
      `${input.label}: cleanup did not prove input neutrality`);
  }
}

function requireHost(evidence, platform) {
  const expectedHost = platform === "macos" ? "appkit-chromium" : "bundled-chromium";
  const windowRuntime = evidence.gameWindowRuntime?.currentRuntime;
  const roleRuntime = evidence.roleRuntime?.currentRuntime;
  requireEvidence(windowRuntime?.hostKind === expectedHost,
    "Game Window native host kind drifted");
  requireEvidence(roleRuntime?.hostKind === expectedHost,
    "Role native host kind drifted");
  requireEvidence(windowRuntime.windowId === evidence.gameWindowId &&
    roleRuntime.windowId === evidence.gameWindowId &&
    roleRuntime.tabId === evidence.tabA, "Role/window/tab native identities drifted");
  requireEvidence(Number.isSafeInteger(windowRuntime.parentNativeHostId) &&
    windowRuntime.parentNativeHostId > 0, "parent native host is missing");
  if (platform === "macos") {
    requireEvidence(
      windowRuntime.appKitIdentity?.logicalWindowId === evidence.gameWindowId &&
        roleRuntime.appKitIdentity?.logicalWindowId === evidence.gameWindowId,
      "retained AppKit host identity is missing"
    );
  } else {
    requireEvidence(windowRuntime.appKitIdentity === null &&
      roleRuntime.appKitIdentity === null, "Windows unexpectedly reported AppKit");
  }
  const topology = evidence.topology;
  requireEvidence(topology?.hostKind === (platform === "macos" ? "appkit" : "windows"),
    "native tab host kind drifted");
  requireEvidence(JSON.stringify(topology.tabIds) === JSON.stringify([
    evidence.tabA,
    evidence.tabB
  ]), "ordered native tabs drifted");
  requireEvidence(
    topology.surfaces?.filter(({ visible }) => visible).length === 1 &&
      topology.surfaces.find(({ visible }) => visible)?.tabId === evidence.tabB,
    "Role B is not the exact final visible native surface"
  );
}

export async function validateChromiumMacroStandbyRuntimeEvidence(input) {
  if (!isChromiumMacroStandbyPhase(input.phase)) return undefined;
  const evidence = JSON.parse(await readFile(resolve(
    input.phaseDirectory,
    "chromium-macro-standby-recovery-evidence.json"
  ), "utf8"));
  const rootKeys = [
    "firstHold", "gameId", "gameWindowId", "gameWindowRuntime", "macroId",
    "platform", "probe", "resume", "roleAId", "roleBId", "roleRuntime",
    "secondHold", "stopCleanup", "suspend", "suspendCleanup", "tabA", "tabB",
    "topology"
  ];
  requireEvidence(exactKeys(evidence, rootKeys), `${input.phase}: root shape drifted`);
  requireEvidence(evidence.platform === input.platform, `${input.phase}: platform drifted`);
  requireEvidence(evidence.probe?.platform === input.platform,
    `${input.phase}: E2E probe platform drifted`);
  requireLifecycle(evidence.suspend, "suspend", input.platform);
  requireLifecycle(evidence.resume, "resume", input.platform);
  requireEvidence(
    JSON.stringify(evidence.resume.before) === JSON.stringify(evidence.suspend.terminal),
    `${input.phase}: resume did not continue the exact suspend terminal`
  );
  for (const [label, observation, intent, actionPhase] of [
    ["first hold", evidence.firstHold, "normal", "hold"],
    ["suspend cleanup", evidence.suspendCleanup, "cleanup", "release"],
    ["second hold", evidence.secondHold, "normal", "hold"],
    ["stop cleanup", evidence.stopCleanup, "cleanup", "release"]
  ]) {
    requireKeyObservation(observation, {
      actionPhase,
      intent,
      label,
      roleId: evidence.roleAId
    });
  }
  const observations = [
    evidence.firstHold,
    evidence.suspendCleanup,
    evidence.secondHold,
    evidence.stopCleanup
  ];
  requireEvidence(observations.every((entry, index) => index === 0 ||
    entry.sequence > observations[index - 1].sequence),
  `${input.phase}: trusted-input sequence did not advance`);
  requireEvidence(
    evidence.suspendCleanup.request.inputEpoch > evidence.firstHold.request.inputEpoch &&
      evidence.secondHold.request.inputEpoch >= evidence.suspendCleanup.request.inputEpoch &&
      evidence.stopCleanup.request.inputEpoch >= evidence.secondHold.request.inputEpoch,
    `${input.phase}: input epochs did not fence suspend and restart`
  );
  requireEvidence(
    evidence.secondHold.request.requestId !== evidence.firstHold.request.requestId &&
      evidence.secondHold.request.action.ownerId !== evidence.firstHold.request.action.ownerId,
    `${input.phase}: wake reused the terminated Macro run`
  );
  requireHost(evidence, input.platform);
  return {
    appKitIdentity: evidence.gameWindowRuntime.currentRuntime.appKitIdentity,
    firstInputEpoch: evidence.firstHold.request.inputEpoch,
    gameWindowId: evidence.gameWindowId,
    hostKind: evidence.gameWindowRuntime.currentRuntime.hostKind,
    macroId: evidence.macroId,
    resumedInputEpoch: evidence.secondHold.request.inputEpoch,
    roleIds: [evidence.roleAId, evidence.roleBId],
    suspendInputEpoch: evidence.suspendCleanup.request.inputEpoch,
    terminalLifecycleEpoch: evidence.resume.terminal.lifecycleEpoch
  };
}

export function validateChromiumMacroStandbySqliteEvidence(input) {
  if (!isChromiumMacroStandbyPhase(input.phase)) return undefined;
  const { entities, settings } = input;
  const games = entities.games.filter(({ name }) => name ===
    "Chromium Standby Recovery Game");
  const roles = entities.roles.filter(({ name }) => [
    "Chromium Standby Recovery Role A",
    "Chromium Standby Recovery Role B"
  ].includes(name));
  const macros = entities.macros.filter(({ name }) => name ===
    "Chromium Standby Recovery Macro");
  requireEvidence(games.length === 1, `${input.phase}: exact Game is missing`);
  requireEvidence(roles.length === 2 && roles.every(({ payload }) =>
    payload?.gameId === games[0].id), `${input.phase}: exact two Roles are missing`);
  requireEvidence(macros.length === 1, `${input.phase}: exact Macro is missing`);
  const roleA = roles.find(({ name }) => name.endsWith("Role A"));
  const macro = macros[0].payload;
  requireEvidence(
    JSON.stringify(macro?.roleIds) === JSON.stringify([roleA?.id]) &&
      macro?.activationMode === "toggle" && macro?.enabled === true &&
      macro?.repeat?.type === "once" && macro?.steps?.length === 1,
    `${input.phase}: Macro authority drifted`
  );
  const step = macro.steps[0];
  requireEvidence(
    step.type === "key" && step.code === "KeyS" &&
      step.action === "hold_until_stop" &&
      step.id === "chromium-standby-held-key",
    `${input.phase}: held KeyS step drifted`
  );
  requireEvidence(entities.gameWindows.length === 1 &&
    entities.gameWindows[0].payload?.tabs?.length === 2,
  `${input.phase}: exact two-tab Game Window is missing`);
  const roleIds = new Set(roles.map(({ id }) => id));
  requireEvidence(entities.gameWindows[0].payload.tabs.every((tab) =>
    tab.tabType === "role" && roleIds.has(tab.sourceId)),
  `${input.phase}: saved Role tab cohort drifted`);
  const restoreSession = settings.find(({ key }) => key ===
    "runtimeRestoreSession")?.payload;
  requireEvidence(restoreSession?.schemaVersion === 2 && restoreSession.cleanExit === true,
    `${input.phase}: final clean schema-v2 lifecycle journal is missing`);
  return {
    cleanExit: true,
    gameId: games[0].id,
    macroId: macros[0].id,
    roleIds: roles.map(({ id }) => id).sort(),
    tabIds: entities.gameWindows[0].payload.tabs.map(({ id }) => id),
    windowId: entities.gameWindows[0].id
  };
}
