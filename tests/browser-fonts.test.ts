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
  it("uses the system-font preset for missing and default-mode settings", () => {
    expect(normalizeGameBrowserSettings(undefined)).toEqual(DEFAULT_GAME_BROWSER_SETTINGS);
    expect(
      normalizeGameBrowserSettings({
        fonts: {
          mode: "default"
        }
      })
    ).toEqual(DEFAULT_GAME_BROWSER_SETTINGS);
    expect(DEFAULT_GAME_BROWSER_SETTINGS.fonts).toEqual({
      cjkVariant: "auto",
      fontSmoothingEnabled: true,
      mode: "custom",
      presetId: "system-default",
      slots: {
        cjk: { source: "system", family: "system-ui" },
        latin: { source: "system", family: "system-ui" },
        numeric: { source: "system", family: "system-ui" },
        monospace: { source: "system", family: "ui-monospace" },
        math: { source: "system", family: "math" }
      }
    });
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
        fontSmoothingEnabled: true,
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
      macroOverlay: DEFAULT_GAME_BROWSER_SETTINGS.macroOverlay,
      workspace: DEFAULT_WORKSPACE_APPEARANCE_SETTINGS
    });
  });

  it("keeps an explicit custom selection partial instead of filling system defaults", () => {
    expect(
      normalizeGameBrowserSettings({
        fonts: {
          cjkVariant: "auto",
          mode: "custom",
          slots: {
            latin: { source: "system", family: "Arial" }
          }
        }
      }).fonts
    ).toEqual({
      cjkVariant: "auto",
      fontSmoothingEnabled: true,
      mode: "custom",
      slots: {
        latin: { source: "system", family: "Arial" }
      }
    });
  });

  it("persists an explicit font-smoothing opt-out independently of font mode", () => {
    expect(
      normalizeGameBrowserSettings({
        fonts: {
          fontSmoothingEnabled: false,
          mode: "default"
        }
      }).fonts
    ).toEqual({
      ...DEFAULT_GAME_BROWSER_SETTINGS.fonts,
      fontSmoothingEnabled: false
    });
    expect(
      normalizeGameBrowserSettings({
        fonts: {
          cjkVariant: "auto",
          fontSmoothingEnabled: false,
          mode: "custom",
          slots: {}
        }
      }).fonts.fontSmoothingEnabled
    ).toBe(false);
    expect(
      normalizeGameBrowserSettings({
        fonts: {
          cjkVariant: "auto",
          fontSmoothingEnabled: "yes",
          mode: "custom",
          slots: {}
        }
      }).fonts.fontSmoothingEnabled
    ).toBe(true);
  });

  it("provides language-specific general, handwriting, and personality presets", () => {
    expect(browserFontPresets).toHaveLength(21);
    expect(browserFontPresets.filter((preset) => preset.category === "general")).toHaveLength(9);
    expect(browserFontPresets.filter((preset) => preset.category === "handwriting")).toHaveLength(6);
    expect(browserFontPresets.filter((preset) => preset.category === "personality")).toHaveLength(6);
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
    for (const presetId of [
      "natural-handwriting",
      "playful-handwriting",
      "calligraphic-handwriting",
      "neat-notebook",
      "storybook-handwriting",
      "marker-notes"
    ] as const) {
      expect(resolveBrowserFontPreset(presetId, "tc").slots.numeric).toEqual({
        source: "google",
        catalogId: "patrick-hand"
      });
    }
    expect(resolveBrowserFontPreset("neat-notebook", "tc").slots.latin).toEqual({
      source: "google",
      catalogId: "handlee"
    });
    expect(resolveBrowserFontPreset("storybook-handwriting", "tc").slots.latin).toEqual({
      source: "google",
      catalogId: "short-stack"
    });

    const personalityCjkCases = [
      ["friendly-rounded", "tc", "chiron-go-round-tc"],
      ["friendly-rounded", "sc", "zcool-kuaile"],
      ["friendly-rounded", "jp", "zen-maru-gothic"],
      ["marker-notes", "tc", "lxgw-marker-gothic"],
      ["marker-notes", "sc", "zcool-qingke-huangyou"],
      ["marker-notes", "jp", "yusei-magic"],
      ["editorial-serif", "tc", "cactus-classical-serif"],
      ["editorial-serif", "sc", "zcool-xiaowei"],
      ["editorial-serif", "jp", "hina-mincho"],
      ["retro-game", "tc", "wdxl-lubrifont-tc"],
      ["retro-game", "sc", "wdxl-lubrifont-sc"],
      ["retro-game", "jp", "wdxl-lubrifont-jp-n"],
      ["fantasy-chronicle", "tc", "cactus-classical-serif"],
      ["fantasy-chronicle", "sc", "zcool-xiaowei"],
      ["fantasy-chronicle", "jp", "kaisei-tokumin"],
      ["future-interface", "tc", "chocolate-classical-sans"],
      ["future-interface", "sc", "zcool-qingke-huangyou"],
      ["future-interface", "jp", "zen-kaku-gothic-new"],
      ["relaxed-dialogue", "tc", "huninn"],
      ["relaxed-dialogue", "sc", "zcool-kuaile"],
      ["relaxed-dialogue", "jp", "kiwi-maru"]
    ] as const;

    for (const [presetId, variant, catalogId] of personalityCjkCases) {
      expect(resolveBrowserFontPreset(presetId, variant).slots.cjk).toEqual({
        source: "google",
        catalogId
      });
    }

    expect(resolveBrowserFontPreset("friendly-rounded", "tc").slots).toMatchObject({
      latin: { source: "google", catalogId: "fredoka" },
      numeric: { source: "google", catalogId: "fredoka" },
      monospace: { source: "google", catalogId: "jetbrains-mono" },
      math: { source: "google", catalogId: "noto-sans-math" }
    });
    expect(resolveBrowserFontPreset("marker-notes", "tc").slots.latin).toEqual({
      source: "google",
      catalogId: "permanent-marker"
    });
    expect(resolveBrowserFontPreset("editorial-serif", "tc").slots.latin).toEqual({
      source: "google",
      catalogId: "playfair-display"
    });
    expect(resolveBrowserFontPreset("retro-game", "tc").slots).toMatchObject({
      latin: { source: "google", catalogId: "pixelify-sans" },
      numeric: { source: "google", catalogId: "pixelify-sans" },
      monospace: { source: "google", catalogId: "jetbrains-mono" },
      math: { source: "google", catalogId: "noto-sans-math" }
    });
    expect(resolveBrowserFontPreset("high-legibility", "tc").slots).toMatchObject({
      latin: { source: "google", catalogId: "atkinson-hyperlegible-next" },
      numeric: { source: "google", catalogId: "atkinson-hyperlegible-mono" },
      monospace: { source: "google", catalogId: "atkinson-hyperlegible-mono" },
      math: { source: "google", catalogId: "noto-sans-math" }
    });
    expect(resolveBrowserFontPreset("compact-dashboard", "tc").slots).toMatchObject({
      latin: { source: "google", catalogId: "roboto-condensed" },
      numeric: { source: "google", catalogId: "roboto-condensed" },
      monospace: { source: "google", catalogId: "roboto-mono" }
    });
    expect(resolveBrowserFontPreset("fresh-humanist", "tc").slots.cjk).toEqual({
      source: "google",
      catalogId: "chocolate-classical-sans"
    });
    expect(resolveBrowserFontPreset("fresh-humanist", "sc").slots.cjk).toEqual({
      source: "google",
      catalogId: "noto-sans-sc"
    });
    expect(resolveBrowserFontPreset("fresh-humanist", "jp").slots.cjk).toEqual({
      source: "google",
      catalogId: "shippori-antique"
    });
    expect(resolveBrowserFontPreset("fresh-humanist", "tc").slots).toMatchObject({
      latin: { source: "google", catalogId: "lato" },
      numeric: { source: "google", catalogId: "lato" },
      monospace: { source: "google", catalogId: "roboto-mono" },
      math: { source: "google", catalogId: "noto-sans-math" }
    });
    expect(resolveBrowserFontPreset("fantasy-chronicle", "tc").slots).toMatchObject({
      latin: { source: "google", catalogId: "cinzel" },
      numeric: { source: "google", catalogId: "cinzel" },
      monospace: { source: "google", catalogId: "roboto-mono" }
    });
    expect(resolveBrowserFontPreset("future-interface", "tc").slots).toMatchObject({
      latin: { source: "google", catalogId: "exo-2" },
      numeric: { source: "google", catalogId: "orbitron" },
      monospace: { source: "google", catalogId: "jetbrains-mono" }
    });
    expect(resolveBrowserFontPreset("relaxed-dialogue", "tc").slots).toMatchObject({
      latin: { source: "google", catalogId: "nunito" },
      numeric: { source: "google", catalogId: "nunito" },
      monospace: { source: "google", catalogId: "roboto-mono" }
    });
  });

  it.each([
    { macosHighRefreshRate: true },
    { macosHighRefreshRate: false },
    { macosHighRefreshMode: "auto" },
    { macosHighRefreshMode: "enabled" },
    { macosHighRefreshMode: "disabled" },
    { macosHighRefreshMode: "invalid" },
    { maximumWebGlPerformance: false }
  ])("ignores retired performance preferences %j", (performance) => {
    expect(normalizeGameBrowserSettings({ performance })).toEqual(DEFAULT_GAME_BROWSER_SETTINGS);
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

  it("defaults macro overlay visibility on and preserves explicit boolean choices", () => {
    expect(normalizeGameBrowserSettings({}).macroOverlay).toEqual({
      showClickMarkers: true,
      showRunningBadges: true,
      showToolButton: true
    });
    expect(normalizeGameBrowserSettings({
      macroOverlay: {
        showClickMarkers: false,
        showRunningBadges: "no",
        showToolButton: false
      }
    }).macroOverlay).toEqual({
      showClickMarkers: false,
      showRunningBadges: true,
      showToolButton: false
    });
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

  it("keeps a validated family name with custom Google Font selections", () => {
    const customCatalogId = `custom-${"a".repeat(32)}`;
    expect(
      normalizeGameBrowserSettings({
        fonts: {
          cjkVariant: "auto",
          mode: "custom",
          slots: {
            latin: {
              source: "google",
              catalogId: customCatalogId.toUpperCase(),
              family: "  Cormorant   Garamond  "
            }
          }
        }
      }).fonts.slots.latin
    ).toEqual({
      source: "google",
      catalogId: customCatalogId,
      family: "Cormorant Garamond"
    });
    expect(
      normalizeGameBrowserSettings({
        fonts: {
          cjkVariant: "auto",
          mode: "custom",
          slots: {
            latin: { source: "google", catalogId: customCatalogId }
          }
        }
      }).fonts.slots.latin
    ).toBeUndefined();
  });
});
