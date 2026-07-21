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
      type: "stateReplace",
      key: "gameBrowserSettings",
      value: settings
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
      type: "stateReplaceSnapshot",
      snapshot: expect.objectContaining({ games: [{ id: "g1", name: "Game" }] })
    }));
  });
});
