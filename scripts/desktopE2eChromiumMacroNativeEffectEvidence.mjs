const phase = "chromium-macro-native-effect";

export const chromiumMacroNativeEffectPhaseDependencies = Object.freeze([
  [
    phase,
    ["chromium-entity-persistence-seed", "chromium-entity-persistence-restart"]
  ]
]);

export const chromiumMacroNativeEffectPhaseNamespaces = Object.freeze([
  [phase, "chromium-entity-persistence-lifecycle"]
]);

export function isChromiumMacroNativeEffectPhase(candidate) {
  return candidate === phase;
}

function requireEvidence(condition, message) {
  if (!condition) throw new Error(`Desktop E2E SQLite evidence failed: ${message}`);
}

function exactKeys(candidate, keys) {
  return candidate !== null
    && typeof candidate === "object"
    && !Array.isArray(candidate)
    && Object.keys(candidate).sort().join("|") === [...keys].sort().join("|");
}

export function validateChromiumMacroNativeEffectSqliteEvidence(
  currentPhase,
  entities,
  settings
) {
  requireEvidence(currentPhase === phase, `${currentPhase}: unexpected native-effect phase`);
  const roles = entities.roles.filter(
    (role) => role.name === "Chromium Entity Role Edited"
  );
  const macros = entities.macros.filter(
    (macro) => macro.name === "Chromium Native Effect Macro"
  );
  requireEvidence(roles.length === 1, `${currentPhase}: expected one target Role`);
  requireEvidence(macros.length === 1, `${currentPhase}: expected one native-effect Macro`);
  const payload = macros[0].payload;
  requireEvidence(
    Array.isArray(payload?.roleIds)
      && payload.roleIds.length === 1
      && payload.roleIds[0] === roles[0].id,
    `${currentPhase}: Macro lost its exact Role assignment`
  );
  requireEvidence(payload?.trigger === undefined || payload.trigger === null,
    `${currentPhase}: native-effect Macro unexpectedly persisted a trigger`);
  const steps = payload?.steps;
  requireEvidence(Array.isArray(steps) && steps.length === 5,
    `${currentPhase}: expected key, three clicks, and terminal delay`);
  requireEvidence(
    exactKeys(steps[0], ["action", "code", "id", "label", "type"])
      && steps[0].type === "key"
      && steps[0].action === "tap"
      && steps[0].code === "KeyA"
      && steps[0].label === "A",
    `${currentPhase}: exact KeyA tap was not persisted`
  );
  for (const [index, button] of [undefined, "middle", "right"].entries()) {
    const click = steps[index + 1];
    const expectedKeys = [
      "anchor", "id", "type", "unit", "xReferencePx", "yReferencePx",
      ...(button ? ["button"] : [])
    ];
    requireEvidence(
      exactKeys(click, expectedKeys)
        && click.type === "click"
        && click.button === button
        && click.unit === "reference-px"
        && click.anchor === "center"
        && click.xReferencePx === 0
        && click.yReferencePx === 0,
      `${currentPhase}: ${button ?? "left"} center click was not persisted exactly`
    );
  }
  requireEvidence(
    exactKeys(steps[4], ["id", "ms", "type"])
      && steps[4].type === "delay"
      && steps[4].ms === 60_000,
    `${currentPhase}: visible Stop guard delay was not persisted exactly`
  );
  const restoreSession = settings.find(
    (setting) => setting.key === "runtimeRestoreSession"
  )?.payload;
  requireEvidence(restoreSession?.cleanExit === true,
    `${currentPhase}: native-effect phase did not reach a clean final flush`);
  return {
    cleanExit: true,
    macroId: macros[0].id,
    roleId: roles[0].id,
    stepTypes: steps.map((step) => step.type),
    trustedInputEffects: ["KeyA", "left", "middle", "right"]
  };
}
