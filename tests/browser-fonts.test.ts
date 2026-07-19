import { describe, expect, it } from "vitest";

import {
  DEFAULT_BROWSER_NETWORK_SETTINGS,
  DEFAULT_GAME_BROWSER_SETTINGS,
  DEFAULT_WORKSPACE_APPEARANCE_SETTINGS,
  normalizeBrowserFontFamily,
  normalizeBrowserProxyServer,
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
      graphics: { mode: "automatic" },
      launchMode: "auto",
      macroBadgePosition: DEFAULT_GAME_BROWSER_SETTINGS.macroBadgePosition,
      network: DEFAULT_BROWSER_NETWORK_SETTINGS,
      workspace: DEFAULT_WORKSPACE_APPEARANCE_SETTINGS
    });
  });

  it("normalizes browser launch mode", () => {
    expect(normalizeGameBrowserSettings({ launchMode: "external" }).launchMode).toBe("external");
    expect(normalizeGameBrowserSettings({ launchMode: "turbo" }).launchMode).toBe("auto");
    expect(
      normalizeGameBrowserSettings({ launchMode: "turbo" }, { ...DEFAULT_GAME_BROWSER_SETTINGS, launchMode: "embedded" })
        .launchMode
    ).toBe("embedded");
  });

  it("normalizes macro badge position options and falls back for invalid values", () => {
    expect(
      normalizeGameBrowserSettings({
        macroBadgePosition: {
          horizontalAlign: "right",
          horizontalMarginPercent: 15,
          topPercent: 65
        }
      }).macroBadgePosition
    ).toEqual({
      horizontalAlign: "right",
      horizontalMarginPercent: 15,
      topPercent: 65
    });
    expect(
      normalizeGameBrowserSettings({
        macroBadgePosition: {
          horizontalAlign: "diagonal",
          horizontalMarginPercent: 3,
          topPercent: 81
        }
      }).macroBadgePosition
    ).toEqual(DEFAULT_GAME_BROWSER_SETTINGS.macroBadgePosition);
  });

  it("defaults legacy graphics settings and validates acceleration modes", () => {
    expect(normalizeGameBrowserSettings({}).graphics).toEqual({ mode: "automatic" });
    expect(normalizeGameBrowserSettings({ graphics: { mode: "high_performance" } }).graphics).toEqual({
      mode: "high_performance"
    });
    expect(normalizeGameBrowserSettings({ graphics: { mode: "unsafe" } }).graphics).toEqual({ mode: "automatic" });
  });

  it("normalizes browser proxy settings", () => {
    expect(
      normalizeGameBrowserSettings({
        network: {
          proxy: {
            mode: "custom",
            server: " socks5://127.0.0.1:7890/ "
          }
        }
      }).network.proxy
    ).toEqual({ mode: "custom", server: "socks5://127.0.0.1:7890" });

    expect(normalizeBrowserProxyServer("http://localhost:7890")).toBe("http://localhost:7890");
    expect(normalizeBrowserProxyServer("ftp://127.0.0.1:7890", "http://127.0.0.1:7890")).toBe(
      "http://127.0.0.1:7890"
    );
    expect(normalizeBrowserProxyServer("http://127.0.0.1:7890/path")).toBe("");
  });

  it("defaults legacy network settings to automatic CDN compatibility and validates modes", () => {
    expect(
      normalizeGameBrowserSettings({
        network: {
          proxy: { mode: "system", server: "" }
        }
      }).network.cdnCompatibility
    ).toEqual({ mode: "auto" });
    expect(
      normalizeGameBrowserSettings({
        network: {
          cdnCompatibility: { mode: "on" }
        }
      }).network.cdnCompatibility
    ).toEqual({ mode: "on" });
    expect(
      normalizeGameBrowserSettings({
        network: {
          cdnCompatibility: { mode: "invalid" }
        }
      }).network.cdnCompatibility
    ).toEqual({ mode: "auto" });
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
