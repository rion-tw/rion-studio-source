import { describe, expect, it, vi } from "vitest";

import { RustStateRepository } from "../src/main/core/RustStateRepository";

describe("RustStateRepository", () => {
  it("sends single-key writes without reading or serializing the whole snapshot in JavaScript", async () => {
    const invoke = vi.fn(async () => ({ revision: 1 }));
    const repository = new RustStateRepository({ invoke } as never);
    const settings = { launchMode: "embedded" };

    await repository.replace("gameBrowserSettings", settings as never);

    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith({
      type: "gameBrowserSettingsReplace",
      settings
    });
  });

  it("keeps multi-store portable imports on one snapshot transaction", async () => {
    const invoke = vi.fn(async (command: { type: string }) =>
      command.type === "stateSnapshot"
        ? { games: [], roles: [], launchWorkspaces: [], macros: [], compatibilityReports: [] }
        : { revision: 1 }
    );
    const repository = new RustStateRepository({ invoke } as never);

    await repository.replaceMany({ games: [{ id: "g1", name: "Game" }] as never });

    expect(invoke).toHaveBeenNthCalledWith(1, { type: "stateSnapshot" });
    expect(invoke).toHaveBeenNthCalledWith(2, expect.objectContaining({
      type: "portableCommit",
      snapshot: expect.objectContaining({ games: [{ id: "g1", name: "Game" }] })
    }));
  });

  it("sends collection deltas instead of serializing unchanged records", async () => {
    const initial = {
      games: [{ id: "g1", name: "First" }],
      roles: [],
      launchWorkspaces: [],
      macros: [],
      compatibilityReports: []
    };
    const invoke = vi.fn(async (command: { type: string }) =>
      command.type === "stateSnapshot" ? initial : { revision: 2 }
    );
    const repository = new RustStateRepository({ invoke } as never);
    await repository.read("games", []);

    await repository.replace("games", [
      initial.games[0],
      { id: "g2", name: "Second" }
    ] as never);

    expect(invoke).toHaveBeenLastCalledWith({
      type: "gamesApplyDelta",
      upserts: [{ id: "g2", name: "Second" }],
      deleteIds: [],
      orderedIds: ["g1", "g2"]
    });
  });
});
