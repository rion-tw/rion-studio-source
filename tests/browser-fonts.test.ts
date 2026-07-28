import { describe, expect, it } from "vitest";

import {
  DEFAULT_GAME_BROWSER_SETTINGS,
  DEFAULT_WORKSPACE_APPEARANCE_SETTINGS,
  normalizeBrowserFontFamily,
  normalizeGameBrowserSettings,
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

  it("normalizes custom font families without adding font size settings", () => {
    expect(
      normalizeGameBrowserSettings({
        fonts: {
          families: {
            fixed: "  Courier   New  ",
            math: "Noto Sans Math",
            sansserif: "Helvetica",
            serif: "Times New Roman",
            standard: "Arial",
            unknown: "Ignored"
          },
          mode: "custom"
        }
      })
    ).toEqual({
      fonts: {
        families: {
          fixed: "Courier New",
          math: "Noto Sans Math",
          sansserif: "Helvetica",
          serif: "Times New Roman",
          standard: "Arial"
        },
        mode: "custom"
      },
      macroBadgePosition: DEFAULT_GAME_BROWSER_SETTINGS.macroBadgePosition,
      performance: DEFAULT_GAME_BROWSER_SETTINGS.performance,
      workspace: DEFAULT_WORKSPACE_APPEARANCE_SETTINGS
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
