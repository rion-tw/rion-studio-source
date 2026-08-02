// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";

import { ConfirmationProvider } from "../src/renderer/src/components/ConfirmationDialog";
import SettingsView from "../src/renderer/src/features/settings/SettingsRoute";
import en from "../src/renderer/src/i18n/en.json";
import { DEFAULT_GAME_BROWSER_SETTINGS } from "../src/shared/browserFonts";
import { DEFAULT_MACRO_SETTINGS } from "../src/shared/macroSettings";
import type { Translator } from "../src/renderer/src/i18n";
import type { GameBrowserSettings, GameBrowserSettingsPatch } from "../src/shared/types";

const t: Translator = (key) => en[key] ?? key;

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class ResizeObserver {
    disconnect(): void {}
    observe(): void {}
    unobserve(): void {}
  });
});

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.platform;
  vi.restoreAllMocks();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

function renderSettings(
  platform: "mac" | "windows",
  onGameBrowserSettingsPatch: (patch: GameBrowserSettingsPatch) => Promise<GameBrowserSettings>
): void {
  document.documentElement.dataset.platform = platform;
  render(
    <MemoryRouter initialEntries={["/settings?section=interface"]}>
      <ConfirmationProvider>
        <SettingsView
          gameBrowserSettings={DEFAULT_GAME_BROWSER_SETTINGS}
          language="en"
          macroSettings={DEFAULT_MACRO_SETTINGS}
          onApplyPortableImport={async () => {
            throw new Error("not used");
          }}
          onCheckForUpdates={async () => undefined}
          onDiscardPortableImport={async () => undefined}
          onError={vi.fn()}
          onExportPortableData={async () => null}
          onGameBrowserSettingsChange={async (settings) => settings}
          onGameBrowserSettingsPatch={onGameBrowserSettingsPatch}
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
          systemFonts={[]}
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

describe("browser performance settings", () => {
  it("shows and persists the experimental high refresh preference on macOS", async () => {
    const onGameBrowserSettingsPatch = vi.fn(async () => ({
      ...DEFAULT_GAME_BROWSER_SETTINGS,
      performance: { macosHighRefreshRate: true }
    }));
    renderSettings("mac", onGameBrowserSettingsPatch);

    const languageRow = screen.getByRole("combobox", { name: "Language" }).closest(".settings-row");
    const highRefreshSwitch = screen.getByRole("switch", { name: "Experimental high refresh rate" });
    const highRefreshRow = highRefreshSwitch.closest(".settings-row");
    expect(languageRow?.nextElementSibling).toBe(highRefreshRow);
    expect(screen.queryByRole("heading", { name: "Game" })).toBeNull();

    expect(
      screen.getByText(/Requires restarting Rion Studio and may increase energy use and temperature/u)
    ).toBeTruthy();
    fireEvent.click(highRefreshSwitch);

    await waitFor(() => {
      expect(onGameBrowserSettingsPatch).toHaveBeenCalledWith({
        performance: { macosHighRefreshRate: true }
      });
    });
  });

  it("does not expose the macOS-only control on Windows", () => {
    renderSettings("windows", async () => DEFAULT_GAME_BROWSER_SETTINGS);

    expect(
      screen.queryByRole("switch", { name: "Experimental high refresh rate" })
    ).toBeNull();
  });
});
