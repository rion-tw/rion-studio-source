import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const phase = "chromium-macro-background-tab";

export const chromiumMacroBackgroundTabPhaseDependencies = Object.freeze([]);
export const chromiumMacroBackgroundTabPhaseNamespaces = Object.freeze([
  [phase, "chromium-macro-background-tab"]
]);

export function isChromiumMacroBackgroundTabPhase(candidate) {
  return candidate === phase;
}

function requireEvidence(condition, message) {
  if (!condition) {
    throw new Error(`Chromium Macro background-tab evidence failed: ${message}`);
  }
}

function exactKeys(candidate, keys) {
  return candidate !== null && typeof candidate === "object" &&
    !Array.isArray(candidate) &&
    Object.keys(candidate).sort().join("|") === [...keys].sort().join("|");
}

function requireTrustedKey(event, input) {
  requireEvidence(event?.roleId === input.roleId && event.kind === input.kind &&
    event.code === input.code && event.isTrusted === true &&
    Number.isSafeInteger(event.sequence) && event.sequence > 0,
  `${input.label}: exact trusted DOM key evidence drifted`);
}

function requireInputObservation(observation, input) {
  requireEvidence(exactKeys(observation, ["receipt", "request", "sequence"]),
    `${input.label}: observation shape drifted`);
  const { receipt, request } = observation;
  const baseRequestKeys = [
    "action", "deadlineMs", "inputEpoch", "intent", "origin", "requestId",
    "roleId", "scheduledAtMs"
  ];
  const exactSurfaceRequest = exactKeys(request, [
    ...baseRequestKeys,
    "documentInstanceId",
    "surfaceGeneration"
  ]);
  requireEvidence(exactKeys(request, baseRequestKeys) || exactSurfaceRequest,
    `${input.label}: Core request shape drifted`);
  requireEvidence(request?.roleId === input.roleId && request.origin === "macro" &&
    request.intent === input.intent && request.action?.type === "key" &&
    request.action.code === "Digit2" && request.action.phase === input.phase &&
    typeof request.action.ownerId === "string" && request.action.ownerId.length > 0,
  `${input.label}: Core held-key request drifted`);
  requireEvidence(exactKeys(receipt, [
    "completedAtMs", "confirmedInputNeutrality", "errorCode", "errorMessage",
    "inputEpoch", "requestId", "roleId", "status", "surfaceGeneration"
  ]), `${input.label}: native trusted-input receipt shape drifted`);
  requireEvidence(receipt?.requestId === request.requestId &&
    receipt.roleId === request.roleId && receipt.inputEpoch === request.inputEpoch &&
    Number.isSafeInteger(receipt.surfaceGeneration) &&
    receipt.surfaceGeneration > 0 &&
    (!exactSurfaceRequest || (
      Number.isSafeInteger(request.surfaceGeneration) &&
      request.surfaceGeneration === receipt.surfaceGeneration &&
      typeof request.documentInstanceId === "string" &&
      request.documentInstanceId.length > 0
    )) &&
    receipt.status === "applied" && receipt.errorCode === null &&
    receipt.errorMessage === null && Number.isSafeInteger(observation.sequence) &&
    observation.sequence > 0,
  `${input.label}: native trusted-input receipt drifted`);
  if (input.intent === "cleanup") {
    requireEvidence(receipt.confirmedInputNeutrality === true,
      `${input.label}: cleanup did not prove input neutrality`);
  }
}

function requireHiddenPresentation(evidence, input) {
  requireEvidence(exactKeys(evidence, ["roleA", "roleB", "topology", "window"]),
    `${input.label}: presentation evidence shape drifted`);
  const roleA = evidence.roleA?.currentRuntime;
  const roleB = evidence.roleB?.currentRuntime;
  const window = evidence.window?.currentRuntime;
  const expectedHost = input.platform === "macos"
    ? "appkit-chromium"
    : "bundled-chromium";
  requireEvidence(roleA?.hostKind === expectedHost && roleB?.hostKind === expectedHost &&
    window?.hostKind === expectedHost,
  `${input.label}: native host kind drifted`);
  requireEvidence(roleA.windowId === input.windowId && roleB.windowId === input.windowId &&
    window.windowId === input.windowId && roleA.tabId === input.tabA &&
    roleB.tabId === input.tabB,
  `${input.label}: exact Role/tab/window ownership drifted`);
  requireEvidence(roleA.visible === false && roleA.focused === false &&
    roleB.visible === true && roleB.focused === true &&
    window.visible === true && window.focused === true,
  `${input.label}: hidden/foreground presentation drifted`);
  requireEvidence(Number.isSafeInteger(window.parentNativeHostId) &&
    window.parentNativeHostId > 0 &&
    roleA.parentNativeHostId === window.parentNativeHostId &&
    roleB.parentNativeHostId === window.parentNativeHostId,
  `${input.label}: Roles do not share the exact foreground native parent`);
  if (input.platform === "macos") {
    requireEvidence(roleA.appKitIdentity?.logicalWindowId === input.windowId &&
      roleB.appKitIdentity?.logicalWindowId === input.windowId &&
      window.appKitIdentity?.logicalWindowId === input.windowId,
    `${input.label}: retained AppKit identity is missing`);
  } else {
    requireEvidence(roleA.appKitIdentity === null && roleB.appKitIdentity === null &&
      window.appKitIdentity === null,
    `${input.label}: Windows unexpectedly reported AppKit identity`);
  }
  const topology = evidence.topology;
  requireEvidence(topology?.hostKind === (input.platform === "macos" ? "appkit" : "windows"),
    `${input.label}: native topology host drifted`);
  requireEvidence(JSON.stringify(topology.tabIds) === JSON.stringify([
    input.tabA,
    input.tabB
  ]), `${input.label}: native tab order drifted`);
  requireEvidence(topology.surfaces?.filter(({ visible }) => visible).length === 1 &&
    topology.surfaces.find(({ visible }) => visible)?.tabId === input.tabB &&
    topology.surfaces.find(({ tabId }) => tabId === input.tabA)?.visible === false,
  `${input.label}: exactly Role B must remain visible`);
}

export async function validateChromiumMacroBackgroundTabRuntimeEvidence(input) {
  if (!isChromiumMacroBackgroundTabPhase(input.phase)) return undefined;
  const evidence = JSON.parse(await readFile(resolve(
    input.phaseDirectory,
    "chromium-macro-background-tab-evidence.json"
  ), "utf8"));
  const rootKeys = [
    "continuityHold", "finalConsumerPressedCodes", "finalMacroStatuses",
    "finalRoleStatuses", "firstCleanup", "firstConsumerKeydown",
    "firstHiddenEvent", "firstHiddenKeydown", "firstHiddenPresentation",
    "firstHold", "firstKeydown", "firstKeyup", "gameId", "gameWindowId",
    "hiddenStartPresentation", "macroId", "platform", "probe", "roleAId",
    "roleBId", "roleBDigit2Events", "roleBKeyup", "secondCleanup",
    "secondHiddenEvent", "secondHiddenPresentation", "secondHiddenStartHold",
    "secondKeydown", "secondKeyup", "tabA", "tabB"
  ];
  requireEvidence(exactKeys(evidence, rootKeys), `${input.phase}: root shape drifted`);
  requireEvidence(evidence.platform === input.platform &&
    evidence.probe?.platform === input.platform,
  `${input.phase}: paired platform probe drifted`);

  for (const [label, presentation] of [
    ["first hidden", evidence.firstHiddenPresentation],
    ["second hidden", evidence.secondHiddenPresentation],
    ["hidden start", evidence.hiddenStartPresentation]
  ]) {
    requireHiddenPresentation(presentation, {
      label,
      platform: input.platform,
      tabA: evidence.tabA,
      tabB: evidence.tabB,
      windowId: evidence.gameWindowId
    });
  }
  requireEvidence(evidence.firstHiddenEvent?.kind === "hidden" &&
    evidence.firstHiddenEvent.roleId === "chromium-background-a" &&
    evidence.firstHiddenEvent.hidden === true,
  `${input.phase}: first hidden DOM event drifted`);
  requireEvidence(evidence.secondHiddenEvent?.kind === "hidden" &&
    evidence.secondHiddenEvent.roleId === "chromium-background-a" &&
    evidence.secondHiddenEvent.hidden === true,
  `${input.phase}: second hidden DOM event drifted`);

  requireTrustedKey(evidence.firstKeydown, {
    code: "Digit2", kind: "keydown", label: "first start", roleId: "chromium-background-a"
  });
  requireTrustedKey(evidence.firstConsumerKeydown, {
    code: "Digit2", kind: "consumer-keydown", label: "first consumer start",
    roleId: "chromium-background-a"
  });
  requireTrustedKey(evidence.firstKeyup, {
    code: "Digit2", kind: "keyup", label: "first stop", roleId: "chromium-background-a"
  });
  requireTrustedKey(evidence.secondKeydown, {
    code: "Digit2", kind: "keydown", label: "hidden start", roleId: "chromium-background-a"
  });
  requireTrustedKey(evidence.secondKeyup, {
    code: "Digit2", kind: "keyup", label: "second stop", roleId: "chromium-background-a"
  });
  requireTrustedKey(evidence.roleBKeyup, {
    code: "KeyZ", kind: "keyup", label: "visible sibling operation",
    roleId: "chromium-background-b"
  });

  for (const [label, observation, intent, actionPhase] of [
    ["first hold", evidence.firstHold, "normal", "hold"],
    ["first cleanup", evidence.firstCleanup, "cleanup", "release"],
    ["hidden start hold", evidence.secondHiddenStartHold, "normal", "hold"],
    ["second cleanup", evidence.secondCleanup, "cleanup", "release"]
  ]) {
    requireInputObservation(observation, {
      intent,
      label,
      phase: actionPhase,
      roleId: evidence.roleAId
    });
  }
  requireEvidence(evidence.firstHold.sequence < evidence.firstCleanup.sequence &&
    evidence.firstCleanup.sequence < evidence.secondHiddenStartHold.sequence &&
    evidence.secondHiddenStartHold.sequence < evidence.secondCleanup.sequence,
  `${input.phase}: trusted-input sequence did not advance`);
  requireEvidence(
    evidence.firstHold.request.action.ownerId !==
      evidence.secondHiddenStartHold.request.action.ownerId,
    `${input.phase}: second hidden start reused the prior Macro owner`
  );

  if (input.platform === "windows") {
    requireInputObservation(evidence.continuityHold, {
      intent: "normal",
      label: "hidden continuity hold",
      phase: "hold",
      roleId: evidence.roleAId
    });
    requireTrustedKey(evidence.firstHiddenKeydown, {
      code: "Digit2", kind: "keydown", label: "hidden continuity DOM receipt",
      roleId: "chromium-background-a"
    });
    requireEvidence(evidence.continuityHold.sequence > evidence.firstHold.sequence &&
      evidence.continuityHold.sequence < evidence.firstCleanup.sequence &&
      evidence.continuityHold.request.action.ownerId ===
        evidence.firstHold.request.action.ownerId &&
      evidence.firstHiddenKeydown.sequence > evidence.firstHiddenEvent.sequence,
    `${input.phase}: Windows hidden continuity was not the same held owner`);
  } else {
    requireEvidence(evidence.continuityHold === null &&
      evidence.firstHiddenKeydown === null,
    `${input.phase}: retained AppKit evidence unexpectedly claimed Windows replay`);
  }

  requireEvidence(evidence.secondKeydown.sequence > evidence.secondHiddenEvent.sequence,
    `${input.phase}: hidden Macro start reached the DOM before the target was hidden`);
  requireEvidence(Array.isArray(evidence.roleBDigit2Events) &&
    evidence.roleBDigit2Events.length === 0,
  `${input.phase}: visible Role B received target Digit2 input`);
  requireEvidence(Array.isArray(evidence.finalConsumerPressedCodes) &&
    !evidence.finalConsumerPressedCodes.includes("Digit2") &&
    Array.isArray(evidence.finalMacroStatuses) &&
    evidence.finalMacroStatuses.length === 0,
  `${input.phase}: final Macro or held consumer input did not terminalize`);
  requireEvidence(Array.isArray(evidence.finalRoleStatuses) &&
    evidence.finalRoleStatuses.length === 2 &&
    evidence.finalRoleStatuses.every((status) => status.state === "running" &&
      status.automationState === "ready" && status.issueReason === undefined),
  `${input.phase}: Role input readiness degraded or restarted`);
  return {
    backgroundStartRequestId: evidence.secondHiddenStartHold.request.requestId,
    continuityRequestId: evidence.continuityHold?.request.requestId ?? null,
    gameWindowId: evidence.gameWindowId,
    hostKind: evidence.hiddenStartPresentation.window.currentRuntime.hostKind,
    macroId: evidence.macroId,
    parentNativeHostId:
      evidence.hiddenStartPresentation.window.currentRuntime.parentNativeHostId,
    roleIds: [evidence.roleAId, evidence.roleBId],
    tabIds: [evidence.tabA, evidence.tabB]
  };
}

export function validateChromiumMacroBackgroundTabSqliteEvidence(input) {
  if (!isChromiumMacroBackgroundTabPhase(input.phase)) return undefined;
  const { entities, settings } = input;
  const games = entities.games.filter(({ name }) => name ===
    "Chromium Background Tab Game");
  const roles = entities.roles.filter(({ name }) => [
    "Chromium Background Tab Role A",
    "Chromium Background Tab Role B"
  ].includes(name));
  const macros = entities.macros.filter(({ name }) => name ===
    "Chromium Background Tab Macro");
  const windows = entities.gameWindows.filter(({ name }) => name ===
    "Chromium Background Tab");
  requireEvidence(games.length === 1, `${input.phase}: exact Game is missing`);
  requireEvidence(roles.length === 2 && roles.every(({ payload }) =>
    payload?.gameId === games[0].id), `${input.phase}: exact two Roles are missing`);
  requireEvidence(macros.length === 1, `${input.phase}: exact Macro is missing`);
  requireEvidence(windows.length === 1 && windows[0].payload?.tabs?.length === 2,
    `${input.phase}: exact two-tab Game Window is missing`);
  const roleA = roles.find(({ name }) => name.endsWith("Role A"));
  const roleB = roles.find(({ name }) => name.endsWith("Role B"));
  const macro = macros[0].payload;
  requireEvidence(JSON.stringify(macro?.roleIds) === JSON.stringify([roleA?.id]) &&
    macro?.activationMode === "toggle" && macro?.enabled === true &&
    macro?.repeat?.type === "once" && macro?.steps?.length === 1,
  `${input.phase}: Macro owner or lifecycle drifted`);
  requireEvidence(macro.steps[0]?.type === "key" &&
    macro.steps[0].action === "hold_until_stop" &&
    macro.steps[0].code === "Digit2" &&
    macro.steps[0].id === "chromium-background-held-key",
  `${input.phase}: held Digit2 step drifted`);
  requireEvidence(macro.trigger?.code === "Digit4" &&
    macro.trigger.shift === true && macro.trigger.alt === false &&
    macro.trigger.ctrl === false && macro.trigger.meta === false,
  `${input.phase}: Shift+Digit4 trigger drifted`);
  requireEvidence(macro.shortcutSourceScope?.type === "selected_roles" &&
    JSON.stringify(macro.shortcutSourceScope.roleIds) === JSON.stringify([
      roleA?.id,
      roleB?.id
    ]), `${input.phase}: exact Role A/B shortcut-source scope drifted`);
  const roleIds = new Set(roles.map(({ id }) => id));
  requireEvidence(windows[0].payload.tabs.every((tab) =>
    tab.tabType === "role" && roleIds.has(tab.sourceId)),
  `${input.phase}: saved window lost its exact Role tabs`);
  const restoreSession = settings.find(({ key }) => key ===
    "runtimeRestoreSession")?.payload;
  requireEvidence(restoreSession?.schemaVersion === 2 && restoreSession.cleanExit === true,
    `${input.phase}: clean schema-v2 lifecycle journal is missing`);
  return {
    cleanExit: true,
    gameId: games[0].id,
    macroId: macros[0].id,
    roleIds: roles.map(({ id }) => id).sort(),
    tabIds: windows[0].payload.tabs.map(({ id }) => id),
    windowId: windows[0].id
  };
}
