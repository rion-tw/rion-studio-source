import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { getChromeDefaultProfilePreferencesPath } from "../game-browser/BrowserFontApplier";

type JsonRecord = Record<string, unknown>;

interface PreferencesReadResult {
  isValid: boolean;
  preferences?: JsonRecord;
}

export interface ChromeZoomPreferenceApplierOptions {
  makeDirectory?: (path: string, options: { recursive: true }) => Promise<unknown>;
  readTextFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
  renameFile?: (oldPath: string, newPath: string) => Promise<void>;
  writeTextFile?: (path: string, data: string, encoding: BufferEncoding) => Promise<void>;
}

// Chromium encodes the Default profile's empty relative partition path as "x".
const DEFAULT_PARTITION_KEY = "x";
const DEFAULT_ZOOM_LEVEL_PATH = "default_zoom_level";
const PER_HOST_ZOOM_LEVELS_PATH = "per_host_zoom_levels";

export class ChromeZoomPreferenceApplier {
  private readonly makeDirectory: (path: string, options: { recursive: true }) => Promise<unknown>;
  private readonly readTextFile: (path: string, encoding: BufferEncoding) => Promise<string>;
  private readonly renameFile: (oldPath: string, newPath: string) => Promise<void>;
  private readonly writeTextFile: (path: string, data: string, encoding: BufferEncoding) => Promise<void>;

  constructor(options: ChromeZoomPreferenceApplierOptions = {}) {
    this.makeDirectory = options.makeDirectory ?? mkdir;
    this.readTextFile = options.readTextFile ?? readFile;
    this.renameFile = options.renameFile ?? rename;
    this.writeTextFile = options.writeTextFile ?? writeFile;
  }

  async applyToChromeUserDataDir(browserUserDataDir: string, zoomFactor: number): Promise<void> {
    await this.applyToPreferencesFile(
      getChromeDefaultProfilePreferencesPath(browserUserDataDir),
      zoomFactor
    );
  }

  async applyToPreferencesFile(preferencesPath: string, zoomFactor: number): Promise<void> {
    validateZoomFactor(zoomFactor);
    const { isValid, preferences: currentPreferences } = await this.readPreferencesFile(preferencesPath);

    if (!currentPreferences && zoomFactor === 1) {
      return;
    }

    const nextPreferences = applyChromeZoomFactorToPreferences(currentPreferences ?? {}, zoomFactor);
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

export function applyChromeZoomFactorToPreferences(
  preferences: JsonRecord,
  zoomFactor: number
): JsonRecord {
  validateZoomFactor(zoomFactor);
  const nextPreferences = structuredClone(preferences);
  const partition = ensureRecord(nextPreferences, "partition");
  const defaultZoomLevels = ensureRecord(partition, DEFAULT_ZOOM_LEVEL_PATH);
  const perHostZoomLevels = ensureRecord(partition, PER_HOST_ZOOM_LEVELS_PATH);

  if (zoomFactor === 1) {
    delete defaultZoomLevels[DEFAULT_PARTITION_KEY];
  } else {
    defaultZoomLevels[DEFAULT_PARTITION_KEY] = chromeZoomFactorToLevel(zoomFactor);
  }
  delete perHostZoomLevels[DEFAULT_PARTITION_KEY];

  return pruneEmptyRecords(nextPreferences);
}

export function chromeZoomFactorToLevel(zoomFactor: number): number {
  validateZoomFactor(zoomFactor);
  return Math.log(zoomFactor) / Math.log(1.2);
}

function validateZoomFactor(zoomFactor: number): void {
  if (!Number.isFinite(zoomFactor) || zoomFactor <= 0) {
    throw new Error("Chrome zoom factor must be greater than zero.");
  }
}

function ensureRecord(target: JsonRecord, key: string): JsonRecord {
  if (!isRecord(target[key])) {
    target[key] = {};
  }
  return target[key] as JsonRecord;
}

function pruneEmptyRecords(record: JsonRecord): JsonRecord {
  for (const [key, value] of Object.entries(record)) {
    if (!isRecord(value)) {
      continue;
    }

    pruneEmptyRecords(value);
    if (Object.keys(value).length === 0) {
      delete record[key];
    }
  }
  return record;
}

function areRecordsEqual(left: JsonRecord, right: JsonRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
