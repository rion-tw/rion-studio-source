import type {
  BrowserFontFamilyRole,
  BrowserFontSettings,
  BrowserFontSettingsMode,
  BrowserNetworkSettings,
  BrowserProxySettings,
  BrowserProxySettingsMode,
  GameBrowserSettings
} from "./types";

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

export const DEFAULT_BROWSER_NETWORK_SETTINGS: BrowserNetworkSettings = {
  proxy: DEFAULT_BROWSER_PROXY_SETTINGS
};

export const DEFAULT_GAME_BROWSER_SETTINGS: GameBrowserSettings = {
  fonts: DEFAULT_BROWSER_FONT_SETTINGS,
  network: DEFAULT_BROWSER_NETWORK_SETTINGS
};

export function normalizeGameBrowserSettings(
  value: unknown,
  fallback: GameBrowserSettings = DEFAULT_GAME_BROWSER_SETTINGS
): GameBrowserSettings {
  const input = isRecord(value) ? value : {};

  return {
    fonts: normalizeBrowserFontSettings(input.fonts, fallback.fonts),
    network: normalizeBrowserNetworkSettings(input.network, fallback.network)
  };
}

export function normalizeBrowserNetworkSettings(
  value: unknown,
  fallback: BrowserNetworkSettings = DEFAULT_BROWSER_NETWORK_SETTINGS
): BrowserNetworkSettings {
  const input = isRecord(value) ? value : {};

  return {
    proxy: normalizeBrowserProxySettings(input.proxy, fallback.proxy)
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

function normalizeBrowserProxySettingsMode(
  value: unknown,
  fallback: BrowserProxySettingsMode
): BrowserProxySettingsMode {
  return value === "system" || value === "custom" ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
