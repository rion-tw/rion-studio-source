function requireEvidence(condition, message) {
  if (!condition) throw new Error(`Desktop E2E SQLite evidence failed: ${message}`);
}

export function validateChromiumGameCrudSqliteEvidence(phase, entities) {
  const edited = entities.games.filter((game) => game.name === "Chromium E2E Game Edited");
  const preEdit = entities.games.filter((game) => game.name === "Chromium E2E Game");

  requireEvidence(
    phase === "chromium-game-crud-seed" || phase === "chromium-game-crud-restart",
    `${phase}: unexpected Chromium Game CRUD phase`
  );
  requireEvidence(
    preEdit.length === 0,
    `${phase}: the pre-edit Chromium Game record remained persisted`
  );

  if (phase === "chromium-game-crud-seed") {
    requireEvidence(
      edited.length === 1,
      `${phase}: expected exactly one persisted Chromium E2E Game Edited record`
    );
    requireEvidence(
      edited[0]?.payload?.defaultLaunchUrl?.endsWith("/role/chromium-game-crud") === true,
      `${phase}: persisted Chromium Game lost its fixture launch URL`
    );
    return {
      editedGameId: edited[0].id,
      entityCounts: Object.fromEntries(
        Object.entries(entities).map(([key, values]) => [key, values.length])
      ),
      restartVerified: false
    };
  }

  requireEvidence(
    edited.length === 0,
    `${phase}: visibly deleted Chromium E2E Game Edited record remained persisted`
  );
  return {
    deletedEditedGameCount: edited.length,
    entityCounts: Object.fromEntries(
      Object.entries(entities).map(([key, values]) => [key, values.length])
    ),
    restartVerified: true
  };
}
