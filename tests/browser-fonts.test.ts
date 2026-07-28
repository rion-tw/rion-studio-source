import { describe, expect, it } from "vitest";

import {
  DEFAULT_GAME_BROWSER_SETTINGS,
  DEFAULT_WORKSPACE_APPEARANCE_SETTINGS,
  browserFontPresets,
  normalizeBrowserFontFamily,
  normalizeGameBrowserSettings,
  resolveBrowserFontPreset,
  workspaceGapSizes
} from "../src/shared/browserFonts";

describe("browser font settings normalization", () => {
  it("returns browser defaults for missing or default-mode settings", () => {
    expect(normalizeGameBrowserSettings(undefined)).toEqual(DEFAULT_GAME_BROWSER_SETTINGS);
    expect(
      normalizeGameBrowserSettings({
        fonts: {
          families: {
            standard: "Arial"
          },
          mode: "default"
        }
      })
    ).toEqual(DEFAULT_GAME_BROWSER_SETTINGS);
  });

  it("normalizes five routed font slots without adding font size settings", () => {
    expect(
      normalizeGameBrowserSettings({
        fonts: {
          cjkVariant: "tc",
          mode: "custom",
          presetId: "modern-sans",
          slots: {
            cjk: { source: "google", catalogId: "NOTO-SANS-TC" },
            latin: { source: "system", family: "  Helvetica   Neue  " },
            numeric: { source: "google", catalogId: "roboto-mono" },
            monospace: { source: "system", family: "  Courier   New  " },
            math: { source: "google", catalogId: "noto-sans-math" },
            unknown: { source: "system", family: "Ignored" }
          },
        }
      })
    ).toEqual({
      fonts: {
        cjkVariant: "tc",
        mode: "custom",
        presetId: "modern-sans",
        slots: {
          cjk: { source: "google", catalogId: "noto-sans-tc" },
          latin: { source: "system", family: "Helvetica Neue" },
          numeric: { source: "google", catalogId: "roboto-mono" },
          monospace: { source: "system", family: "Courier New" },
          math: { source: "google", catalogId: "noto-sans-math" }
        },
      },
      macroBadgePosition: DEFAULT_GAME_BROWSER_SETTINGS.macroBadgePosition,
      performance: DEFAULT_GAME_BROWSER_SETTINGS.performance,
      workspace: DEFAULT_WORKSPACE_APPEARANCE_SETTINGS
    });
  });

  it("migrates legacy Chrome-style family roles into the new slots", () => {
    const normalized = normalizeGameBrowserSettings({
      fonts: {
        mode: "custom",
        families: {
          standard: "  Missing   But Valid  ",
          fixed: "Courier New",
          math: "Noto Sans Math"
        }
      }
    });

    expect(normalized.fonts).toEqual({
      cjkVariant: "auto",
      mode: "custom",
      slots: {
        cjk: { source: "system", family: "Missing But Valid" },
        latin: { source: "system", family: "Missing But Valid" },
        numeric: { source: "system", family: "Missing But Valid" },
        monospace: { source: "system", family: "Courier New" },
        math: { source: "system", family: "Noto Sans Math" }
      }
    });
  });

  it("provides language-specific general and handwriting presets", () => {
    expect(browserFontPresets.filter((preset) => preset.category === "handwriting")).toHaveLength(3);
    expect(resolveBrowserFontPreset("natural-handwriting", "tc").slots.cjk).toEqual({
      source: "google",
      catalogId: "iansui"
    });
    expect(resolveBrowserFontPreset("natural-handwriting", "sc").slots.cjk).toEqual({
      source: "google",
      catalogId: "ma-shan-zheng"
    });
    expect(resolveBrowserFontPreset("natural-handwriting", "jp").slots.cjk).toEqual({
      source: "google",
      catalogId: "klee-one"
    });
    expect(resolveBrowserFontPreset("clear-numbers", "tc").slots.numeric).toEqual({
      source: "google",
      catalogId: "roboto-mono"
    });
  });

  it("defaults and validates the macOS high refresh preference", () => {
    expect(normalizeGameBrowserSettings({}).performance).toEqual({
      macosHighRefreshRate: false
    });
    expect(
      normalizeGameBrowserSettings({ performance: { macosHighRefreshRate: true } }).performance
    ).toEqual({ macosHighRefreshRate: true });
    expect(
      normalizeGameBrowserSettings({ performance: { macosHighRefreshRate: "yes" } }).performance
    ).toEqual({ macosHighRefreshRate: false });
  });

  it("removes legacy browser engine settings", () => {
    expect("browserEngine" in normalizeGameBrowserSettings({})).toBe(false);
    expect(
      "browserEngine" in normalizeGameBrowserSettings({ browserEngine: "electron" })
    ).toBe(false);
  });

  it("normalizes macro badge position options and falls back for invalid values", () => {
    expect(
      normalizeGameBrowserSettings({
        macroBadgePosition: {
          horizontalAlign: "right",
          horizontalMarginPx: 120,
          topPx: 240
        }
      }).macroBadgePosition
    ).toEqual({
      horizontalAlign: "right",
      horizontalMarginPx: 120,
      topPx: 240
    });
    expect(
      normalizeGameBrowserSettings({
        macroBadgePosition: {
          horizontalAlign: "diagonal",
          horizontalMarginPx: 3,
          topPx: 81
        }
      }).macroBadgePosition
    ).toEqual(DEFAULT_GAME_BROWSER_SETTINGS.macroBadgePosition);
  });

  it("ignores legacy percentage position fields and uses the px defaults", () => {
    expect(
      normalizeGameBrowserSettings({
        macroBadgePosition: {
          horizontalAlign: "left",
          horizontalMarginPercent: 20,
          topPercent: 80
        }
      }).macroBadgePosition
    ).toEqual({
      ...DEFAULT_GAME_BROWSER_SETTINGS.macroBadgePosition,
      horizontalAlign: "left"
    });
  });

  it("accepts but removes retired graphics settings", () => {
    const normalized = normalizeGameBrowserSettings({
      graphics: {
        mode: "experimental",
        backend: { windows: "vulkan" },
        windowsEcoQosEnabled: false
      }
    });
    expect(normalized).toEqual(DEFAULT_GAME_BROWSER_SETTINGS);
    expect("graphics" in normalized).toBe(false);
  });

  it("accepts and ignores retired legacy custom proxy fields", () => {
    const normalized = normalizeGameBrowserSettings({
      network: {
        proxy: {
          mode: "custom",
          server: "socks5://127.0.0.1:7890"
        }
      }
    });

    expect(normalized).toEqual(DEFAULT_GAME_BROWSER_SETTINGS);
    expect("network" in normalized).toBe(false);
  });

  it("defaults workspace appearance and validates backgrounds and fixed gap sizes", () => {
    expect(normalizeGameBrowserSettings({}).workspace).toEqual(DEFAULT_WORKSPACE_APPEARANCE_SETTINGS);
    expect(
      normalizeGameBrowserSettings({ workspace: { background: "black", gap: 1 } }).workspace
    ).toEqual({ background: "black", gap: 1 });
    expect(
      normalizeGameBrowserSettings({ workspace: { background: "glow", gap: 3 } }).workspace
    ).toEqual(DEFAULT_WORKSPACE_APPEARANCE_SETTINGS);
    workspaceGapSizes.forEach((gap) => {
      expect(
        normalizeGameBrowserSettings({ workspace: { background: "material", gap } }).workspace.gap
      ).toBe(gap);
    });
  });

  it("drops invalid font family strings and keeps valid uninstalled names", () => {
    const longFamily = "A".repeat(121);

    expect(normalizeBrowserFontFamily("Missing But Valid Font")).toBe("Missing But Valid Font");
    expect(normalizeBrowserFontFamily("Bad\u0000Font", "Fallback")).toBe("Fallback");
    expect(normalizeBrowserFontFamily(longFamily)).toBeUndefined();
  });
});
