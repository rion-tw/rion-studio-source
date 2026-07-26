import { describe, expect, it } from "vitest";

import {
  DEFAULT_GAME_BROWSER_SETTINGS,
  LEGACY_AUTOMATIC_BROWSER_GRAPHICS_SETTINGS,
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
      browserEngine: "system",
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
      graphics: DEFAULT_GAME_BROWSER_SETTINGS.graphics,
      macroBadgePosition: DEFAULT_GAME_BROWSER_SETTINGS.macroBadgePosition,
      workspace: DEFAULT_WORKSPACE_APPEARANCE_SETTINGS
    });
  });

  it("normalizes legacy and unknown browser engines to System", () => {
    expect(normalizeGameBrowserSettings({}).browserEngine).toBe("system");
    expect(normalizeGameBrowserSettings({ browserEngine: "electron" }).browserEngine).toBe(
      "system"
    );
    expect(normalizeGameBrowserSettings({ browserEngine: "webkit" }).browserEngine).toBe(
      "system"
    );
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

  it("uses recommended defaults for new installs and preserves legacy graphics mode behavior", () => {
    expect(normalizeGameBrowserSettings({}).graphics).toEqual(DEFAULT_GAME_BROWSER_SETTINGS.graphics);
    expect(normalizeGameBrowserSettings({ graphics: { mode: "automatic" } }).graphics).toEqual(
      LEGACY_AUTOMATIC_BROWSER_GRAPHICS_SETTINGS
    );
    expect(normalizeGameBrowserSettings({ graphics: { mode: "high_performance" } }).graphics).toEqual({
      ...LEGACY_AUTOMATIC_BROWSER_GRAPHICS_SETTINGS,
      preferHighPerformanceGpu: true
    });
    expect(normalizeGameBrowserSettings({ graphics: { mode: "experimental" } }).graphics).toEqual({
      ...LEGACY_AUTOMATIC_BROWSER_GRAPHICS_SETTINGS,
      gpuBlocklistEnabled: false,
      preferHighPerformanceGpu: true,
      unsafeWebGpuEnabled: true
    });
    expect(normalizeGameBrowserSettings({ graphics: { mode: "unsafe" } }).graphics).toEqual(
      LEGACY_AUTOMATIC_BROWSER_GRAPHICS_SETTINGS
    );
    expect(
      normalizeGameBrowserSettings({
        graphics: { preferHighPerformanceGpu: false }
      }).graphics.windowsEcoQosEnabled
    ).toBe(true);
    expect(
      normalizeGameBrowserSettings({
        graphics: {
          ...DEFAULT_GAME_BROWSER_SETTINGS.graphics,
          windowsEcoQosEnabled: false
        }
      }).graphics.windowsEcoQosEnabled
    ).toBe(false);
  });

  it("normalizes backends and forces VSync off when the frame-rate limiter is disabled", () => {
    expect(
      normalizeGameBrowserSettings({
        graphics: {
          ...DEFAULT_GAME_BROWSER_SETTINGS.graphics,
          backend: { macos: "invalid", windows: "vulkan" },
          frameRateLimitEnabled: false,
          vsyncEnabled: true
        }
      }).graphics
    ).toEqual({
      ...DEFAULT_GAME_BROWSER_SETTINGS.graphics,
      backend: { macos: "automatic", windows: "vulkan" },
      frameRateLimitEnabled: false,
      vsyncEnabled: false
    });
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
