import {
  DEFAULT_LAUNCH_PRESET,
  DEFAULT_LAUNCH_URL,
  DEFAULT_ROLE_WINDOW_HEIGHT,
  DEFAULT_ROLE_WINDOW_WIDTH,
  type LaunchPreset,
  type RoleDefaults
} from "../../../shared/types";
import type { RoleFormState } from "./types";

interface RoleDefaultsStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export const ROLE_DEFAULTS_STORAGE_KEY = "rion-studio-role-defaults";
export const BACKGROUND_ACTIVITY_MIGRATION_STORAGE_KEY =
  "rion-studio-background-activity-migration-v1";
export const ROLE_WINDOW_CUSTOM_OPTION = "custom";

export const DEFAULT_ROLE_DEFAULTS: RoleDefaults = {
  windowWidth: DEFAULT_ROLE_WINDOW_WIDTH,
  windowHeight: DEFAULT_ROLE_WINDOW_HEIGHT,
  launchPreset: DEFAULT_LAUNCH_PRESET
};

export const roleWindowSizeOptions = [
  { width: 1280, height: 720 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1600, height: 900 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 }
] as const;

export function createRoleWindowSizeValue(width: number, height: number): string {
  return `${width}x${height}`;
}

export function getRoleWindowSizeValue(defaults: Pick<RoleDefaults, "windowHeight" | "windowWidth">): string {
  const matchingOption = roleWindowSizeOptions.find(
    (option) => option.width === defaults.windowWidth && option.height === defaults.windowHeight
  );

  return matchingOption
    ? createRoleWindowSizeValue(matchingOption.width, matchingOption.height)
    : ROLE_WINDOW_CUSTOM_OPTION;
}

export function parseRoleWindowSizeValue(value: string): Pick<RoleDefaults, "windowHeight" | "windowWidth"> | null {
  const [rawWidth, rawHeight] = value.split("x");
  const windowWidth = Number(rawWidth);
  const windowHeight = Number(rawHeight);

  if (!isValidRoleWindowSize(windowWidth) || !isValidRoleWindowSize(windowHeight)) {
    return null;
  }

  return { windowWidth, windowHeight };
}

export function createEmptyRoleForm(
  roleDefaults: RoleDefaults = DEFAULT_ROLE_DEFAULTS,
  gameId = "",
  launchUrl = DEFAULT_LAUNCH_URL
): RoleFormState {
  const normalizedDefaults = normalizeRoleDefaults(roleDefaults);

  return {
    gameId,
    name: "",
    launchUrl,
    windowWidth: normalizedDefaults.windowWidth,
    windowHeight: normalizedDefaults.windowHeight,
    notes: "",
    launchPreset: normalizedDefaults.launchPreset
  };
}

export function readStoredRoleDefaults(storage = getLocalStorage()): RoleDefaults {
  if (!storage) {
    return DEFAULT_ROLE_DEFAULTS;
  }

  const storedValue = storage.getItem(ROLE_DEFAULTS_STORAGE_KEY);
  let roleDefaults: RoleDefaults;
  try {
    roleDefaults = storedValue
      ? normalizeRoleDefaults(JSON.parse(storedValue) as unknown)
      : DEFAULT_ROLE_DEFAULTS;
  } catch {
    roleDefaults = DEFAULT_ROLE_DEFAULTS;
  }

  if (storage.getItem(BACKGROUND_ACTIVITY_MIGRATION_STORAGE_KEY) === "1") {
    return roleDefaults;
  }

  const migrated = { ...roleDefaults, launchPreset: DEFAULT_LAUNCH_PRESET };
  storage.setItem(ROLE_DEFAULTS_STORAGE_KEY, JSON.stringify(migrated));
  storage.setItem(BACKGROUND_ACTIVITY_MIGRATION_STORAGE_KEY, "1");
  return migrated;
}

export function writeStoredRoleDefaults(
  roleDefaults: RoleDefaults,
  storage = getLocalStorage()
): RoleDefaults {
  const normalizedDefaults = normalizeRoleDefaults(roleDefaults);
  storage?.setItem(ROLE_DEFAULTS_STORAGE_KEY, JSON.stringify(normalizedDefaults));
  storage?.setItem(BACKGROUND_ACTIVITY_MIGRATION_STORAGE_KEY, "1");
  return normalizedDefaults;
}

export function normalizeRoleDefaults(
  value: unknown,
  fallback: RoleDefaults = DEFAULT_ROLE_DEFAULTS
): RoleDefaults {
  const input = isRecord(value) ? value : {};

  return {
    windowWidth: normalizeWindowSize(input.windowWidth, fallback.windowWidth),
    windowHeight: normalizeWindowSize(input.windowHeight, fallback.windowHeight),
    launchPreset: normalizeLaunchPreset(input.launchPreset, fallback.launchPreset)
  };
}

function normalizeWindowSize(value: unknown, fallback: number): number {
  return isValidRoleWindowSize(value) ? value : fallback;
}

export function isValidRoleWindowSize(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 640 && value <= 7680;
}

function normalizeLaunchPreset(value: unknown, fallback: LaunchPreset): LaunchPreset {
  return value === "balanced" || value === "performance" ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getLocalStorage(): RoleDefaultsStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
