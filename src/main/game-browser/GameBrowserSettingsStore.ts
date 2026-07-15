import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  DEFAULT_GAME_BROWSER_SETTINGS,
  normalizeGameBrowserSettings
} from "../../shared/browserFonts";
import type { GameBrowserSettings } from "../../shared/types";

export class GameBrowserSettingsStore {
  private cachedSettings: GameBrowserSettings | undefined;
  private readonly settingsPath: string;

  constructor(userDataDir: string) {
    this.settingsPath = join(userDataDir, "game-browser-settings.json");
  }

  async getSettings(): Promise<GameBrowserSettings> {
    if (this.cachedSettings) {
      return cloneSettings(this.cachedSettings);
    }

    try {
      const raw = await readFile(this.settingsPath, "utf8");
      this.cachedSettings = normalizeGameBrowserSettings(JSON.parse(raw));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        this.cachedSettings = cloneSettings(DEFAULT_GAME_BROWSER_SETTINGS);
      } else {
        this.cachedSettings = cloneSettings(DEFAULT_GAME_BROWSER_SETTINGS);
      }
    }

    return cloneSettings(this.cachedSettings);
  }

  async updateSettings(settings: GameBrowserSettings, publishCache = true): Promise<GameBrowserSettings> {
    const normalizedSettings = normalizeGameBrowserSettings(settings);
    await this.writeSettings(normalizedSettings);
    if (publishCache) {
      this.cachedSettings = cloneSettings(normalizedSettings);
    }
    return cloneSettings(normalizedSettings);
  }

  publishSettingsForImport(settings: GameBrowserSettings): void {
    this.cachedSettings = cloneSettings(normalizeGameBrowserSettings(settings));
  }

  private async writeSettings(settings: GameBrowserSettings): Promise<void> {
    await mkdir(dirname(this.settingsPath), { recursive: true });
    const tmpPath = `${this.settingsPath}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    await rename(tmpPath, this.settingsPath);
  }
}

function cloneSettings(settings: GameBrowserSettings): GameBrowserSettings {
  return structuredClone(settings);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
