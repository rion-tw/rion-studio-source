import { describe, expect, it, vi } from "vitest";

import { GameBrowserSettingsStore } from "../src/main/game-browser/GameBrowserSettingsStore";

describe("typed core settings adapter", () => {
  it("sends a generated command without snapshot serialization in JavaScript", async () => {
    const invoke = vi.fn(async () => ({ revision: 1 }));
    const store = new GameBrowserSettingsStore("/unused", { invoke } as never);
    const settings = { launchMode: "embedded" };

    await store.updateSettings(settings as never);

    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith({
      type: "gameBrowserSettingsReplace",
      settings
    });
  });
});
