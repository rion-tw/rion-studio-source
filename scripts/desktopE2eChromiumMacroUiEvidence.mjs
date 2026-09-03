const macroUiPhases = Object.freeze([
  "chromium-macro-ui-seed",
  "chromium-macro-ui-restart"
]);

export const chromiumMacroUiPhaseDependencies = Object.freeze([
  [
    "chromium-macro-ui-seed",
    ["chromium-entity-persistence-seed", "chromium-entity-persistence-restart"]
  ],
  [
    "chromium-macro-ui-restart",
    [
      "chromium-entity-persistence-seed",
      "chromium-entity-persistence-restart",
      "chromium-macro-ui-seed"
    ]
  ]
]);

export const chromiumMacroUiPhaseNamespaces = Object.freeze(
  macroUiPhases.map((phase) => [
    phase,
    "chromium-entity-persistence-lifecycle"
  ])
);

export function isChromiumMacroUiPhase(phase) {
  return macroUiPhases.includes(phase);
}

function requireEvidence(condition, message) {
  if (!condition) throw new Error(`Desktop E2E SQLite evidence failed: ${message}`);
}

export function validateChromiumMacroUiSqliteEvidence(phase, entities, settings) {
  const roles = entities.roles.filter(
    (role) => role.name === "Chromium Entity Role Edited"
  );
  const macros = entities.macros.filter(
    (macro) => macro.name === "Chromium Macro UI Delay"
  );
  requireEvidence(roles.length === 1, `${phase}: expected one Macro UI Role`);
  requireEvidence(macros.length === 1, `${phase}: expected one Macro UI Macro`);
  const payload = macros[0].payload;
  requireEvidence(
    Array.isArray(payload?.roleIds)
      && payload.roleIds.length === 1
      && payload.roleIds[0] === roles[0].id,
    `${phase}: Macro UI Macro lost its exact Role assignment`
  );
  requireEvidence(
    payload?.trigger === undefined || payload.trigger === null,
    `${phase}: rejected Quick Access shortcut was unexpectedly persisted`
  );
  requireEvidence(
    payload?.steps?.length === 1
      && payload.steps[0]?.type === "delay"
      && payload.steps[0]?.ms === 60_000,
    `${phase}: portable delay-only Macro step was not persisted exactly`
  );
  requireEvidence(
    payload?.enabled === true,
    `${phase}: visible Macro authoring did not retain an enabled Macro`
  );
  const restoreSession = settings.find(
    (setting) => setting.key === "runtimeRestoreSession"
  )?.payload;
  requireEvidence(
    restoreSession?.cleanExit === true,
    `${phase}: Macro UI phase did not reach a clean final flush`
  );
  return {
    cleanExit: true,
    macroId: macros[0].id,
    reservedShortcutPersisted: false,
    restartVerified: phase === "chromium-macro-ui-restart",
    roleId: roles[0].id,
    step: { ms: 60_000, type: "delay" }
  };
}
