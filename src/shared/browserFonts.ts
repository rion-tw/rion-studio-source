import type {
  BrowserFontFamilyRole,
  BrowserFontSettings,
  BrowserFontSettingsMode,
  BrowserGraphicsSettings,
  BrowserCdnCompatibilityMode,
  BrowserCdnCompatibilitySettings,
  BrowserLaunchMode,
  BrowserNetworkSettings,
  BrowserProxySettings,
  BrowserProxySettingsMode,
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

export const DEFAULT_BROWSER_PROXY_SETTINGS: BrowserProxySettings = {
  mode: "system",
  server: ""
};

export const DEFAULT_BROWSER_CDN_COMPATIBILITY_SETTINGS: BrowserCdnCompatibilitySettings = {
  mode: "auto"
};

export const DEFAULT_BROWSER_NETWORK_SETTINGS: BrowserNetworkSettings = {
  cdnCompatibility: DEFAULT_BROWSER_CDN_COMPATIBILITY_SETTINGS,
  proxy: DEFAULT_BROWSER_PROXY_SETTINGS
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
  launchMode: "auto",
  macroBadgePosition: DEFAULT_MACRO_BADGE_POSITION,
  network: DEFAULT_BROWSER_NETWORK_SETTINGS,
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
    launchMode: normalizeBrowserLaunchMode(input.launchMode, fallback.launchMode),
    macroBadgePosition: normalizeMacroBadgePositionSettings(
      input.macroBadgePosition,
      fallback.macroBadgePosition
    ),
    network: normalizeBrowserNetworkSettings(input.network, fallback.network),
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

export function normalizeBrowserNetworkSettings(
  value: unknown,
  fallback: BrowserNetworkSettings = DEFAULT_BROWSER_NETWORK_SETTINGS
): BrowserNetworkSettings {
  const input = isRecord(value) ? value : {};

  return {
    cdnCompatibility: normalizeBrowserCdnCompatibilitySettings(
      input.cdnCompatibility,
      fallback.cdnCompatibility
    ),
    proxy: normalizeBrowserProxySettings(input.proxy, fallback.proxy)
  };
}

export function normalizeBrowserCdnCompatibilitySettings(
  value: unknown,
  fallback: BrowserCdnCompatibilitySettings = DEFAULT_BROWSER_CDN_COMPATIBILITY_SETTINGS
): BrowserCdnCompatibilitySettings {
  const input = isRecord(value) ? value : {};
  return {
    mode: normalizeBrowserCdnCompatibilityMode(input.mode, fallback.mode)
  };
}

export function normalizeBrowserProxySettings(
  value: unknown,
  fallback: BrowserProxySettings = DEFAULT_BROWSER_PROXY_SETTINGS
): BrowserProxySettings {
  const input = isRecord(value) ? value : {};
  const mode = normalizeBrowserProxySettingsMode(input.mode, fallback.mode);
  const server = normalizeBrowserProxyServer(input.server, fallback.server);

  if (mode !== "custom") {
    return DEFAULT_BROWSER_PROXY_SETTINGS;
  }

  return server ? { mode, server } : fallback.mode === "custom" ? fallback : DEFAULT_BROWSER_PROXY_SETTINGS;
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

export function normalizeBrowserProxyServer(value: unknown, fallback = ""): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200 || hasControlCharacter(trimmed)) {
    return fallback;
  }

  try {
    const url = new URL(trimmed);
    const protocol = url.protocol.toLowerCase();
    if (!["http:", "https:", "socks4:", "socks5:"].includes(protocol) || !url.hostname) {
      return fallback;
    }

    if (url.username || url.password || (url.pathname && url.pathname !== "/") || url.search || url.hash) {
      return fallback;
    }

    return `${protocol}//${url.host}`;
  } catch {
    return fallback;
  }
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

function normalizeBrowserLaunchMode(value: unknown, fallback: BrowserLaunchMode): BrowserLaunchMode {
  return value === "auto" || value === "embedded" || value === "external" ? value : fallback;
}

function normalizeBrowserProxySettingsMode(
  value: unknown,
  fallback: BrowserProxySettingsMode
): BrowserProxySettingsMode {
  return value === "system" || value === "custom" ? value : fallback;
}

function normalizeBrowserCdnCompatibilityMode(
  value: unknown,
  fallback: BrowserCdnCompatibilityMode
): BrowserCdnCompatibilityMode {
  return value === "off" || value === "auto" || value === "on" ? value : fallback;
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
