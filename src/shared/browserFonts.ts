import type {
  BrowserFontFamilyRole,
  BrowserFontSettings,
  BrowserFontSettingsMode,
  BrowserGraphicsSettings,
  GameBrowserSettings,
  WorkspaceAppearanceSettings,
  WorkspaceBackgroundStyle,
  WorkspaceGapSize
} from "./types";
import {
  DEFAULT_MACRO_BADGE_POSITION,
  normalizeMacroBadgePositionSettings
} from "./macroOverlay";

export const browserFontFamilyRoles = ["standard", "serif", "sansserif", "fixed", "math"] as const;

export const browserFontFamilyPrefKeys: Record<BrowserFontFamilyRole, string> = {
  fixed: "webkit.webprefs.fonts.fixed.Zyyy",
  math: "webkit.webprefs.fonts.math.Zyyy",
  sansserif: "webkit.webprefs.fonts.sansserif.Zyyy",
  serif: "webkit.webprefs.fonts.serif.Zyyy",
  standard: "webkit.webprefs.fonts.standard.Zyyy"
};

export const DEFAULT_BROWSER_FONT_SETTINGS: BrowserFontSettings = {
  families: {},
  mode: "default"
};

export const DEFAULT_BROWSER_GRAPHICS_SETTINGS: BrowserGraphicsSettings = {
  backend: {
    macos: "automatic",
    windows: "automatic"
  },
  driverBugWorkaroundsEnabled: true,
  forceGpuRasterization: false,
  frameRateLimitEnabled: true,
  gpuBlocklistEnabled: true,
  preferHighPerformanceGpu: true,
  unsafeWebGpuEnabled: false,
  vsyncEnabled: true,
  windowsEcoQosEnabled: true
};

export const LEGACY_AUTOMATIC_BROWSER_GRAPHICS_SETTINGS: BrowserGraphicsSettings = {
  backend: {
    macos: "automatic",
    windows: "automatic"
  },
  driverBugWorkaroundsEnabled: true,
  forceGpuRasterization: false,
  frameRateLimitEnabled: true,
  gpuBlocklistEnabled: true,
  preferHighPerformanceGpu: false,
  unsafeWebGpuEnabled: false,
  vsyncEnabled: true,
  windowsEcoQosEnabled: true
};

export const workspaceGapSizes = [1, 2, 4, 6, 8, 12, 16] as const satisfies readonly WorkspaceGapSize[];

export const DEFAULT_WORKSPACE_APPEARANCE_SETTINGS: WorkspaceAppearanceSettings = {
  background: "material",
  gap: 4
};

export const DEFAULT_GAME_BROWSER_SETTINGS: GameBrowserSettings = {
  fonts: DEFAULT_BROWSER_FONT_SETTINGS,
  graphics: DEFAULT_BROWSER_GRAPHICS_SETTINGS,
  macroBadgePosition: DEFAULT_MACRO_BADGE_POSITION,
  workspace: DEFAULT_WORKSPACE_APPEARANCE_SETTINGS
};

export function normalizeGameBrowserSettings(
  value: unknown,
  fallback: GameBrowserSettings = DEFAULT_GAME_BROWSER_SETTINGS
): GameBrowserSettings {
  const input = isRecord(value) ? value : {};

  return {
    fonts: normalizeBrowserFontSettings(input.fonts, fallback.fonts),
    graphics: normalizeBrowserGraphicsSettings(input.graphics, fallback.graphics),
    macroBadgePosition: normalizeMacroBadgePositionSettings(
      input.macroBadgePosition,
      fallback.macroBadgePosition
    ),
    workspace: normalizeWorkspaceAppearanceSettings(input.workspace, fallback.workspace)
  };
}

export function normalizeWorkspaceAppearanceSettings(
  value: unknown,
  fallback: WorkspaceAppearanceSettings = DEFAULT_WORKSPACE_APPEARANCE_SETTINGS
): WorkspaceAppearanceSettings {
  const input = isRecord(value) ? value : {};
  return {
    background: normalizeWorkspaceBackgroundStyle(input.background, fallback.background),
    gap: normalizeWorkspaceGapSize(input.gap, fallback.gap)
  };
}

export function normalizeBrowserGraphicsSettings(
  value: unknown,
  fallback: BrowserGraphicsSettings = DEFAULT_BROWSER_GRAPHICS_SETTINGS
): BrowserGraphicsSettings {
  const input = isRecord(value) ? value : {};
  const hasFlattenedSettings = [
    "backend",
    "driverBugWorkaroundsEnabled",
    "forceGpuRasterization",
    "frameRateLimitEnabled",
    "gpuBlocklistEnabled",
    "preferHighPerformanceGpu",
    "unsafeWebGpuEnabled",
    "vsyncEnabled",
    "windowsEcoQosEnabled"
  ].some((key) => key in input);

  if (!hasFlattenedSettings && "mode" in input) {
    return normalizeLegacyBrowserGraphicsMode(input.mode);
  }

  const frameRateLimitEnabled = normalizeBoolean(
    input.frameRateLimitEnabled,
    fallback.frameRateLimitEnabled
  );
  return {
    backend: normalizeBrowserGraphicsBackendSettings(input.backend, fallback.backend),
    driverBugWorkaroundsEnabled: normalizeBoolean(
      input.driverBugWorkaroundsEnabled,
      fallback.driverBugWorkaroundsEnabled
    ),
    forceGpuRasterization: normalizeBoolean(
      input.forceGpuRasterization,
      fallback.forceGpuRasterization
    ),
    frameRateLimitEnabled,
    gpuBlocklistEnabled: normalizeBoolean(input.gpuBlocklistEnabled, fallback.gpuBlocklistEnabled),
    preferHighPerformanceGpu: normalizeBoolean(
      input.preferHighPerformanceGpu,
      fallback.preferHighPerformanceGpu
    ),
    unsafeWebGpuEnabled: normalizeBoolean(input.unsafeWebGpuEnabled, fallback.unsafeWebGpuEnabled),
    vsyncEnabled: frameRateLimitEnabled
      ? normalizeBoolean(input.vsyncEnabled, fallback.vsyncEnabled)
      : false,
    windowsEcoQosEnabled: normalizeBoolean(
      input.windowsEcoQosEnabled,
      fallback.windowsEcoQosEnabled
    )
  };
}

function normalizeLegacyBrowserGraphicsMode(value: unknown): BrowserGraphicsSettings {
  const normalized = structuredClone(LEGACY_AUTOMATIC_BROWSER_GRAPHICS_SETTINGS);
  if (value === "high_performance" || value === "experimental") {
    normalized.preferHighPerformanceGpu = true;
  }
  if (value === "experimental") {
    normalized.gpuBlocklistEnabled = false;
    normalized.unsafeWebGpuEnabled = true;
  }
  return normalized;
}

function normalizeBrowserGraphicsBackendSettings(
  value: unknown,
  fallback: BrowserGraphicsSettings["backend"]
): BrowserGraphicsSettings["backend"] {
  const input = isRecord(value) ? value : {};
  return {
    macos: input.macos === "automatic" || input.macos === "metal" ? input.macos : fallback.macos,
    windows:
      input.windows === "automatic" ||
      input.windows === "d3d11" ||
      input.windows === "d3d11on12" ||
      input.windows === "vulkan"
        ? input.windows
        : fallback.windows
  };
}

export function normalizeBrowserFontSettings(
  value: unknown,
  fallback: BrowserFontSettings = DEFAULT_BROWSER_FONT_SETTINGS
): BrowserFontSettings {
  const input = isRecord(value) ? value : {};
  const mode = normalizeBrowserFontSettingsMode(input.mode, fallback.mode);
  const families = normalizeBrowserFontFamilies(input.families, fallback.families);

  return {
    families: mode === "custom" ? families : {},
    mode
  };
}

export function normalizeBrowserFontFamilies(
  value: unknown,
  fallback: Partial<Record<BrowserFontFamilyRole, string>> = {}
): Partial<Record<BrowserFontFamilyRole, string>> {
  const input = isRecord(value) ? value : {};
  const normalized: Partial<Record<BrowserFontFamilyRole, string>> = {};

  for (const role of browserFontFamilyRoles) {
    const fontFamily = normalizeBrowserFontFamily(input[role], fallback[role]);
    if (fontFamily) {
      normalized[role] = fontFamily;
    }
  }

  return normalized;
}

export function isBrowserFontFamilyRole(value: unknown): value is BrowserFontFamilyRole {
  return browserFontFamilyRoles.includes(value as BrowserFontFamilyRole);
}

export function normalizeBrowserFontFamily(value: unknown, fallback?: string): string | undefined {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > 120 || hasControlCharacter(normalized)) {
    return fallback;
  }

  return normalized;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function normalizeBrowserFontSettingsMode(
  value: unknown,
  fallback: BrowserFontSettingsMode
): BrowserFontSettingsMode {
  return value === "default" || value === "custom" ? value : fallback;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeWorkspaceGapSize(
  value: unknown,
  fallback: WorkspaceGapSize
): WorkspaceGapSize {
  return workspaceGapSizes.includes(value as WorkspaceGapSize)
    ? (value as WorkspaceGapSize)
    : fallback;
}

function normalizeWorkspaceBackgroundStyle(
  value: unknown,
  fallback: WorkspaceBackgroundStyle
): WorkspaceBackgroundStyle {
  return value === "material" || value === "black" ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
