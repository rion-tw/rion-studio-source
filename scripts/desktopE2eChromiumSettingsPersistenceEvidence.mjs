const settingsPersistencePhases = Object.freeze([
  "chromium-settings-persistence-seed",
  "chromium-settings-persistence-restart"
]);

export const chromiumSettingsPersistencePhaseDependencies = Object.freeze([
  [
    "chromium-settings-persistence-seed",
    ["chromium-entity-persistence-seed", "chromium-entity-persistence-restart"]
  ],
  [
    "chromium-settings-persistence-restart",
    [
      "chromium-entity-persistence-seed",
      "chromium-entity-persistence-restart",
      "chromium-settings-persistence-seed"
    ]
  ]
]);

export const chromiumSettingsPersistencePhaseNamespaces = Object.freeze(
  settingsPersistencePhases.map((phase) => [
    phase,
    "chromium-entity-persistence-lifecycle"
  ])
);

export function isChromiumSettingsPersistencePhase(phase) {
  return settingsPersistencePhases.includes(phase);
}

function requireEvidence(condition, message) {
  if (!condition) throw new Error(`Desktop E2E SQLite evidence failed: ${message}`);
}

export function validateChromiumSettingsPersistenceSqliteEvidence(
  phase,
  entities,
  settings
) {
  const roles = entities.roles.filter(
    (role) => role.name === "Chromium Entity Role Edited"
  );
  const macros = entities.macros.filter(
    (macro) => macro.name === "Chromium Entity Macro Edited"
  );
  requireEvidence(roles.length === 1, `${phase}: expected one settings-journey Role`);
  requireEvidence(macros.length === 1, `${phase}: expected one settings-journey Macro`);
  requireEvidence(
    macros[0].payload?.roleIds?.includes(roles[0].id),
    `${phase}: settings-journey Macro lost its Role binding`
  );
  requireEvidence(
    macros[0].payload?.steps?.length === 1
      && macros[0].payload.steps[0]?.type === "delay"
      && macros[0].payload.steps[0]?.ms === 60_000,
    `${phase}: portable Macro execution precondition was not persisted`
  );

  const preferences = settings.find(
    (setting) => setting.key === "runtimeWindowPreferences"
  )?.payload;
  requireEvidence(
    preferences?.alwaysHideTabCloseButton === true
      && preferences?.alwaysShowToolbarInFullScreen === false
      && preferences?.restoreGameWindowsOnStartup === true,
    `${phase}: exact Game Window behavior preferences were not persisted`
  );
  const browserSettings = settings.find(
    (setting) => setting.key === "gameBrowserSettings"
  )?.payload;
  requireEvidence(
    browserSettings?.macroOverlay?.showClickMarkers === false
      && browserSettings?.macroOverlay?.showRunningBadges === false
      && browserSettings?.macroOverlay?.showToolButton === false,
    `${phase}: exact in-game Macro UI preferences were not persisted`
  );
  const restoreSession = settings.find(
    (setting) => setting.key === "runtimeRestoreSession"
  )?.payload;
  requireEvidence(
    restoreSession?.cleanExit === true,
    `${phase}: settings persistence phase did not reach a clean final flush`
  );
  return {
    cleanExit: true,
    macroId: macros[0].id,
    preferencesPersisted: true,
    restartVerified: phase === "chromium-settings-persistence-restart",
    roleId: roles[0].id
  };
}
