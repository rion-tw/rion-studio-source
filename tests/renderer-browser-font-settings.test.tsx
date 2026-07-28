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
  onGameBrowserSettingsChange: (settings: GameBrowserSettings) => Promise<GameBrowserSettings>
): void {
  render(
    <MemoryRouter initialEntries={["/settings?section=interface"]}>
      <ConfirmationProvider>
        <SettingsView
          gameBrowserSettings={DEFAULT_GAME_BROWSER_SETTINGS}
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

    expect(await screen.findByText("Handwriting styles")).toBeTruthy();
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
});
