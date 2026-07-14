import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  browserFontFamilyPrefKeys,
  browserFontFamilyRoles,
  normalizeGameBrowserSettings
} from "../../shared/browserFonts";
import type { GameBrowserSettings } from "../../shared/types";

type JsonRecord = Record<string, unknown>;

interface PreferencesReadResult {
  isValid: boolean;
  preferences?: JsonRecord;
}

export interface BrowserFontApplierOptions {
  appUserDataDir: string;
  getSettings: () => Promise<GameBrowserSettings>;
  readTextFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
  writeTextFile?: (path: string, data: string, encoding: BufferEncoding) => Promise<void>;
  renameFile?: (oldPath: string, newPath: string) => Promise<void>;
  makeDirectory?: (path: string, options: { recursive: true }) => Promise<unknown>;
}

export class BrowserFontApplier {
  private readonly makeDirectory: (path: string, options: { recursive: true }) => Promise<unknown>;
  private readonly readTextFile: (path: string, encoding: BufferEncoding) => Promise<string>;
  private readonly renameFile: (oldPath: string, newPath: string) => Promise<void>;
  private readonly writeTextFile: (path: string, data: string, encoding: BufferEncoding) => Promise<void>;

  constructor(private readonly options: BrowserFontApplierOptions) {
    this.makeDirectory = options.makeDirectory ?? mkdir;
    this.readTextFile = options.readTextFile ?? readFile;
    this.renameFile = options.renameFile ?? rename;
    this.writeTextFile = options.writeTextFile ?? writeFile;
  }

  async applyToRoleLaunch(roleBrowserUserDataDir: string, roleSessionPartition: string): Promise<void> {
    const settings = await this.options.getSettings();
    await Promise.all([
      this.applyToPreferencesFile(getChromeDefaultProfilePreferencesPath(roleBrowserUserDataDir), settings),
      this.applyToPreferencesFile(getElectronPartitionPreferencesPath(this.options.appUserDataDir, roleSessionPartition), settings)
    ]);
  }

  async applyToChromeUserDataDir(roleBrowserUserDataDir: string): Promise<void> {
    await this.applyToPreferencesFile(
      getChromeDefaultProfilePreferencesPath(roleBrowserUserDataDir),
      await this.options.getSettings()
    );
  }

  async applyToPreferencesFile(preferencesPath: string, settings: GameBrowserSettings): Promise<void> {
    const normalizedSettings = normalizeGameBrowserSettings(settings);
    const { isValid, preferences: currentPreferences } = await this.readPreferencesFile(preferencesPath);

    if (!currentPreferences && normalizedSettings.fonts.mode === "default") {
      return;
    }

    const nextPreferences = applyBrowserFontSettingsToPreferences(currentPreferences ?? {}, normalizedSettings);
    if (isValid && currentPreferences && areRecordsEqual(currentPreferences, nextPreferences)) {
      return;
    }

    await this.writePreferencesFile(preferencesPath, nextPreferences);
  }

  private async readPreferencesFile(preferencesPath: string): Promise<PreferencesReadResult> {
    try {
      const raw = await this.readTextFile(preferencesPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      return isRecord(parsed)
        ? { isValid: true, preferences: parsed }
        : { isValid: false, preferences: {} };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { isValid: true };
      }

      return { isValid: false, preferences: {} };
    }
  }

  private async writePreferencesFile(preferencesPath: string, preferences: JsonRecord): Promise<void> {
    await this.makeDirectory(dirname(preferencesPath), { recursive: true });
    const tmpPath = `${preferencesPath}.tmp`;
    await this.writeTextFile(tmpPath, `${JSON.stringify(preferences, null, 2)}\n`, "utf8");
    await this.renameFile(tmpPath, preferencesPath);
  }
}

export function applyBrowserFontSettingsToPreferences(
  preferences: JsonRecord,
  settings: GameBrowserSettings
): JsonRecord {
  const normalizedSettings = normalizeGameBrowserSettings(settings);
  const nextPreferences = cloneRecord(preferences);

  for (const role of browserFontFamilyRoles) {
    deleteDottedPath(nextPreferences, browserFontFamilyPrefKeys[role]);
  }

  if (normalizedSettings.fonts.mode === "custom") {
    for (const role of browserFontFamilyRoles) {
      const fontFamily = normalizedSettings.fonts.families[role];
      if (fontFamily) {
        setDottedPath(nextPreferences, browserFontFamilyPrefKeys[role], fontFamily);
      }
    }
  }

  return pruneEmptyRecords(nextPreferences);
}

export function getChromeDefaultProfilePreferencesPath(roleBrowserUserDataDir: string): string {
  return join(roleBrowserUserDataDir, "Default", "Preferences");
}

export function getElectronPartitionPreferencesPath(appUserDataDir: string, partition: string): string {
  return join(appUserDataDir, "Partitions", normalizePersistPartitionName(partition), "Preferences");
}

function normalizePersistPartitionName(partition: string): string {
  return partition.startsWith("persist:") ? partition.slice("persist:".length) : partition;
}

function setDottedPath(target: JsonRecord, dottedPath: string, value: string): void {
  const parts = dottedPath.split(".");
  let current = target;

  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (!isRecord(next)) {
      current[part] = {};
    }

    current = current[part] as JsonRecord;
  }

  current[parts[parts.length - 1]] = value;
}

function deleteDottedPath(target: JsonRecord, dottedPath: string): void {
  const parts = dottedPath.split(".");
  const stack: Array<{ key: string; parent: JsonRecord }> = [];
  let current = target;

  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (!isRecord(next)) {
      return;
    }

    stack.push({ key: part, parent: current });
    current = next;
  }

  delete current[parts[parts.length - 1]];

  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const item = stack[index];
    const child = item.parent[item.key];
    if (isRecord(child) && Object.keys(child).length === 0) {
      delete item.parent[item.key];
    }
  }
}

function cloneRecord(value: JsonRecord): JsonRecord {
  return JSON.parse(JSON.stringify(value)) as JsonRecord;
}

function areRecordsEqual(left: JsonRecord, right: JsonRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function pruneEmptyRecords(value: JsonRecord): JsonRecord {
  if (!isRecord(value)) {
    return value;
  }

  for (const key of Object.keys(value)) {
    const child = value[key];
    if (isRecord(child)) {
      value[key] = pruneEmptyRecords(child);
      if (isRecord(value[key]) && Object.keys(value[key]).length === 0) {
        delete value[key];
      }
    }
  }

  return value;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
