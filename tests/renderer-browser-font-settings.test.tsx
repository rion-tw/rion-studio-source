// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";

import { ConfirmationProvider } from "../src/renderer/src/components/ConfirmationDialog";
import SettingsView from "../src/renderer/src/features/settings/SettingsRoute";
import { resetGoogleFontPreviewRegistryForTests } from "../src/renderer/src/features/settings/googleFontPreview";
import en from "../src/renderer/src/i18n/en.json";
import type { Translator } from "../src/renderer/src/i18n";
import type { RionStudioApi } from "../src/shared/api";
import {
  DEFAULT_GAME_BROWSER_SETTINGS,
  normalizeGameBrowserSettings
} from "../src/shared/browserFonts";
import { DEFAULT_MACRO_SETTINGS } from "../src/shared/macroSettings";
import type { BrowserFontCatalogEntry, GameBrowserSettings } from "../src/shared/types";

const t: Translator = (key) => en[key] ?? key;

const catalog: BrowserFontCatalogEntry[] = [
  ["iansui", "Iansui", "handwriting", ["tc", "latin"], "body"],
  ["patrick-hand", "Patrick Hand", "handwriting", ["latin"], "body"],
  ["caveat", "Caveat", "handwriting", ["latin"], "accent"],
  ["handlee", "Handlee", "handwriting", ["latin"], "body"],
  ["short-stack", "Short Stack", "handwriting", ["latin"], "body"],
  ["chiron-go-round-tc", "Chiron GoRound TC", "sans", ["tc", "latin"], "body"],
  ["fredoka", "Fredoka", "display", ["latin"], "body"],
  ["wdxl-lubrifont-tc", "WDXL Lubrifont TC", "display", ["tc", "latin"], "body"],
  ["pixelify-sans", "Pixelify Sans", "display", ["latin"], "body"],
  ["jetbrains-mono", "JetBrains Mono", "monospace", ["latin"], "technical"],
  ["noto-sans-math", "Noto Sans Math", "math", ["math", "latin"], "technical"],
  ["atkinson-hyperlegible-next", "Atkinson Hyperlegible Next", "sans", ["latin"], "body"],
  ["atkinson-hyperlegible-mono", "Atkinson Hyperlegible Mono", "monospace", ["latin"], "technical"],
  ["roboto-condensed", "Roboto Condensed", "sans", ["latin"], "body"],
  ["cinzel", "Cinzel", "serif", ["latin"], "accent"],
  ["kaisei-tokumin", "Kaisei Tokumin", "serif", ["jp", "latin"], "body"],
  ["chocolate-classical-sans", "Chocolate Classical Sans", "sans", ["tc", "latin"], "body"],
  ["zen-kaku-gothic-new", "Zen Kaku Gothic New", "sans", ["jp", "latin"], "body"],
  ["shippori-antique", "Shippori Antique", "sans", ["jp", "latin"], "body"],
  ["lato", "Lato", "sans", ["latin"], "body"],
  ["roboto-mono", "Roboto Mono", "monospace", ["latin"], "technical"],
  ["exo-2", "Exo 2", "sans", ["latin"], "body"],
  ["orbitron", "Orbitron", "display", ["latin"], "accent"],
  ["huninn", "Huninn", "sans", ["tc", "latin"], "body"],
  ["kiwi-maru", "Kiwi Maru", "serif", ["jp", "latin"], "body"],
  ["nunito", "Nunito", "sans", ["latin"], "body"]
].map(([catalogId, family, category, scripts, usage]) => ({
  catalogId: catalogId as string,
  family: family as string,
  category: category as BrowserFontCatalogEntry["category"],
  scripts: scripts as BrowserFontCatalogEntry["scripts"],
  weights: [400],
  usage: usage as BrowserFontCatalogEntry["usage"],
  installed: false,
  cachedBytes: 0
}));

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class ResizeObserver {
    disconnect(): void {}
    observe(): void {}
    unobserve(): void {}
  });
  if (!("PointerEvent" in window)) {
    Object.defineProperty(window, "PointerEvent", {
      configurable: true,
      value: MouseEvent
    });
  }
  Object.defineProperties(HTMLElement.prototype, {
    hasPointerCapture: {
      configurable: true,
      value: () => false
    },
    releasePointerCapture: {
      configurable: true,
      value: () => undefined
    },
    scrollIntoView: {
      configurable: true,
      value: () => undefined
    },
    setPointerCapture: {
      configurable: true,
      value: () => undefined
    }
  });
});

beforeEach(() => {
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: {
      add: vi.fn(),
      delete: vi.fn(),
      load: vi.fn(async () => [])
    }
  });
  const append = document.head.append.bind(document.head);
  vi.spyOn(document.head, "append").mockImplementation((...nodes) => {
    append(...nodes);
    for (const node of nodes) {
      if (node instanceof HTMLLinkElement) queueMicrotask(() => node.dispatchEvent(new Event("load")));
    }
  });
});

afterEach(() => {
  cleanup();
  resetGoogleFontPreviewRegistryForTests();
  Reflect.deleteProperty(window, "rionStudio");
  vi.restoreAllMocks();
});

function renderSettings(
  onGameBrowserSettingsChange: (settings: GameBrowserSettings) => Promise<GameBrowserSettings>,
  gameBrowserSettings: GameBrowserSettings = DEFAULT_GAME_BROWSER_SETTINGS
): void {
  render(
    <MemoryRouter initialEntries={["/settings?section=interface"]}>
      <ConfirmationProvider>
        <SettingsView
          gameBrowserSettings={gameBrowserSettings}
          language="zh-TW"
          macroSettings={DEFAULT_MACRO_SETTINGS}
          onApplyPortableImport={async () => {
            throw new Error("not used");
          }}
          onCheckForUpdates={async () => undefined}
          onDiscardPortableImport={async () => undefined}
          onError={vi.fn()}
          onExportPortableData={async () => null}
          onGameBrowserSettingsChange={onGameBrowserSettingsChange}
          onInstallDownloadedUpdate={async () => undefined}
          onSetAutoUpdateEnabled={async () => undefined}
          onLanguageChange={() => undefined}
          onLoadSystemFonts={async () => []}
          onMacroSettingsChange={async (settings) => settings}
          onRuntimeWindowPreferencesChange={async (preferences) => preferences}
          onOpenUpdateDownload={async () => undefined}
          onPreviewPortableImport={async () => null}
          onThemeModeChange={() => undefined}
          resolvedTheme="light"
          runtimeWindowPreferences={{
            alwaysHideTabCloseButton: false,
            alwaysShowToolbarInFullScreen: false,
            restoreGameWindowsOnStartup: true
          }}
          systemFonts={[{ family: "Arial", label: "Arial" }]}
          t={t}
          themeMode="system"
          updateStatus={null}
          updateVersion=""
          isUpdateBusy={false}
          portableDataCounts={{
            gameCount: 0,
            gameWindowCount: 0,
            macroCount: 0,
            roleCount: 0,
            workspaceCount: 0
          }}
        />
      </ConfirmationProvider>
    </MemoryRouter>
  );
}

describe("browser font settings", () => {
  it("persists the top-level Chinese and Japanese glyph preference", async () => {
    const user = userEvent.setup();
    const onGameBrowserSettingsChange = vi.fn(async (settings) => settings);
    renderSettings(onGameBrowserSettingsChange);

    const gameFontsSection = screen.getByRole("heading", { name: "Game fonts" }).parentElement;
    const cjkPreference = screen.getByRole("combobox", {
      name: "Chinese and Japanese glyph style"
    });
    expect(gameFontsSection?.contains(cjkPreference)).toBe(true);

    await user.click(cjkPreference);
    await user.click(screen.getByRole("option", { name: "Japanese" }));

    await waitFor(() => {
      expect(onGameBrowserSettingsChange).toHaveBeenCalledWith({
        ...DEFAULT_GAME_BROWSER_SETTINGS,
        fonts: {
          ...DEFAULT_GAME_BROWSER_SETTINGS.fonts,
          cjkVariant: "jp"
        }
      });
    });
  });

  it("starts collapsed and toggles the font controls on demand", async () => {
    window.rionStudio = {
      listBrowserFontCatalog: vi.fn(async () => catalog),
      installBrowserFont: vi.fn(),
      removeBrowserFont: vi.fn(),
      getBrowserFontPreview: vi.fn(async (settings) => ({ settings, faces: [] }))
    } as unknown as RionStudioApi;

    renderSettings(vi.fn(async (settings) => settings));

    const toggle = screen.getByRole("button", { name: "Customize fonts" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Distinctive styles")).toBeNull();
    const advancedToggle = screen.getByRole("button", { name: "Advanced font management" });
    expect(advancedToggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByText("Advanced font management"));
    expect(advancedToggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.head.querySelector("link[data-rion-google-font-preview]")).toBeNull();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.closest(".settings-row")?.classList.contains("border-b")).toBe(false);
    expect(await screen.findByText("Distinctive styles")).toBeTruthy();
    expect(
      screen.getByText("Distinctive styles").closest(".glass-panel-strong")?.parentElement?.classList.contains("border-b")
    ).toBe(true);
    expect(screen.getByRole("button", { name: /High-legibility reading/u })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Compact dashboard/u })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Natural handwriting/u })).toBeNull();
    expect(screen.getByText("English & Latin").closest(".settings-row")?.classList.contains("border-b")).toBe(true);
    const fontPreview = screen.getByText("Online font preview").closest(".settings-row");
    const overrideWarning = screen.getByText("Font overrides take priority over game-page styles", {
      exact: false
    });
    expect(fontPreview?.contains(overrideWarning)).toBe(true);
    await waitFor(() => {
      expect(document.head.querySelector("link[data-rion-google-font-preview]")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /Distinctive styles/u }));
    expect(screen.getByRole("button", { name: /Fantasy chronicle/u })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Future interface/u })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Relaxed dialogue/u })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Handwriting styles/u }));
    expect(screen.getByRole("button", { name: /Natural handwriting/u })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Neat notebook/u })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Storybook scribble/u })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Marker notes/u })).toBeTruthy();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Distinctive styles")).toBeNull();

    fireEvent.click(advancedToggle);
    expect(advancedToggle.getAttribute("aria-expanded")).toBe("true");
    expect(advancedToggle.closest(".settings-row")?.classList.contains("border-b")).toBe(false);
    const advancedPanel = screen
      .getByRole("textbox", { name: "Google Font family name" })
      .closest(".glass-panel-strong");
    expect(advancedPanel).toBeTruthy();
    expect(advancedPanel?.parentElement?.classList.contains("border-b")).toBe(true);
    expect(advancedPanel?.firstElementChild?.classList.contains("w-full")).toBe(true);
    expect(advancedPanel?.firstElementChild?.classList.contains("settings-row")).toBe(false);
  });

  it("uses larger font samples in presets without changing font selections or options", async () => {
    const user = userEvent.setup();
    window.rionStudio = {
      listBrowserFontCatalog: vi.fn(async () => catalog),
      installBrowserFont: vi.fn(),
      removeBrowserFont: vi.fn(),
      getBrowserFontPreview: vi.fn(async (settings) => ({ settings, faces: [] }))
    } as unknown as RionStudioApi;

    renderSettings(vi.fn(async (settings) => settings));
    await user.click(screen.getByRole("button", { name: "Customize fonts" }));
    await screen.findByText("Distinctive styles");

    const presetSamples = document.querySelectorAll(".browser-font-preset-sample .browser-font-sample");
    expect(presetSamples.length).toBeGreaterThan(0);
    expect([...presetSamples].every((sample) => sample.classList.contains("text-base"))).toBe(true);
    expect(document.querySelector(".browser-font-preview-samples")?.classList.contains("text-lg")).toBe(true);

    const trigger = screen.getByRole("button", { name: "English & Latin" });
    expect(trigger.querySelector(".text-base")).toBeNull();
    await user.click(trigger);

    const optionSamples = await screen.findAllByText("Aa Rion");
    expect(optionSamples.length).toBeGreaterThan(0);
    expect(optionSamples.every((sample) => sample.classList.contains("text-sm"))).toBe(true);
    expect(
      [...document.querySelectorAll(".browser-font-option-label")].every((label) => !label.classList.contains("text-base"))
    ).toBe(true);
  });

  it("searches and applies a system font within an individual font slot", async () => {
    const user = userEvent.setup();
    window.rionStudio = {
      listBrowserFontCatalog: vi.fn(async () => catalog),
      installBrowserFont: vi.fn(),
      removeBrowserFont: vi.fn(),
      getBrowserFontPreview: vi.fn(async (settings) => ({ settings, faces: [] }))
    } as unknown as RionStudioApi;
    const onGameBrowserSettingsChange = vi.fn(async (settings) => settings);

    renderSettings(onGameBrowserSettingsChange);
    await user.click(screen.getByRole("button", { name: "Customize fonts" }));
    await screen.findByText("Distinctive styles");

    const trigger = screen.getByRole("button", { name: "English & Latin" });
    await user.click(trigger);
    const search = await screen.findByRole("textbox", {
      name: "Search system and Google fonts for English & Latin"
    });
    await waitFor(() => expect(document.activeElement).toBe(search));

    await user.type(search, "Arial");
    const option = screen.getByRole("menuitemradio", { name: "Arial · System" });
    expect(screen.queryByRole("menuitemradio", { name: /Patrick Hand/u })).toBeNull();
    await user.click(option);

    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(trigger.textContent).toContain("Arial · System");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => {
      expect(onGameBrowserSettingsChange).toHaveBeenCalledWith(
        expect.objectContaining({
          fonts: expect.objectContaining({
            mode: "custom",
            slots: expect.objectContaining({
              latin: { source: "system", family: "Arial" }
            })
          })
        })
      );
    });
  });

  it("downloads a Google Font entered by family name and makes it selectable", async () => {
    const user = userEvent.setup();
    const customFont: BrowserFontCatalogEntry = {
      catalogId: `custom-${"a".repeat(32)}`,
      family: "Cormorant Garamond",
      category: "sans",
      scripts: ["latin", "tc", "sc", "jp", "math"],
      weights: [400],
      usage: "body",
      installed: true,
      cachedBytes: 2048
    };
    const listBrowserFontCatalog = vi
      .fn<() => Promise<BrowserFontCatalogEntry[]>>()
      .mockResolvedValueOnce(catalog)
      .mockResolvedValue([...catalog, customFont]);
    const installGoogleFont = vi.fn(async (family: string) => ({
      catalogId: customFont.catalogId,
      installed: true,
      cachedBytes: customFont.cachedBytes,
      family
    }));
    window.rionStudio = {
      listBrowserFontCatalog,
      installBrowserFont: vi.fn(),
      installGoogleFont,
      removeBrowserFont: vi.fn(),
      getBrowserFontPreview: vi.fn(async (settings) => ({ settings, faces: [] }))
    } as unknown as RionStudioApi;
    const onGameBrowserSettingsChange = vi.fn(async (settings) => settings);

    renderSettings(onGameBrowserSettingsChange);
    await user.click(screen.getByRole("button", { name: "Customize fonts" }));
    await user.click(screen.getByRole("button", { name: "Advanced font management" }));
    const input = screen.getByRole("textbox", { name: "Google Font family name" });
    await user.type(input, "  Cormorant   Garamond  ");
    await user.click(screen.getByRole("button", { name: "Download font" }));

    await waitFor(() => expect(installGoogleFont).toHaveBeenCalledWith("Cormorant Garamond"));
    expect(
      await screen.findByText("Downloaded Cormorant Garamond. You can now select it above.")
    ).toBeTruthy();
    expect(document.querySelector(".browser-font-cache-grid")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "English & Latin" }));
    await user.click(screen.getByRole("combobox", { name: "Font category" }));
    await user.click(screen.getByRole("option", { name: "Sans serif" }));
    const search = await screen.findByRole("textbox", {
      name: "Search system and Google fonts for English & Latin"
    });
    await user.type(search, "Cormorant");
    await user.click(
      screen.getByRole("menuitemradio", { name: "Cormorant Garamond · Downloaded" })
    );
    await user.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => {
      expect(onGameBrowserSettingsChange).toHaveBeenCalledWith(
        expect.objectContaining({
          fonts: expect.objectContaining({
            slots: expect.objectContaining({
              latin: {
                source: "google",
                catalogId: customFont.catalogId,
                family: customFont.family
              }
            })
          })
        })
      );
    });
  });

  it("shows an inline alert when a named Google Font download fails", async () => {
    const user = userEvent.setup();
    const installGoogleFont = vi.fn(async () => {
      throw new Error("Font download returned HTTP 400.");
    });
    window.rionStudio = {
      listBrowserFontCatalog: vi.fn(async () => catalog),
      installBrowserFont: vi.fn(),
      installGoogleFont,
      removeBrowserFont: vi.fn(),
      getBrowserFontPreview: vi.fn(async (settings) => ({ settings, faces: [] }))
    } as unknown as RionStudioApi;

    renderSettings(vi.fn(async (settings) => settings));
    await user.click(screen.getByRole("button", { name: "Customize fonts" }));
    await user.click(screen.getByRole("button", { name: "Advanced font management" }));
    await user.type(
      screen.getByRole("textbox", { name: "Google Font family name" }),
      "Definitely Missing Font"
    );
    await user.click(screen.getByRole("button", { name: "Download font" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Couldn’t download Definitely Missing Font. Check the font name and internet connection, then try again."
    );
    expect(installGoogleFont).toHaveBeenCalledWith("Definitely Missing Font");
  });

  it("redownloads a selected custom Google Font by its persisted family name", async () => {
    const user = userEvent.setup();
    const customCatalogId = `custom-${"b".repeat(32)}`;
    const installGoogleFont = vi.fn(async () => ({
      catalogId: customCatalogId,
      installed: true,
      cachedBytes: 2048
    }));
    window.rionStudio = {
      listBrowserFontCatalog: vi.fn(async () => catalog),
      installBrowserFont: vi.fn(),
      installGoogleFont,
      removeBrowserFont: vi.fn(),
      getBrowserFontPreview: vi.fn(async (settings) => ({ settings, faces: [] }))
    } as unknown as RionStudioApi;
    const onGameBrowserSettingsChange = vi.fn(async (settings) => settings);
    const settings = normalizeGameBrowserSettings({
      fonts: {
        cjkVariant: "auto",
        mode: "custom",
        slots: {
          latin: {
            source: "google",
            catalogId: customCatalogId,
            family: "Cormorant Garamond"
          }
        }
      }
    });

    renderSettings(onGameBrowserSettingsChange, settings);
    await user.click(screen.getByRole("button", { name: "Customize fonts" }));
    await user.click(screen.getByRole("button", { name: "Download 1 and apply" }));

    await waitFor(() => expect(installGoogleFont).toHaveBeenCalledWith("Cormorant Garamond"));
    await waitFor(() => expect(onGameBrowserSettingsChange).toHaveBeenCalled());
  });

  it("keeps system fonts outside the Google category filter and downloads a searched Google font", async () => {
    const user = userEvent.setup();
    const installBrowserFont = vi.fn(async (catalogId: string) => ({
      catalogId,
      installed: true,
      cachedBytes: 1024
    }));
    window.rionStudio = {
      listBrowserFontCatalog: vi.fn(async () => catalog),
      installBrowserFont,
      removeBrowserFont: vi.fn(),
      getBrowserFontPreview: vi.fn(async (settings) => ({ settings, faces: [] }))
    } as unknown as RionStudioApi;
    const onGameBrowserSettingsChange = vi.fn(async (settings) => settings);

    renderSettings(onGameBrowserSettingsChange);
    await user.click(screen.getByRole("button", { name: "Customize fonts" }));
    await screen.findByText("Distinctive styles");
    await user.click(screen.getByRole("button", { name: "Chinese & Japanese" }));
    await user.click(screen.getByRole("combobox", { name: "Font category" }));
    await user.click(screen.getByRole("option", { name: "Handwriting" }));
    const search = await screen.findByRole("textbox", {
      name: "Search system and Google fonts for Chinese & Japanese"
    });
    await user.type(search, "Arial");
    expect(screen.getByRole("menuitemradio", { name: "Arial · System" })).toBeTruthy();

    await user.clear(search);
    await user.type(search, "patrick-hand");
    expect(screen.queryByRole("menuitemradio", { name: /Patrick Hand/u })).toBeNull();
    expect(screen.getByText("No matching fonts found.")).toBeTruthy();

    await user.clear(search);
    await user.type(search, "iansui");
    await user.click(screen.getByRole("menuitemradio", { name: "Iansui · Download on apply" }));
    await user.click(screen.getByRole("button", { name: "Download 1 and apply" }));

    await waitFor(() => expect(installBrowserFont).toHaveBeenCalledTimes(1));
    expect(installBrowserFont).toHaveBeenCalledWith("iansui");
    await waitFor(() => {
      expect(onGameBrowserSettingsChange).toHaveBeenCalledWith(
        expect.objectContaining({
          fonts: expect.objectContaining({
            slots: expect.objectContaining({
              cjk: { source: "google", catalogId: "iansui" }
            })
          })
        })
      );
    });
  });

  it("restores results after clearing search and supports keyboard entry and dismissal", async () => {
    const user = userEvent.setup();
    window.rionStudio = {
      listBrowserFontCatalog: vi.fn(async () => catalog),
      installBrowserFont: vi.fn(),
      removeBrowserFont: vi.fn(),
      getBrowserFontPreview: vi.fn(async (settings) => ({ settings, faces: [] }))
    } as unknown as RionStudioApi;

    renderSettings(vi.fn(async (settings) => settings));
    await user.click(screen.getByRole("button", { name: "Customize fonts" }));
    await screen.findByText("Distinctive styles");

    const trigger = screen.getByRole("button", { name: "Numbers" });
    await user.click(trigger);
    const search = await screen.findByRole("textbox", {
      name: "Search system and Google fonts for Numbers"
    });
    await user.type(search, "missing-font");
    expect(screen.getByText("No matching fonts found.")).toBeTruthy();

    await user.clear(search);
    expect(screen.getByRole("menuitemradio", { name: "Pixelify Sans · Download on apply" })).toBeTruthy();
    await user.type(search, "pixel");
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(
      screen.getByRole("menuitemradio", { name: "Pixelify Sans · Download on apply" })
    );

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("shows handwriting presets and downloads every missing pack before applying", async () => {
    const installBrowserFont = vi.fn(async (catalogId: string) => ({
      catalogId,
      installed: true,
      cachedBytes: 1024
    }));
    window.rionStudio = {
      listBrowserFontCatalog: vi.fn(async () => catalog),
      installBrowserFont,
      removeBrowserFont: vi.fn(),
      getBrowserFontPreview: vi.fn(async (settings) => ({ settings, faces: [] }))
    } as unknown as RionStudioApi;
    const onGameBrowserSettingsChange = vi.fn(async (settings) => settings);

    renderSettings(onGameBrowserSettingsChange);

    fireEvent.click(screen.getByRole("button", { name: "Customize fonts" }));
    expect(await screen.findByText("Handwriting styles")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Handwriting styles/u }));
    expect(screen.getByText("Chinese & Japanese")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Natural handwriting/u }));
    fireEvent.click(screen.getByRole("button", { name: "Download 4 and apply" }));

    await waitFor(() => expect(installBrowserFont).toHaveBeenCalledTimes(4));
    await waitFor(() => {
      expect(onGameBrowserSettingsChange).toHaveBeenCalledWith(
        expect.objectContaining({
          fonts: expect.objectContaining({
            cjkVariant: "auto",
            mode: "custom",
            presetId: "natural-handwriting",
            slots: expect.objectContaining({
              cjk: { source: "google", catalogId: "iansui" },
              latin: { source: "google", catalogId: "patrick-hand" },
              numeric: { source: "google", catalogId: "patrick-hand" }
            })
          })
        })
      );
    });
  });

  it("downloads shared high-legibility slots only once before applying", async () => {
    const installBrowserFont = vi.fn(async (catalogId: string) => ({
      catalogId,
      installed: true,
      cachedBytes: 1024
    }));
    window.rionStudio = {
      listBrowserFontCatalog: vi.fn(async () => catalog),
      installBrowserFont,
      removeBrowserFont: vi.fn(),
      getBrowserFontPreview: vi.fn(async (settings) => ({ settings, faces: [] }))
    } as unknown as RionStudioApi;
    const onGameBrowserSettingsChange = vi.fn(async (settings) => settings);

    renderSettings(onGameBrowserSettingsChange);

    fireEvent.click(screen.getByRole("button", { name: "Customize fonts" }));
    expect(await screen.findByText("Everyday presets")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /High-legibility reading/u }));
    fireEvent.click(screen.getByRole("button", { name: "Download 4 and apply" }));

    await waitFor(() => expect(installBrowserFont).toHaveBeenCalledTimes(4));
    expect(installBrowserFont).toHaveBeenCalledWith("noto-sans-tc");
    expect(installBrowserFont).toHaveBeenCalledWith("atkinson-hyperlegible-next");
    expect(installBrowserFont).toHaveBeenCalledWith("atkinson-hyperlegible-mono");
    expect(installBrowserFont).toHaveBeenCalledWith("noto-sans-math");
    await waitFor(() => {
      expect(onGameBrowserSettingsChange).toHaveBeenCalledWith(
        expect.objectContaining({
          fonts: expect.objectContaining({
            presetId: "high-legibility",
            slots: expect.objectContaining({
              cjk: { source: "google", catalogId: "noto-sans-tc" },
              latin: { source: "google", catalogId: "atkinson-hyperlegible-next" },
              numeric: { source: "google", catalogId: "atkinson-hyperlegible-mono" },
              monospace: { source: "google", catalogId: "atkinson-hyperlegible-mono" }
            })
          })
        })
      );
    });
  });

  it("downloads the fresh humanist preset once per distinct pack before applying", async () => {
    const installBrowserFont = vi.fn(async (catalogId: string) => ({
      catalogId,
      installed: true,
      cachedBytes: 1024
    }));
    window.rionStudio = {
      listBrowserFontCatalog: vi.fn(async () => catalog),
      installBrowserFont,
      removeBrowserFont: vi.fn(),
      getBrowserFontPreview: vi.fn(async (settings) => ({ settings, faces: [] }))
    } as unknown as RionStudioApi;
    const onGameBrowserSettingsChange = vi.fn(async (settings) => settings);

    renderSettings(onGameBrowserSettingsChange);

    fireEvent.click(screen.getByRole("button", { name: "Customize fonts" }));
    expect(await screen.findByText("Everyday presets")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Fresh humanist/u }));
    fireEvent.click(screen.getByRole("button", { name: "Download 4 and apply" }));

    await waitFor(() => expect(installBrowserFont).toHaveBeenCalledTimes(4));
    expect(installBrowserFont).toHaveBeenCalledWith("chocolate-classical-sans");
    expect(installBrowserFont).toHaveBeenCalledWith("lato");
    expect(installBrowserFont).toHaveBeenCalledWith("roboto-mono");
    expect(installBrowserFont).toHaveBeenCalledWith("noto-sans-math");
    await waitFor(() => {
      expect(onGameBrowserSettingsChange).toHaveBeenCalledWith(
        expect.objectContaining({
          fonts: expect.objectContaining({
            cjkVariant: "auto",
            mode: "custom",
            presetId: "fresh-humanist",
            slots: expect.objectContaining({
              cjk: { source: "google", catalogId: "chocolate-classical-sans" },
              latin: { source: "google", catalogId: "lato" },
              numeric: { source: "google", catalogId: "lato" },
              monospace: { source: "google", catalogId: "roboto-mono" },
              math: { source: "google", catalogId: "noto-sans-math" }
            })
          })
        })
      );
    });
  });

  it("downloads each distinct pack once for a personality preset before applying", async () => {
    const installBrowserFont = vi.fn(async (catalogId: string) => ({
      catalogId,
      installed: true,
      cachedBytes: 1024
    }));
    window.rionStudio = {
      listBrowserFontCatalog: vi.fn(async () => catalog),
      installBrowserFont,
      removeBrowserFont: vi.fn(),
      getBrowserFontPreview: vi.fn(async (settings) => ({ settings, faces: [] }))
    } as unknown as RionStudioApi;
    const onGameBrowserSettingsChange = vi.fn(async (settings) => settings);

    renderSettings(onGameBrowserSettingsChange);

    fireEvent.click(screen.getByRole("button", { name: "Customize fonts" }));
    expect(await screen.findByText("Distinctive styles")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Distinctive styles/u }));
    fireEvent.click(screen.getByRole("button", { name: /Friendly rounded/u }));
    fireEvent.click(screen.getByRole("button", { name: "Download 4 and apply" }));

    await waitFor(() => expect(installBrowserFont).toHaveBeenCalledTimes(4));
    expect(installBrowserFont).toHaveBeenCalledWith("chiron-go-round-tc");
    expect(installBrowserFont).toHaveBeenCalledWith("fredoka");
    expect(installBrowserFont).toHaveBeenCalledWith("jetbrains-mono");
    expect(installBrowserFont).toHaveBeenCalledWith("noto-sans-math");
    await waitFor(() => {
      expect(onGameBrowserSettingsChange).toHaveBeenCalledWith(
        expect.objectContaining({
          fonts: expect.objectContaining({
            cjkVariant: "auto",
            mode: "custom",
            presetId: "friendly-rounded",
            slots: expect.objectContaining({
              cjk: { source: "google", catalogId: "chiron-go-round-tc" },
              latin: { source: "google", catalogId: "fredoka" },
              numeric: { source: "google", catalogId: "fredoka" },
              monospace: { source: "google", catalogId: "jetbrains-mono" },
              math: { source: "google", catalogId: "noto-sans-math" }
            })
          })
        })
      );
    });
  });

  it("uses Pixelify Sans once for retro Latin text and numbers", async () => {
    const installBrowserFont = vi.fn(async (catalogId: string) => ({
      catalogId,
      installed: true,
      cachedBytes: 1024
    }));
    window.rionStudio = {
      listBrowserFontCatalog: vi.fn(async () => catalog),
      installBrowserFont,
      removeBrowserFont: vi.fn(),
      getBrowserFontPreview: vi.fn(async (settings) => ({ settings, faces: [] }))
    } as unknown as RionStudioApi;
    const onGameBrowserSettingsChange = vi.fn(async (settings) => settings);

    renderSettings(onGameBrowserSettingsChange);

    fireEvent.click(screen.getByRole("button", { name: "Customize fonts" }));
    expect(await screen.findByText("Distinctive styles")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Distinctive styles/u }));
    fireEvent.click(screen.getByRole("button", { name: /Retro game/u }));
    fireEvent.click(screen.getByRole("button", { name: "Download 4 and apply" }));

    await waitFor(() => expect(installBrowserFont).toHaveBeenCalledTimes(4));
    expect(installBrowserFont).toHaveBeenCalledWith("wdxl-lubrifont-tc");
    expect(installBrowserFont).toHaveBeenCalledWith("pixelify-sans");
    expect(installBrowserFont).toHaveBeenCalledWith("jetbrains-mono");
    expect(installBrowserFont).toHaveBeenCalledWith("noto-sans-math");
    expect(installBrowserFont).not.toHaveBeenCalledWith("press-start-2p");
    await waitFor(() => {
      expect(onGameBrowserSettingsChange).toHaveBeenCalledWith(
        expect.objectContaining({
          fonts: expect.objectContaining({
            cjkVariant: "auto",
            mode: "custom",
            presetId: "retro-game",
            slots: expect.objectContaining({
              cjk: { source: "google", catalogId: "wdxl-lubrifont-tc" },
              latin: { source: "google", catalogId: "pixelify-sans" },
              numeric: { source: "google", catalogId: "pixelify-sans" },
              monospace: { source: "google", catalogId: "jetbrains-mono" },
              math: { source: "google", catalogId: "noto-sans-math" }
            })
          })
        })
      );
    });
  });

  it("preserves a font-smoothing opt-out through preset application and system reset", async () => {
    const installBrowserFont = vi.fn(async (catalogId: string) => ({
      catalogId,
      installed: true,
      cachedBytes: 1024
    }));
    window.rionStudio = {
      listBrowserFontCatalog: vi.fn(async () => catalog),
      installBrowserFont,
      removeBrowserFont: vi.fn(),
      getBrowserFontPreview: vi.fn(async (settings) => ({ settings, faces: [] }))
    } as unknown as RionStudioApi;
    const onGameBrowserSettingsChange = vi.fn(async (settings) => settings);
    const optedOutSettings: GameBrowserSettings = {
      ...DEFAULT_GAME_BROWSER_SETTINGS,
      fonts: {
        ...DEFAULT_GAME_BROWSER_SETTINGS.fonts,
        fontSmoothingEnabled: false
      }
    };

    renderSettings(onGameBrowserSettingsChange, optedOutSettings);

    fireEvent.click(screen.getByRole("button", { name: "Customize fonts" }));
    expect(await screen.findByText("Handwriting styles")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Handwriting styles/u }));
    fireEvent.click(screen.getByRole("button", { name: /Natural handwriting/u }));
    fireEvent.click(screen.getByRole("button", { name: "Download 4 and apply" }));

    await waitFor(() => expect(onGameBrowserSettingsChange).toHaveBeenCalledTimes(1));
    expect(onGameBrowserSettingsChange.mock.calls[0][0].fonts.fontSmoothingEnabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Reset to system fonts" }));
    expect(onGameBrowserSettingsChange).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(onGameBrowserSettingsChange).toHaveBeenCalledTimes(2));
    expect(onGameBrowserSettingsChange.mock.calls[1][0].fonts).toEqual({
      ...DEFAULT_GAME_BROWSER_SETTINGS.fonts,
      fontSmoothingEnabled: false
    });
  });
});
