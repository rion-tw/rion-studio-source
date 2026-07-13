import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  DEFAULT_GAME_BROWSER_SETTINGS,
  normalizeGameBrowserSettings
} from "../../shared/browserFonts";
import type { GameBrowserSettings } from "../../shared/types";

export class GameBrowserSettingsStore {
  private readonly settingsPath: string;

  constructor(userDataDir: string) {
    this.settingsPath = join(userDataDir, "game-browser-settings.json");
  }

  async getSettings(): Promise<GameBrowserSettings> {
    try {
      const raw = await readFile(this.settingsPath, "utf8");
      return normalizeGameBrowserSettings(JSON.parse(raw));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return DEFAULT_GAME_BROWSER_SETTINGS;
      }

      return DEFAULT_GAME_BROWSER_SETTINGS;
    }
  }

  async updateSettings(settings: GameBrowserSettings): Promise<GameBrowserSettings> {
    const normalizedSettings = normalizeGameBrowserSettings(settings);
    await this.writeSettings(normalizedSettings);
    return normalizedSettings;
  }

  private async writeSettings(settings: GameBrowserSettings): Promise<void> {
    await mkdir(dirname(this.settingsPath), { recursive: true });
    const tmpPath = `${this.settingsPath}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    await rename(tmpPath, this.settingsPath);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
