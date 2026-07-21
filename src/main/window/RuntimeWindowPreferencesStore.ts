import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { StateRepository } from "../core/RustStateRepository";

export interface RuntimeWindowPreferences {
  alwaysShowToolbarInFullScreen: boolean;
}

export const DEFAULT_RUNTIME_WINDOW_PREFERENCES: RuntimeWindowPreferences = {
  alwaysShowToolbarInFullScreen: false
};

export function normalizeRuntimeWindowPreferences(value: unknown): RuntimeWindowPreferences {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_RUNTIME_WINDOW_PREFERENCES };
  }

  const candidate = value as Record<string, unknown>;
  return {
    alwaysShowToolbarInFullScreen:
      typeof candidate.alwaysShowToolbarInFullScreen === "boolean"
        ? candidate.alwaysShowToolbarInFullScreen
        : DEFAULT_RUNTIME_WINDOW_PREFERENCES.alwaysShowToolbarInFullScreen
  };
}

export class RuntimeWindowPreferencesStore {
  private cachedPreferences: RuntimeWindowPreferences | undefined;
  private readonly preferencesPath: string;

  constructor(userDataDir: string, private readonly stateRepository?: StateRepository) {
    this.preferencesPath = join(userDataDir, "runtime-window-preferences.json");
  }

  async getPreferences(): Promise<RuntimeWindowPreferences> {
    if (this.cachedPreferences) {
      return { ...this.cachedPreferences };
    }

    try {
      const value = this.stateRepository
        ? await this.stateRepository.read(
            "runtimeWindowPreferences",
            DEFAULT_RUNTIME_WINDOW_PREFERENCES
          )
        : JSON.parse(await readFile(this.preferencesPath, "utf8"));
      this.cachedPreferences = normalizeRuntimeWindowPreferences(value);
    } catch {
      this.cachedPreferences = { ...DEFAULT_RUNTIME_WINDOW_PREFERENCES };
    }

    return { ...this.cachedPreferences };
  }

  async updatePreferences(value: unknown): Promise<RuntimeWindowPreferences> {
    const preferences = normalizeRuntimeWindowPreferences(value);
    if (this.stateRepository) {
      await this.stateRepository.replace("runtimeWindowPreferences", preferences);
    } else {
      await mkdir(dirname(this.preferencesPath), { recursive: true });
      const temporaryPath = `${this.preferencesPath}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(preferences, null, 2)}\n`, "utf8");
      await rename(temporaryPath, this.preferencesPath);
    }
    this.cachedPreferences = { ...preferences };
    return { ...preferences };
  }
}
