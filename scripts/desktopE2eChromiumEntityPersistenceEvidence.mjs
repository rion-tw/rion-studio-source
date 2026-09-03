function requireEvidence(condition, message) {
  if (!condition) throw new Error(`Desktop E2E SQLite evidence failed: ${message}`);
}

export function validateChromiumEntityPersistenceSqliteEvidence(phase, entities) {
  const expected = {
    games: "Chromium Entity Game",
    macros: "Chromium Entity Macro Edited",
    roles: "Chromium Entity Role Edited",
    workspaces: "Chromium Entity Workspace Edited"
  };
  const resolved = {};
  for (const [entityType, name] of Object.entries(expected)) {
    const matches = entities[entityType].filter((entity) => entity.name === name);
    requireEvidence(
      matches.length === 1,
      `${phase}: expected exactly one persisted Chromium ${entityType} entity ${name}`
    );
    resolved[entityType] = matches[0];
  }
  for (const oldName of [
    "Chromium Entity Role",
    "Chromium Entity Workspace",
    "Chromium Entity Macro"
  ]) {
    requireEvidence(
      !Object.values(entities).some((values) =>
        values.some((entity) => entity.name === oldName)
      ),
      `${phase}: pre-edit Chromium entity remained persisted as ${oldName}`
    );
  }
  requireEvidence(
    resolved.roles.payload?.gameId === resolved.games.id,
    `${phase}: persisted Chromium Role lost its exact Game identity`
  );
  requireEvidence(
    resolved.workspaces.payload?.slots?.some((slot) => slot.roleId === resolved.roles.id),
    `${phase}: persisted Chromium Workspace lost its Role slot identity`
  );
  requireEvidence(
    resolved.workspaces.payload?.slots?.some((slot) =>
      slot.web?.name === "Chromium fixture"
        && slot.web.startUrl?.endsWith("/role/chromium-workspace-web")
    ),
    `${phase}: persisted Chromium Workspace lost its Web slot identity`
  );
  requireEvidence(
    resolved.macros.payload?.roleIds?.includes(resolved.roles.id),
    `${phase}: persisted Chromium Macro lost its Role binding`
  );
  return {
    entityIds: Object.fromEntries(
      Object.entries(resolved).map(([key, entity]) => [key, entity.id])
    ),
    restartVerified: phase === "chromium-entity-persistence-restart"
  };
}
