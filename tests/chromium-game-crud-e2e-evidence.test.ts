import { describe, expect, it } from "vitest";

import { validateChromiumGameCrudSqliteEvidence } from
  "../scripts/desktopE2eChromiumGameCrudEvidence.mjs";

function entities(games: ReadonlyArray<Record<string, unknown>>) {
  return {
    gameWindows: [],
    games,
    macros: [],
    roles: [],
    workspaces: []
  };
}

describe("Chromium Game CRUD SQLite evidence", () => {
  it("requires the edited Game after the seed phase", () => {
    expect(validateChromiumGameCrudSqliteEvidence(
      "chromium-game-crud-seed",
      entities([{
        id: "game-1",
        name: "Chromium E2E Game Edited",
        payload: { defaultLaunchUrl: "http://127.0.0.1/role/chromium-game-crud" }
      }])
    )).toEqual({
      editedGameId: "game-1",
      entityCounts: {
        gameWindows: 0,
        games: 1,
        macros: 0,
        roles: 0,
        workspaces: 0
      },
      restartVerified: false
    });
  });

  it("requires the visibly confirmed deletion as the restart terminal state", () => {
    expect(validateChromiumGameCrudSqliteEvidence(
      "chromium-game-crud-restart",
      entities([])
    )).toEqual({
      deletedEditedGameCount: 0,
      entityCounts: {
        gameWindows: 0,
        games: 0,
        macros: 0,
        roles: 0,
        workspaces: 0
      },
      restartVerified: true
    });
  });

  it("rejects a deleted Game that remains in the restart snapshot", () => {
    expect(() => validateChromiumGameCrudSqliteEvidence(
      "chromium-game-crud-restart",
      entities([{
        id: "game-1",
        name: "Chromium E2E Game Edited",
        payload: { defaultLaunchUrl: "http://127.0.0.1/role/chromium-game-crud" }
      }])
    )).toThrow("visibly deleted Chromium E2E Game Edited record remained persisted");
  });
});
