import type {
  BrowserFontCjkVariant,
  BrowserFontSelection,
  BrowserFontSettings,
  BrowserFontSettingsMode,
  BrowserFontSlot,
  BrowserPerformanceSettings,
  GameBrowserSettings,
  WorkspaceAppearanceSettings,
  WorkspaceBackgroundStyle,
  WorkspaceGapSize
} from "./types";
import {
  DEFAULT_MACRO_BADGE_POSITION,
  normalizeMacroBadgePositionSettings
} from "./macroOverlay";

export const browserFontSlots = ["cjk", "latin", "numeric", "monospace", "math"] as const;
export const browserFontCjkVariants = ["auto", "tc", "sc", "jp"] as const;

export type BrowserFontPresetId =
  | "system-default"
  | "modern-sans"
  | "comfortable-reading"
  | "clear-interface"
  | "clear-numbers"
  | "code-monospace"
  | "high-legibility"
  | "compact-dashboard"
  | "natural-handwriting"
  | "playful-handwriting"
  | "calligraphic-handwriting"
  | "neat-notebook"
  | "storybook-handwriting"
  | "friendly-rounded"
  | "marker-notes"
  | "editorial-serif"
  | "retro-game"
  | "fantasy-chronicle"
  | "future-interface"
  | "relaxed-dialogue";

export interface BrowserFontPresetDefinition {
  id: BrowserFontPresetId;
  category: "general" | "handwriting" | "personality";
  slots: Partial<Record<BrowserFontSlot, BrowserFontSelection>>;
  cjkCatalog: Record<Exclude<BrowserFontCjkVariant, "auto">, string>;
}

const system = (family: string): BrowserFontSelection => ({ source: "system", family });
const google = (catalogId: string): BrowserFontSelection => ({ source: "google", catalogId });

export const browserFontPresets: readonly BrowserFontPresetDefinition[] = [
  {
    id: "system-default",
    category: "general",
    cjkCatalog: { tc: "", sc: "", jp: "" },
    slots: {
      cjk: system("system-ui"),
      latin: system("system-ui"),
      numeric: system("system-ui"),
      monospace: system("ui-monospace"),
      math: system("math")
    }
  },
  {
    id: "modern-sans",
    category: "general",
    cjkCatalog: { tc: "noto-sans-tc", sc: "noto-sans-sc", jp: "noto-sans-jp" },
    slots: { latin: google("inter"), numeric: google("inter"), monospace: google("jetbrains-mono"), math: google("noto-sans-math") }
  },
  {
    id: "comfortable-reading",
    category: "general",
    cjkCatalog: { tc: "noto-serif-tc", sc: "noto-serif-sc", jp: "noto-serif-jp" },
    slots: { latin: google("source-serif-4"), numeric: google("source-serif-4"), monospace: google("roboto-mono"), math: google("noto-sans-math") }
  },
  {
    id: "clear-interface",
    category: "general",
    cjkCatalog: { tc: "noto-sans-tc", sc: "noto-sans-sc", jp: "noto-sans-jp" },
    slots: { latin: google("roboto"), numeric: google("roboto"), monospace: google("roboto-mono"), math: google("noto-sans-math") }
  },
  {
    id: "clear-numbers",
    category: "general",
    cjkCatalog: { tc: "noto-sans-tc", sc: "noto-sans-sc", jp: "noto-sans-jp" },
    slots: { latin: google("inter"), numeric: google("roboto-mono"), monospace: google("roboto-mono"), math: google("noto-sans-math") }
  },
  {
    id: "code-monospace",
    category: "general",
    cjkCatalog: { tc: "noto-sans-tc", sc: "noto-sans-sc", jp: "noto-sans-jp" },
    slots: { latin: google("jetbrains-mono"), numeric: google("jetbrains-mono"), monospace: google("jetbrains-mono"), math: google("noto-sans-math") }
  },
  {
    id: "high-legibility",
    category: "general",
    cjkCatalog: { tc: "noto-sans-tc", sc: "noto-sans-sc", jp: "noto-sans-jp" },
    slots: { latin: google("atkinson-hyperlegible-next"), numeric: google("atkinson-hyperlegible-mono"), monospace: google("atkinson-hyperlegible-mono"), math: google("noto-sans-math") }
  },
  {
    id: "compact-dashboard",
    category: "general",
    cjkCatalog: { tc: "noto-sans-tc", sc: "noto-sans-sc", jp: "noto-sans-jp" },
    slots: { latin: google("roboto-condensed"), numeric: google("roboto-condensed"), monospace: google("roboto-mono"), math: google("noto-sans-math") }
  },
  {
    id: "natural-handwriting",
    category: "handwriting",
    cjkCatalog: { tc: "iansui", sc: "ma-shan-zheng", jp: "klee-one" },
    slots: { latin: google("patrick-hand"), numeric: google("patrick-hand"), monospace: google("jetbrains-mono"), math: google("noto-sans-math") }
  },
  {
    id: "playful-handwriting",
    category: "handwriting",
    cjkCatalog: { tc: "lxgw-wenkai-tc", sc: "long-cang", jp: "yomogi" },
    slots: { latin: google("caveat"), numeric: google("patrick-hand"), monospace: google("jetbrains-mono"), math: google("noto-sans-math") }
  },
  {
    id: "calligraphic-handwriting",
    category: "handwriting",
    cjkCatalog: { tc: "lxgw-wenkai-tc", sc: "zhi-mang-xing", jp: "klee-one" },
    slots: { latin: google("kalam"), numeric: google("patrick-hand"), monospace: google("jetbrains-mono"), math: google("noto-sans-math") }
  },
  {
    id: "neat-notebook",
    category: "handwriting",
    cjkCatalog: { tc: "lxgw-wenkai-tc", sc: "ma-shan-zheng", jp: "klee-one" },
    slots: { latin: google("handlee"), numeric: google("patrick-hand"), monospace: google("jetbrains-mono"), math: google("noto-sans-math") }
  },
  {
    id: "storybook-handwriting",
    category: "handwriting",
    cjkCatalog: { tc: "iansui", sc: "long-cang", jp: "yomogi" },
    slots: { latin: google("short-stack"), numeric: google("patrick-hand"), monospace: google("jetbrains-mono"), math: google("noto-sans-math") }
  },
  {
    id: "friendly-rounded",
    category: "personality",
    cjkCatalog: { tc: "chiron-go-round-tc", sc: "zcool-kuaile", jp: "zen-maru-gothic" },
    slots: { latin: google("fredoka"), numeric: google("fredoka"), monospace: google("jetbrains-mono"), math: google("noto-sans-math") }
  },
  {
    id: "marker-notes",
    category: "handwriting",
    cjkCatalog: { tc: "lxgw-marker-gothic", sc: "zcool-qingke-huangyou", jp: "yusei-magic" },
    slots: { latin: google("permanent-marker"), numeric: google("patrick-hand"), monospace: google("jetbrains-mono"), math: google("noto-sans-math") }
  },
  {
    id: "editorial-serif",
    category: "personality",
    cjkCatalog: { tc: "cactus-classical-serif", sc: "zcool-xiaowei", jp: "hina-mincho" },
    slots: { latin: google("playfair-display"), numeric: google("playfair-display"), monospace: google("roboto-mono"), math: google("noto-sans-math") }
  },
  {
    id: "retro-game",
    category: "personality",
    cjkCatalog: { tc: "wdxl-lubrifont-tc", sc: "wdxl-lubrifont-sc", jp: "wdxl-lubrifont-jp-n" },
    slots: { latin: google("pixelify-sans"), numeric: google("pixelify-sans"), monospace: google("jetbrains-mono"), math: google("noto-sans-math") }
  },
  {
    id: "fantasy-chronicle",
    category: "personality",
    cjkCatalog: { tc: "cactus-classical-serif", sc: "zcool-xiaowei", jp: "kaisei-tokumin" },
    slots: { latin: google("cinzel"), numeric: google("cinzel"), monospace: google("roboto-mono"), math: google("noto-sans-math") }
  },
  {
    id: "future-interface",
    category: "personality",
    cjkCatalog: { tc: "chocolate-classical-sans", sc: "zcool-qingke-huangyou", jp: "zen-kaku-gothic-new" },
    slots: { latin: google("exo-2"), numeric: google("orbitron"), monospace: google("jetbrains-mono"), math: google("noto-sans-math") }
  },
  {
    id: "relaxed-dialogue",
    category: "personality",
    cjkCatalog: { tc: "huninn", sc: "zcool-kuaile", jp: "kiwi-maru" },
    slots: { latin: google("nunito"), numeric: google("nunito"), monospace: google("roboto-mono"), math: google("noto-sans-math") }
  }
];

export const DEFAULT_BROWSER_FONT_SETTINGS: BrowserFontSettings = {
  cjkVariant: "auto",
  fontSmoothingEnabled: true,
  mode: "custom",
  presetId: "system-default",
  slots: {
    cjk: system("system-ui"),
    latin: system("system-ui"),
    numeric: system("system-ui"),
    monospace: system("ui-monospace"),
    math: system("math")
  }
};

export const DEFAULT_BROWSER_PERFORMANCE_SETTINGS: BrowserPerformanceSettings = {
  macosHighRefreshRate: false
};

export const workspaceGapSizes = [1, 2, 4, 6, 8, 12, 16] as const satisfies readonly WorkspaceGapSize[];

export const DEFAULT_WORKSPACE_APPEARANCE_SETTINGS: WorkspaceAppearanceSettings = {
  background: "material",
  gap: 4
};

export const DEFAULT_GAME_BROWSER_SETTINGS: GameBrowserSettings = {
  fonts: DEFAULT_BROWSER_FONT_SETTINGS,
  macroBadgePosition: DEFAULT_MACRO_BADGE_POSITION,
  performance: DEFAULT_BROWSER_PERFORMANCE_SETTINGS,
  workspace: DEFAULT_WORKSPACE_APPEARANCE_SETTINGS
};

export function normalizeGameBrowserSettings(
  value: unknown,
  fallback: GameBrowserSettings = DEFAULT_GAME_BROWSER_SETTINGS
): GameBrowserSettings {
  const input = isRecord(value) ? value : {};

  return {
    fonts: normalizeBrowserFontSettings(input.fonts, fallback.fonts),
    macroBadgePosition: normalizeMacroBadgePositionSettings(
      input.macroBadgePosition,
      fallback.macroBadgePosition
    ),
    performance: normalizeBrowserPerformanceSettings(input.performance, fallback.performance),
    workspace: normalizeWorkspaceAppearanceSettings(input.workspace, fallback.workspace)
  };
}

export function normalizeBrowserPerformanceSettings(
  value: unknown,
  fallback: BrowserPerformanceSettings = DEFAULT_BROWSER_PERFORMANCE_SETTINGS
): BrowserPerformanceSettings {
  const input = isRecord(value) ? value : {};
  return {
    macosHighRefreshRate:
      typeof input.macosHighRefreshRate === "boolean"
        ? input.macosHighRefreshRate
        : fallback.macosHighRefreshRate
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

export function normalizeBrowserFontSettings(
  value: unknown,
  fallback: BrowserFontSettings = DEFAULT_BROWSER_FONT_SETTINGS
): BrowserFontSettings {
  const input = isRecord(value) ? value : {};
  const hasInput = Object.keys(input).length > 0;
  const fontSmoothingEnabled =
    typeof input.fontSmoothingEnabled === "boolean"
      ? input.fontSmoothingEnabled
      : fallback.fontSmoothingEnabled;
  if (
    input.mode === "default" ||
    (Object.hasOwn(input, "mode") && input.mode !== "custom")
  ) {
    return {
      ...cloneBrowserFontSettings(DEFAULT_BROWSER_FONT_SETTINGS),
      fontSmoothingEnabled
    };
  }
  const mode = normalizeBrowserFontSettingsMode(input.mode, fallback.mode);
  const cjkVariant = normalizeBrowserFontCjkVariant(input.cjkVariant, fallback.cjkVariant);
  const slots = normalizeBrowserFontSlots(input.slots, hasInput ? {} : fallback.slots);
  const presetId =
    normalizePresetId(input.presetId) ?? (!hasInput ? normalizePresetId(fallback.presetId) : undefined);

  return mode === "default"
    ? { ...cloneBrowserFontSettings(DEFAULT_BROWSER_FONT_SETTINGS), fontSmoothingEnabled }
    : { cjkVariant, fontSmoothingEnabled, mode, ...(presetId ? { presetId } : {}), slots };
}

function cloneBrowserFontSettings(settings: BrowserFontSettings): BrowserFontSettings {
  return { ...settings, slots: { ...settings.slots } };
}

export function normalizeBrowserFontSlots(
  value: unknown,
  fallback: Partial<Record<BrowserFontSlot, BrowserFontSelection>> = {}
): Partial<Record<BrowserFontSlot, BrowserFontSelection>> {
  const input = isRecord(value) ? value : {};
  const normalized: Partial<Record<BrowserFontSlot, BrowserFontSelection>> = {};

  for (const slot of browserFontSlots) {
    const selection = normalizeBrowserFontSelection(input[slot], fallback[slot]);
    if (selection) {
      normalized[slot] = selection;
    }
  }

  return normalized;
}

export function isBrowserFontSlot(value: unknown): value is BrowserFontSlot {
  return browserFontSlots.includes(value as BrowserFontSlot);
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

function normalizeBrowserFontCjkVariant(
  value: unknown,
  fallback: BrowserFontCjkVariant
): BrowserFontCjkVariant {
  return browserFontCjkVariants.includes(value as BrowserFontCjkVariant)
    ? (value as BrowserFontCjkVariant)
    : fallback;
}

function normalizeBrowserFontSelection(
  value: unknown,
  fallback?: BrowserFontSelection
): BrowserFontSelection | undefined {
  if (!isRecord(value)) return fallback;
  if (value.source === "system") {
    const family = normalizeBrowserFontFamily(value.family);
    return family ? { source: "system", family } : fallback;
  }
  if (value.source === "google" && typeof value.catalogId === "string") {
    const catalogId = value.catalogId.trim().toLocaleLowerCase();
    if (!/^[a-z0-9-]{1,64}$/.test(catalogId)) return fallback;
    if (catalogId.startsWith("custom-")) {
      if (!/^custom-[a-f0-9]{32}$/.test(catalogId)) return fallback;
      const family = normalizeBrowserFontFamily(value.family);
      return family ? { source: "google", catalogId, family } : fallback;
    }
    return { source: "google", catalogId };
  }
  return fallback;
}

function normalizePresetId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLocaleLowerCase();
  return /^[a-z0-9-]{1,64}$/.test(normalized) ? normalized : undefined;
}

export function resolveBrowserFontPreset(
  presetId: BrowserFontPresetId,
  variant: Exclude<BrowserFontCjkVariant, "auto">
): BrowserFontSettings {
  const preset = browserFontPresets.find((candidate) => candidate.id === presetId);
  if (!preset) return DEFAULT_BROWSER_FONT_SETTINGS;
  const slots = { ...preset.slots };
  const cjkCatalogId = preset.cjkCatalog[variant];
  if (cjkCatalogId) slots.cjk = google(cjkCatalogId);
  return {
    cjkVariant: variant,
    fontSmoothingEnabled: DEFAULT_BROWSER_FONT_SETTINGS.fontSmoothingEnabled,
    mode: "custom",
    presetId,
    slots
  };
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
