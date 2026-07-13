import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyBrowserFontSettingsToPreferences,
  BrowserFontApplier,
  getChromeDefaultProfilePreferencesPath,
  getElectronPartitionPreferencesPath
} from "../src/main/game-browser/BrowserFontApplier";
import type { GameBrowserSettings } from "../src/shared/types";

const customSettings: GameBrowserSettings = {
  fonts: {
    families: {
      fixed: "Courier New",
      math: "Noto Sans Math",
      sansserif: "Helvetica",
      serif: "Times New Roman",
      standard: "Arial"
    },
    mode: "custom"
  }
};

describe("applyBrowserFontSettingsToPreferences", () => {
  it("writes only Rion-managed Chromium font family preferences in custom mode", () => {
    expect(
      applyBrowserFontSettingsToPreferences(
        {
          profile: { name: "Default" },
          webkit: {
            webprefs: {
              fonts: {
                fixed: { Zyyy: "Old Mono" },
                standard: { Zyyy: "Old Standard" }
              }
            }
          }
        },
        customSettings
      )
    ).toEqual({
      profile: { name: "Default" },
      webkit: {
        webprefs: {
          fonts: {
            fixed: { Zyyy: "Courier New" },
            math: { Zyyy: "Noto Sans Math" },
            sansserif: { Zyyy: "Helvetica" },
            serif: { Zyyy: "Times New Roman" },
            standard: { Zyyy: "Arial" }
          }
        }
      }
    });
  });

  it("deletes Rion-managed font preferences in default mode without touching unrelated prefs", () => {
    expect(
      applyBrowserFontSettingsToPreferences(
        {
          profile: { name: "Default" },
          webkit: {
            webprefs: {
              default_font_size: 16,
              fonts: {
                fixed: { Zyyy: "Courier New" },
                standard: { Zyyy: "Arial" }
              }
            }
          }
        },
        { fonts: { families: {}, mode: "default" } }
      )
    ).toEqual({
      profile: { name: "Default" },
      webkit: {
        webprefs: {
          default_font_size: 16
        }
      }
    });
  });
});

describe("BrowserFontApplier", () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "rion-studio-browser-fonts-"));
  });

  it("applies settings to Chrome Default and Electron persisted partition Preferences", async () => {
    const roleBrowserUserDataDir = join(baseDir, "role-browser");
    const appUserDataDir = join(baseDir, "app");
    const applier = new BrowserFontApplier({
      appUserDataDir,
      getSettings: vi.fn().mockResolvedValue(customSettings)
    });

    await applier.applyToRoleLaunch(roleBrowserUserDataDir, "persist:rion-role-role-1");

    await expect(readJson(getChromeDefaultProfilePreferencesPath(roleBrowserUserDataDir))).resolves.toMatchObject({
      webkit: { webprefs: { fonts: { standard: { Zyyy: "Arial" } } } }
    });
    await expect(
      readJson(getElectronPartitionPreferencesPath(appUserDataDir, "persist:rion-role-role-1"))
    ).resolves.toMatchObject({
      webkit: { webprefs: { fonts: { fixed: { Zyyy: "Courier New" } } } }
    });
  });

  it("removes managed prefs when browser defaults are selected", async () => {
    const preferencesPath = join(baseDir, "Default", "Preferences");
    await mkdir(dirname(preferencesPath), { recursive: true });
    await writeFile(
      preferencesPath,
      JSON.stringify({
        webkit: {
          webprefs: {
            default_font_size: 18,
            fonts: {
              standard: { Zyyy: "Arial" }
            }
          }
        }
      }),
      "utf8"
    );

    const applier = new BrowserFontApplier({
      appUserDataDir: baseDir,
      getSettings: vi.fn().mockResolvedValue({ fonts: { families: {}, mode: "default" } })
    });

    await applier.applyToPreferencesFile(preferencesPath, { fonts: { families: {}, mode: "default" } });

    await expect(readJson(preferencesPath)).resolves.toEqual({
      webkit: {
        webprefs: {
          default_font_size: 18
        }
      }
    });
  });
});

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
