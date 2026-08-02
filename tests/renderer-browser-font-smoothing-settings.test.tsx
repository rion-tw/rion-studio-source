// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";

import { ConfirmationProvider } from "../src/renderer/src/components/ConfirmationDialog";
import SettingsView from "../src/renderer/src/features/settings/SettingsRoute";
import en from "../src/renderer/src/i18n/en.json";
import type { Translator } from "../src/renderer/src/i18n";
import { DEFAULT_GAME_BROWSER_SETTINGS } from "../src/shared/browserFonts";
import { DEFAULT_MACRO_SETTINGS } from "../src/shared/macroSettings";
import type { GameBrowserSettings } from "../src/shared/types";

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
  onGameBrowserSettingsChange: (settings: GameBrowserSettings) => Promise<GameBrowserSettings>,
  onError = vi.fn()
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
          onError={onError}
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

describe("browser font smoothing settings", () => {
  it.each(["mac", "windows"] as const)(
    "shows the enabled default and immediately persists opt-out on %s",
    async (platform) => {
      const onGameBrowserSettingsChange = vi.fn(async (settings) => settings);
      renderSettings(platform, onGameBrowserSettingsChange);

      const gameFontsSection = screen.getByRole("heading", { name: "Game fonts" }).parentElement;
      expect(gameFontsSection).not.toBeNull();
      expect(gameFontsSection?.contains(screen.getByRole("switch", { name: "Font smoothing" }))).toBe(true);
      expect(gameFontsSection?.contains(screen.getByRole("button", { name: "Customize fonts" }))).toBe(true);
      expect(
        gameFontsSection?.contains(screen.getByRole("combobox", { name: "Chinese and Japanese glyph style" }))
      ).toBe(true);
      expect(screen.queryByRole("heading", { name: "Game" })).toBeNull();

      const toggle = screen.getByRole("switch", { name: "Font smoothing" });
      expect(toggle.getAttribute("data-state")).toBe("checked");
      fireEvent.click(toggle);

      await waitFor(() => {
        expect(onGameBrowserSettingsChange).toHaveBeenCalledWith({
          ...DEFAULT_GAME_BROWSER_SETTINGS,
          fonts: {
            ...DEFAULT_GAME_BROWSER_SETTINGS.fonts,
            fontSmoothingEnabled: false
          }
        });
      });
    }
  );

  it("reports a failed immediate save and leaves the controlled value enabled", async () => {
    const error = new Error("save failed");
    const onError = vi.fn();
    renderSettings("windows", vi.fn(async () => Promise.reject(error)), onError);

    const toggle = screen.getByRole("switch", { name: "Font smoothing" });
    fireEvent.click(toggle);

    await waitFor(() => expect(onError).toHaveBeenCalledWith(error));
    expect(toggle.getAttribute("data-state")).toBe("checked");
  });
});
