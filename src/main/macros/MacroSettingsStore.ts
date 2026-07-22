import type { MacroSettings } from "../../shared/types";
import type { StateRepository } from "../core/RustStateRepository";

export class MacroSettingsStore {
  constructor(_userDataDir: string, private readonly stateRepository: StateRepository) {}

  async getSettings(): Promise<MacroSettings> {
    return { ...await this.stateRepository.getMacroSettings() };
  }

  async updateSettings(
    settings: MacroSettings,
    _publishCache = true
  ): Promise<MacroSettings> {
    const normalized = await this.stateRepository.replaceMacroSettings(settings);
    return { ...normalized };
  }

  publishSettingsForImport(_settings: MacroSettings): void {
    // SQLite is authoritative; portable apply publishes one Rust transaction.
  }
}
