import type { GameBrowserSettings } from "../../shared/types";
import type { StateRepository } from "../core/RustStateRepository";

export class GameBrowserSettingsStore {
  constructor(_userDataDir: string, private readonly stateRepository: StateRepository) {}

  async getSettings(): Promise<GameBrowserSettings> {
    const settings = await this.stateRepository.getGameBrowserSettings();
    return structuredClone(settings);
  }

  async updateSettings(
    settings: GameBrowserSettings,
    _publishCache = true
  ): Promise<GameBrowserSettings> {
    const normalized = await this.stateRepository.replaceGameBrowserSettings(settings);
    return structuredClone(normalized);
  }

  publishSettingsForImport(_settings: GameBrowserSettings): void {
    // SQLite is authoritative; portable apply publishes one Rust transaction.
  }
}
