import type { GameBrowserSettings } from "../../shared/types";
import type { AppCoreClient } from "../core/nativeCore";

export class GameBrowserSettingsStore {
  constructor(_userDataDir: string, private readonly core: Pick<AppCoreClient, "invoke">) {}

  async getSettings(): Promise<GameBrowserSettings> {
    const settings = await this.core.invoke({ type: "gameBrowserSettingsGet" });
    return structuredClone(settings);
  }

  async updateSettings(
    settings: GameBrowserSettings,
    _publishCache = true
  ): Promise<GameBrowserSettings> {
    const normalized = await this.core.invoke({ type: "gameBrowserSettingsReplace", settings });
    return structuredClone(normalized);
  }

  publishSettingsForImport(_settings: GameBrowserSettings): void {
    // SQLite is authoritative; portable apply publishes one Rust transaction.
  }
}
