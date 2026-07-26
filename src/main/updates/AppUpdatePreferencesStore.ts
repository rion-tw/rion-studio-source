import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

interface AppUpdatePreferences {
  autoUpdateEnabled: boolean;
}

const DEFAULT_PREFERENCES: AppUpdatePreferences = {
  autoUpdateEnabled: true
};

export class AppUpdatePreferencesStore {
  private readonly path: string;

  constructor(userDataDir: string) {
    this.path = join(userDataDir, "app-update-preferences.json");
  }

  async getAutoUpdateEnabled(): Promise<boolean> {
    const saved = await this.loadPreferences();
    return saved.autoUpdateEnabled;
  }

  async setAutoUpdateEnabled(enabled: boolean): Promise<void> {
    await writeJsonAtomically(this.path, {
      autoUpdateEnabled: enabled === true
    });
  }

  private async loadPreferences(): Promise<AppUpdatePreferences> {
    try {
      const content = await readFile(this.path, "utf8");
      return normalizePreferences(JSON.parse(content));
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return DEFAULT_PREFERENCES;
      }

      return DEFAULT_PREFERENCES;
    }
  }
}

function normalizePreferences(value: unknown): AppUpdatePreferences {
  const record = typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
  const autoUpdateEnabled = record?.autoUpdateEnabled;

  return {
    autoUpdateEnabled: typeof autoUpdateEnabled === "boolean" ? autoUpdateEnabled : DEFAULT_PREFERENCES.autoUpdateEnabled
  };
}

async function writeJsonAtomically(filePath: string, value: AppUpdatePreferences): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${Date.now()}-${process.pid}`;

  try {
    await writeFile(tempPath, JSON.stringify(value), "utf8");
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

function isFileNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}
