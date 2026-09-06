// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
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
  Object.defineProperties(HTMLElement.prototype, {
    hasPointerCapture: { configurable: true, value: () => false },
    releasePointerCapture: { configurable: true, value: () => undefined },
    scrollIntoView: { configurable: true, value: () => undefined },
    setPointerCapture: { configurable: true, value: () => undefined }
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
  onGameBrowserSettingsPatch: (patch: GameBrowserSettingsPatch) => Promise<GameBrowserSettings>,
  initialEntry = "/settings?section=preferences"
): void {
  document.documentElement.dataset.platform = platform;
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
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
  it.each(["mac", "windows"] as const)("removes the high refresh control on %s", (platform) => {
    const save = vi.fn(async () => DEFAULT_GAME_BROWSER_SETTINGS);
    renderSettings(platform, save, "/settings");
    expect(screen.getByRole("heading", { name: "Preferences" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Language" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Experimental high refresh rate" })).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it("keeps performance and Game Window behavior out of Interface settings", () => {
    renderSettings(
      "mac",
      async () => DEFAULT_GAME_BROWSER_SETTINGS,
      "/settings?section=interface"
    );

    expect(screen.getByRole("heading", { name: "Interface settings" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Customize fonts" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Experimental high refresh rate" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Restore Game Windows on startup" })).toBeNull();
  });
});
