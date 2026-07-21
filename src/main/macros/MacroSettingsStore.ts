import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  DEFAULT_MACRO_SETTINGS,
  normalizeMacroSettings
} from "../../shared/macroSettings";
import type { MacroSettings } from "../../shared/types";
import { writeJsonFileAtomically } from "../persistence/atomicJsonFile";
import type { StateRepository } from "../core/RustStateRepository";

export class MacroSettingsStore {
  private cachedSettings: MacroSettings | undefined;
  private readonly settingsPath: string;

  constructor(userDataDir: string, private readonly stateRepository?: StateRepository) {
    this.settingsPath = join(userDataDir, "macro-settings.json");
  }

  async getSettings(): Promise<MacroSettings> {
    if (this.cachedSettings) {
      return cloneSettings(this.cachedSettings);
    }

    try {
      const value = this.stateRepository
        ? await this.stateRepository.read("macroSettings", DEFAULT_MACRO_SETTINGS)
        : JSON.parse(await readFile(this.settingsPath, "utf8"));
      this.cachedSettings = normalizeMacroSettings(value);
    } catch {
      this.cachedSettings = cloneSettings(DEFAULT_MACRO_SETTINGS);
    }

    return cloneSettings(this.cachedSettings);
  }

  async updateSettings(settings: MacroSettings, publishCache = true): Promise<MacroSettings> {
    const normalized = normalizeMacroSettings(settings);
    if (this.stateRepository) {
      await this.stateRepository.replace("macroSettings", normalized);
    } else {
      await writeJsonFileAtomically(this.settingsPath, normalized);
    }
    if (publishCache) {
      this.cachedSettings = cloneSettings(normalized);
    }
    return cloneSettings(normalized);
  }

  publishSettingsForImport(settings: MacroSettings): void {
    this.cachedSettings = normalizeMacroSettings(settings);
  }
}

function cloneSettings(settings: MacroSettings): MacroSettings {
  return { ...settings };
}
