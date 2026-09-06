import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const phases = Object.freeze([
  "chromium-macro-cutover-input-recovery",
  "chromium-macro-cutover-keyboard",
  "chromium-macro-cutover-terminal-cleanup-seed",
  "chromium-macro-cutover-terminal-cleanup-restart",
  "chromium-macro-cutover-topology-seed",
  "chromium-macro-cutover-topology-restart"
]);

const replacements = Object.freeze([
  ["MACRO-INPUT-RECOVERY-011", "P1", "macros", ["success", "failure"],
    ["chromium-macro-cutover-input-recovery"]],
  ["MACRO-MIDDLE-BUTTON-013", "P0", "macros", ["success", "failure"],
    ["chromium-macro-cutover-keyboard"]],
  ["MACRO-MODIFIER-CONTINUITY-008", "P0", "macros", ["success", "failure"],
    ["chromium-macro-cutover-keyboard"]],
  ["MACRO-MULTIROLE-005", "P1", "macros", ["success", "failure"],
    ["chromium-macro-cutover-topology-seed"]],
  ["MACRO-OWNERSHIP-TRANSFER-010", "P1", "macros",
    ["success", "failure", "restart"], [
      "chromium-macro-cutover-topology-seed",
      "chromium-macro-cutover-topology-restart"
    ]],
  ["MACRO-SHORTCUT-REENTRY-007", "P0", "macros", ["success", "failure"],
    ["chromium-macro-cutover-keyboard"]],
  ["MACRO-TERMINAL-CLEANUP-006", "P0", "macros",
    ["success", "failure", "restart"], [
      "chromium-macro-cutover-terminal-cleanup-seed",
      "chromium-macro-cutover-terminal-cleanup-restart"
    ]],
  ["ROLE-KEY-BLUR-004", "P0", "roles", ["success", "failure"],
    ["chromium-macro-cutover-keyboard"]]
]);

export const chromiumMacroCutoverReplacementPlan = Object.freeze(
  replacements.flatMap(([sourceId, priority, feature, outcomes, journeyPhases]) =>
    ["macos", "windows"].map((platform) => Object.freeze({
      feature,
      id: platform === "macos"
        ? `CHROMIUM-MACOS-APPKIT-${sourceId}`
        : `CHROMIUM-WINDOWS-${sourceId}`,
      kind: "native",
      outcomes,
      phases: platform === "windows"
        ? ["chromium-windows-trusted-input-physical", ...journeyPhases]
        : journeyPhases,
      platform,
      priority,
      replaces: [sourceId],
      risk: "native"
    }))
  )
);

export const chromiumMacroCutoverPhaseDependencies = Object.freeze([
  [
    "chromium-macro-cutover-terminal-cleanup-restart",
    ["chromium-macro-cutover-terminal-cleanup-seed"]
  ],
  [
    "chromium-macro-cutover-topology-restart",
    ["chromium-macro-cutover-topology-seed"]
  ]
]);

export const chromiumMacroCutoverPhaseNamespaces = Object.freeze([
  ["chromium-macro-cutover-input-recovery", "chromium-macro-cutover-input-recovery"],
  ["chromium-macro-cutover-keyboard", "chromium-macro-cutover-keyboard"],
  [
    "chromium-macro-cutover-terminal-cleanup-seed",
    "chromium-macro-cutover-terminal-cleanup"
  ],
  [
    "chromium-macro-cutover-terminal-cleanup-restart",
    "chromium-macro-cutover-terminal-cleanup"
  ],
  ["chromium-macro-cutover-topology-seed", "chromium-macro-cutover-topology"],
  ["chromium-macro-cutover-topology-restart", "chromium-macro-cutover-topology"]
]);

const artifactByPhase = Object.freeze({
  "chromium-macro-cutover-input-recovery":
    "chromium-macro-input-recovery-evidence.json",
  "chromium-macro-cutover-keyboard": "chromium-macro-keyboard-cutover-evidence.json",
  "chromium-macro-cutover-terminal-cleanup-seed":
    "chromium-macro-terminal-cleanup-seed.json",
  "chromium-macro-cutover-terminal-cleanup-restart":
    "chromium-macro-terminal-cleanup-restart.json",
  "chromium-macro-cutover-topology-seed": "chromium-macro-topology-seed-evidence.json",
  "chromium-macro-cutover-topology-restart":
    "chromium-macro-topology-restart-evidence.json"
});

function requireEvidence(condition, message) {
  if (!condition) throw new Error(`Desktop E2E Macro evidence failed: ${message}`);
}

export function isChromiumMacroCutoverPhase(candidate) {
  return phases.includes(candidate);
}

/** Shared by the visible native probe and every Macro cutover post-phase gate. */
export function validateWindowsPhysicalInputEvidence(evidence) {
  const requireView = (condition) => requireEvidence(condition,
    "Windows physical input did not prove exact foreground and hidden trusted DOM effects");
  const positive = (value) => Number.isSafeInteger(value) && value > 0;
  const token = (value) => typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
  const identityKeys = ["roleId", "surfaceGeneration", "nativeGeneration",
    "bindingRevision", "parentIdentity", "webContentsId"];
  const sameIdentity = (left, right) => identityKeys.every((key) => left?.[key] === right?.[key]);
  requireView(evidence?.candidateEvidence === "foreground-and-hidden-product-path"
    && evidence.platform === "win32" && evidence.ownerKind === "view"
    && evidence.exactSiblingViews === true && evidence.hiddenPresentationPreserved === true
    && evidence.focusReceipt?.status === "applied" && evidence.hiddenFocusReceipt?.status === "applied"
    && evidence.viewportAcknowledgement?.status === "applied"
    && Number.isFinite(evidence.displayScaleFactor) && evidence.displayScaleFactor > 0);
  const { foregroundProbe: foreground, controlProbe: control, hiddenProbe: hidden, finalProbe: final } = evidence;
  for (const [probe, visible] of [[foreground, true], [control, true], [hidden, false], [final, false]]) {
    const observation = probe?.observation;
    requireView(probe?.ownerKind === "view" && probe.status === "verified"
      && typeof probe.roleId === "string" && probe.roleId.length > 0
      && positive(probe.surfaceGeneration) && positive(probe.nativeGeneration)
      && typeof probe.bindingRevision === "string" && /^[1-9][0-9]*$/u.test(probe.bindingRevision)
      && positive(probe.webContentsId) && token(probe.parentIdentity)
      && probe.parentIdentity === foreground.parentIdentity
      && sameIdentity(probe, observation?.identity)
      && observation?.parentIdentity === probe.parentIdentity
      && observation.parentForeground === true && observation.parentVisible === true
      && observation.parentMinimized === false && observation.viewAttached === true
      && observation.viewVisible === visible && observation.contentsDestroyed === false
      && observation.contentsFocused === visible && token(observation.focusIdentity)
      && observation.focusedWebContentsId === (visible ? probe.webContentsId : control?.webContentsId)
      && Number.isFinite(observation.bounds?.width) && observation.bounds.width > 0
      && Number.isFinite(observation.bounds?.height) && observation.bounds.height > 0);
  }
  requireView(foreground.webContentsId !== control.webContentsId
    && sameIdentity(foreground, hidden) && sameIdentity(foreground, final)
    && final.observation.focusIdentity === hidden.observation.focusIdentity
    && final.observation.zoomFactor === 1.25
    && evidence.viewportAcknowledgement.width === Math.round(final.observation.bounds.width / 1.25)
    && evidence.viewportAcknowledgement.height === Math.round(final.observation.bounds.height / 1.25));
  for (const receipt of [evidence.keyDom, evidence.mouseDom, evidence.hiddenKeyDom, evidence.hiddenMouseDom]) {
    requireView(receipt?.received === true && Array.isArray(receipt.value) && receipt.value.length > 0
      && receipt.value.every((entry) => entry?.isTrusted === true && entry.matches === true));
  }
}

async function windowsPhysicalEvidence(phaseDirectory) {
  const path = resolve(
    phaseDirectory,
    "..",
    "chromium-windows-trusted-input-physical",
    "windows-input-physical-probe.log"
  );
  const log = await readFile(path, "utf8");
  const prefix = "RION_ELECTRON_WINDOWS_CHROMIUM_INPUT_PROBE=";
  const line = log.split(/\r?\n/u).find((candidate) => candidate.startsWith(prefix));
  requireEvidence(line, "Windows physical View evidence is absent");
  const evidence = JSON.parse(line.slice(prefix.length));
  validateWindowsPhysicalInputEvidence(evidence);
  return evidence;
}

export async function validateChromiumMacroCutoverRuntimeEvidence(input) {
  if (!isChromiumMacroCutoverPhase(input.phase)) return undefined;
  const artifact = artifactByPhase[input.phase];
  requireEvidence(artifact, `${input.phase}: runtime artifact is not registered`);
  const evidence = JSON.parse(await readFile(resolve(input.phaseDirectory, artifact), "utf8"));
  requireEvidence(evidence.platform === input.platform,
    `${input.phase}: runtime platform evidence mismatched`);
  const bindings = [
    evidence.binding,
    evidence.nativeBinding,
    evidence.bindingAfter,
    evidence.bindingBefore
  ].filter(Boolean);
  requireEvidence(bindings.length > 0,
    `${input.phase}: no exact native Role binding was recorded`);
  const expectedHostKind = input.platform === "macos"
    ? "appkit-chromium"
    : "bundled-chromium";
  requireEvidence(bindings.every((binding) =>
    binding.hostKind === expectedHostKind
      && Number.isSafeInteger(binding.ownerGeneration)
      && binding.ownerGeneration > 0
      && Number.isSafeInteger(binding.surfaceGeneration)
      && binding.surfaceGeneration > 0
  ), `${input.phase}: native Role binding is not exact`);
  const physical = input.platform === "windows"
    ? await windowsPhysicalEvidence(input.phaseDirectory)
    : undefined;
  return {
    artifact,
    bindingCount: bindings.length,
    hostKind: expectedHostKind,
    physicalEvidence: physical?.candidateEvidence
  };
}

function entitiesNamed(entities, collection, names) {
  return entities[collection].filter((entry) => names.includes(entry.name));
}

function cleanRestoreSession(settings, phase) {
  const session = settings.find((setting) => setting.key === "runtimeRestoreSession")
    ?.payload;
  requireEvidence(session?.cleanExit === true,
    `${phase}: final lifecycle did not persist cleanExit=true`);
  return session;
}

export function validateChromiumMacroCutoverSqliteEvidence(input) {
  if (!isChromiumMacroCutoverPhase(input.phase)) return undefined;
  const { entities, phase, settings } = input;
  const session = cleanRestoreSession(settings, phase);
  if (phase === "chromium-macro-cutover-input-recovery") {
    const roles = entitiesNamed(entities, "roles", ["Chromium Macro Input Recovery Role"]);
    const macros = entitiesNamed(entities, "macros", ["Chromium Macro Input Recovery"]);
    requireEvidence(roles.length === 1 && macros.length === 1,
      `${phase}: exact Role/Macro pair is absent`);
    requireEvidence(macros[0].payload?.repeat?.type === "loop"
      && macros[0].payload?.repeat?.intervalMs === 0
      && macros[0].payload?.roleIds?.[0] === roles[0].id,
    `${phase}: zero-interval recovery Macro lost exact ownership`);
  } else if (phase === "chromium-macro-cutover-keyboard") {
    const macros = entitiesNamed(entities, "macros", [
      "Chromium Shortcut Reentry",
      "Chromium Modifier Continuity",
      "Chromium Middle Held",
      "Chromium Three Button Output"
    ]);
    requireEvidence(macros.length === 4,
      `${phase}: exact shortcut/modifier/middle Macro cohort is absent`);
    requireEvidence(macros.some((macro) => macro.payload?.trigger?.code === "Digit2")
      && macros.some((macro) => macro.payload?.trigger?.code === "Digit5")
      && macros.some((macro) => macro.payload?.trigger?.button === "middle")
      && macros.some((macro) => macro.payload?.steps?.map((step) =>
        step.button ?? (step.type === "click" ? "left" : undefined))
        .join("|") === "left|middle|right"),
    `${phase}: exact keyboard and three-button contracts were not persisted`);
  } else if (phase.startsWith("chromium-macro-cutover-topology")) {
    const roles = entitiesNamed(entities, "roles", [
      "Chromium Macro Shared Role",
      "Chromium Macro Multirole B"
    ]);
    const macros = entitiesNamed(entities, "macros", [
      "Chromium Macro Multirole",
      "Chromium Macro Ownership Single"
    ]);
    const workspaces = entitiesNamed(entities, "workspaces", [
      "Chromium Macro Workspace A",
      "Chromium Macro Workspace B"
    ]);
    requireEvidence(roles.length === 2 && macros.length === 2 && workspaces.length === 2,
      `${phase}: mixed Role/Workspace/Macro cohort is absent`);
    requireEvidence(macros.some((macro) => macro.payload?.roleIds?.length === 2)
      && macros.some((macro) => macro.payload?.roleIds?.length === 1)
      && workspaces.some((workspace) => workspace.payload?.slots?.some((slot) => slot.web)),
    `${phase}: mixed Web/Role slots or exact Macro ownership were lost`);
  } else {
    const roles = entitiesNamed(entities, "roles", [
      "Chromium Cleanup Parent Role",
      "Chromium Cleanup Tab Role",
      "Chromium Cleanup Window Role",
      "Chromium Cleanup Shutdown Role"
    ]);
    const macros = entitiesNamed(entities, "macros", [
      "Chromium Cleanup Child",
      "Chromium Cleanup Parent",
      "Chromium Cleanup Tab Macro",
      "Chromium Cleanup Window Macro",
      "Chromium Cleanup Shutdown Macro"
    ]);
    requireEvidence(roles.length === 4 && macros.length === 5,
      `${phase}: terminal-cleanup Role/Macro cohort is absent`);
    requireEvidence(macros.filter((macro) => macro.payload?.steps?.some((step) =>
      step.type === "key" && step.action === "hold_until_stop"
    )).length === 3, `${phase}: exact held-key cleanup cohort is absent`);
  }
  return {
    cleanExit: session.cleanExit,
    phase
  };
}
