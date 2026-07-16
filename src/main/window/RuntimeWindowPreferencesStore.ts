import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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

  constructor(userDataDir: string) {
    this.preferencesPath = join(userDataDir, "runtime-window-preferences.json");
  }

  async getPreferences(): Promise<RuntimeWindowPreferences> {
    if (this.cachedPreferences) {
      return { ...this.cachedPreferences };
    }

    try {
      const raw = await readFile(this.preferencesPath, "utf8");
      this.cachedPreferences = normalizeRuntimeWindowPreferences(JSON.parse(raw));
    } catch {
      this.cachedPreferences = { ...DEFAULT_RUNTIME_WINDOW_PREFERENCES };
    }

    return { ...this.cachedPreferences };
  }

  async updatePreferences(value: unknown): Promise<RuntimeWindowPreferences> {
    const preferences = normalizeRuntimeWindowPreferences(value);
    await mkdir(dirname(this.preferencesPath), { recursive: true });
    const temporaryPath = `${this.preferencesPath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(preferences, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.preferencesPath);
    this.cachedPreferences = { ...preferences };
    return { ...preferences };
  }
}
