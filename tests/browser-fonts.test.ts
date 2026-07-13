import { describe, expect, it } from "vitest";

import {
  DEFAULT_BROWSER_NETWORK_SETTINGS,
  DEFAULT_GAME_BROWSER_SETTINGS,
  normalizeBrowserFontFamily,
  normalizeBrowserProxyServer,
  normalizeGameBrowserSettings
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
      launchMode: "auto",
      network: DEFAULT_BROWSER_NETWORK_SETTINGS
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

  it("drops invalid font family strings and keeps valid uninstalled names", () => {
    const longFamily = "A".repeat(121);

    expect(normalizeBrowserFontFamily("Missing But Valid Font")).toBe("Missing But Valid Font");
    expect(normalizeBrowserFontFamily("Bad\u0000Font", "Fallback")).toBe("Fallback");
    expect(normalizeBrowserFontFamily(longFamily)).toBeUndefined();
  });
});
