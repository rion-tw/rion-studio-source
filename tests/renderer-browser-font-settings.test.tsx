// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";

import { ConfirmationProvider } from "../src/renderer/src/components/ConfirmationDialog";
import SettingsView from "../src/renderer/src/features/settings/SettingsRoute";
import en from "../src/renderer/src/i18n/en.json";
import type { Translator } from "../src/renderer/src/i18n";
import type { RionStudioApi } from "../src/shared/api";
import { DEFAULT_GAME_BROWSER_SETTINGS } from "../src/shared/browserFonts";
import { DEFAULT_MACRO_SETTINGS } from "../src/shared/macroSettings";
import type { BrowserFontCatalogEntry, GameBrowserSettings } from "../src/shared/types";

const t: Translator = (key) => en[key] ?? key;

const catalog: BrowserFontCatalogEntry[] = [
  ["iansui", "Iansui", "handwriting", ["tc", "latin"], "body"],
  ["patrick-hand", "Patrick Hand", "handwriting", ["latin"], "body"],
  ["caveat", "Caveat", "handwriting", ["latin"], "accent"],
  ["chiron-go-round-tc", "Chiron GoRound TC", "sans", ["tc", "latin"], "body"],
  ["fredoka", "Fredoka", "display", ["latin"], "body"],
  ["wdxl-lubrifont-tc", "WDXL Lubrifont TC", "display", ["tc", "latin"], "body"],
  ["pixelify-sans", "Pixelify Sans", "display", ["latin"], "body"],
  ["jetbrains-mono", "JetBrains Mono", "monospace", ["latin"], "technical"],
  ["noto-sans-math", "Noto Sans Math", "math", ["math", "latin"], "technical"]
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
});

afterEach(() => {
  cleanup();
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
          hasRunningRoles={false}
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

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(await screen.findByText("Distinctive styles")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Natural handwriting/u })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Handwriting styles/u }));
    expect(screen.getByRole("button", { name: /Natural handwriting/u })).toBeTruthy();

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Distinctive styles")).toBeNull();
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
    fireEvent.click(screen.getByRole("button", { name: "Download 5 and apply" }));

    await waitFor(() => expect(installBrowserFont).toHaveBeenCalledTimes(5));
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
              numeric: { source: "google", catalogId: "caveat" }
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
    fireEvent.click(screen.getByRole("button", { name: "Download 5 and apply" }));

    await waitFor(() => expect(onGameBrowserSettingsChange).toHaveBeenCalledTimes(1));
    expect(onGameBrowserSettingsChange.mock.calls[0][0].fonts.fontSmoothingEnabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Reset to system fonts" }));
    await waitFor(() => expect(onGameBrowserSettingsChange).toHaveBeenCalledTimes(2));
    expect(onGameBrowserSettingsChange.mock.calls[1][0].fonts).toEqual({
      ...DEFAULT_GAME_BROWSER_SETTINGS.fonts,
      fontSmoothingEnabled: false
    });
  });
});
