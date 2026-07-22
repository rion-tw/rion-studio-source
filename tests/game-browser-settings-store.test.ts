import { describe, expect, it } from "vitest";

import { GameBrowserSettingsStore } from "../src/main/game-browser/GameBrowserSettingsStore";
import { DEFAULT_GAME_BROWSER_SETTINGS } from "../src/shared/browserFonts";
import { MemoryStateRepository } from "./helpers/memoryStateRepository";

describe("GameBrowserSettingsStore", () => {
  it("reads defaults through the Rust state client when no row exists", async () => {
    const store = new GameBrowserSettingsStore("/unused", new MemoryStateRepository());
    await expect(store.getSettings()).resolves.toEqual(DEFAULT_GAME_BROWSER_SETTINGS);
  });

  it("normalizes the public input and delegates the typed write", async () => {
    const repository = new MemoryStateRepository();
    const store = new GameBrowserSettingsStore("/unused", repository);
    const saved = await store.updateSettings({
      fonts: { families: { fixed: "  Courier   New  ", standard: "Arial" }, mode: "custom" },
      graphics: { mode: "high_performance" },
      launchMode: "external",
      macroBadgePosition: { horizontalAlign: "right", horizontalMarginPx: 80, topPx: 280 },
      network: {
        cdnCompatibility: { mode: "on" },
        proxy: { mode: "custom", server: " socks5://127.0.0.1:7890/ " }
      },
      workspace: { background: "black", gap: 12 }
    });

    expect(saved.fonts.families.fixed).toBe("Courier New");
    expect(saved.network.proxy.server).toBe("socks5://127.0.0.1:7890");
    await expect(store.getSettings()).resolves.toEqual(saved);
  });
});
