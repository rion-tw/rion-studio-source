import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { GameBrowserSettingsStore } from "../src/main/game-browser/GameBrowserSettingsStore";
import { DEFAULT_GAME_BROWSER_SETTINGS } from "../src/shared/browserFonts";

describe("GameBrowserSettingsStore", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "rion-studio-game-browser-settings-"));
  });

  it("returns browser defaults when the settings file is missing or invalid", async () => {
    const store = new GameBrowserSettingsStore(baseDir);

    await expect(store.getSettings()).resolves.toEqual(DEFAULT_GAME_BROWSER_SETTINGS);

    await writeFile(join(baseDir, "game-browser-settings.json"), "{not json", "utf8");

    await expect(store.getSettings()).resolves.toEqual(DEFAULT_GAME_BROWSER_SETTINGS);
  });

  it("adds default workspace divider settings to legacy persisted settings", async () => {
    await writeFile(
      join(baseDir, "game-browser-settings.json"),
      JSON.stringify({
        fonts: { families: {}, mode: "default" },
        graphics: { mode: "automatic" },
        launchMode: "auto",
        network: { cdnCompatibility: { mode: "auto" }, proxy: { mode: "system", server: "" } }
      }),
      "utf8"
    );

    const store = new GameBrowserSettingsStore(baseDir);
    await expect(store.getSettings()).resolves.toEqual(DEFAULT_GAME_BROWSER_SETTINGS);
  });

  it("normalizes and atomically writes browser font settings", async () => {
    const store = new GameBrowserSettingsStore(baseDir);

    await expect(
      store.updateSettings({
        fonts: {
          families: {
            fixed: "  Courier   New  ",
            standard: "Arial"
          },
          mode: "custom"
        },
        graphics: { mode: "high_performance" },
        launchMode: "external",
        network: {
          cdnCompatibility: { mode: "on" },
          proxy: {
            mode: "custom",
            server: " socks5://127.0.0.1:7890/ "
          }
        },
        workspace: { divider: { size: 12, style: "black" } }
      })
    ).resolves.toEqual({
      fonts: {
        families: {
          fixed: "Courier New",
          standard: "Arial"
        },
        mode: "custom"
      },
      graphics: { mode: "high_performance" },
      launchMode: "external",
      network: {
        cdnCompatibility: { mode: "on" },
        proxy: {
          mode: "custom",
          server: "socks5://127.0.0.1:7890"
        }
      },
      workspace: { divider: { size: 12, style: "black" } }
    });

    await expect(readFile(join(baseDir, "game-browser-settings.json.tmp"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
    const firstRead = await store.getSettings();
    expect(firstRead).toEqual({
      fonts: {
        families: {
          fixed: "Courier New",
          standard: "Arial"
        },
        mode: "custom"
      },
      graphics: { mode: "high_performance" },
      launchMode: "external",
      network: {
        cdnCompatibility: { mode: "on" },
        proxy: {
          mode: "custom",
          server: "socks5://127.0.0.1:7890"
        }
      },
      workspace: { divider: { size: 12, style: "black" } }
    });
    firstRead.fonts.families.standard = "Mutated by caller";
    await expect(store.getSettings()).resolves.toMatchObject({
      fonts: { families: { standard: "Arial" } }
    });
  });
});
