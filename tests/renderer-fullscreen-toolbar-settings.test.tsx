// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";

import { ConfirmationProvider } from "../src/renderer/src/components/ConfirmationDialog";
import SettingsView from "../src/renderer/src/features/settings/SettingsRoute";
import type { Translator } from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/en.json";
import ja from "../src/renderer/src/i18n/ja.json";
import zhCN from "../src/renderer/src/i18n/zh-CN.json";
import zhTW from "../src/renderer/src/i18n/zh-TW.json";
import { DEFAULT_GAME_BROWSER_SETTINGS } from "../src/shared/browserFonts";
import { DEFAULT_MACRO_SETTINGS } from "../src/shared/macroSettings";
import type { RuntimeWindowPreferences } from "../src/shared/types";

const t: Translator = (key) => en[key] ?? key;
const preferences: RuntimeWindowPreferences = {
  alwaysHideTabCloseButton: false,
  alwaysShowToolbarInFullScreen: false,
  restoreGameWindowsOnStartup: true
};

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

afterAll(() => vi.unstubAllGlobals());

describe("fullscreen toolbar settings", () => {
  it("persists the existing preference without changing adjacent fields", async () => {
    let resolveSave = (_value: RuntimeWindowPreferences): void => undefined;
    const saving = new Promise<RuntimeWindowPreferences>((resolve) => {
      resolveSave = resolve;
    });
    const onRuntimeWindowPreferencesChange = vi.fn(() => saving);
    renderSettings(onRuntimeWindowPreferencesChange);

    const control = screen.getByRole("switch", {
      name: "Always show the toolbar in full screen"
    });
    fireEvent.click(control);

    expect(onRuntimeWindowPreferencesChange).toHaveBeenCalledWith({
      ...preferences,
      alwaysShowToolbarInFullScreen: true
    });
    expect((control as HTMLButtonElement).disabled).toBe(true);

    resolveSave({ ...preferences, alwaysShowToolbarInFullScreen: true });
    await waitFor(() => expect((control as HTMLButtonElement).disabled).toBe(false));
  });

  it("provides the label and description in every supported language", () => {
    for (const dictionary of [en, zhTW, zhCN, ja]) {
      expect(dictionary["settings.alwaysShowToolbarInFullScreen"]).toBeTruthy();
      expect(dictionary["settings.alwaysShowToolbarInFullScreenDescription"]).toBeTruthy();
    }
  });
});

function renderSettings(
  onRuntimeWindowPreferencesChange: (
    value: RuntimeWindowPreferences
  ) => Promise<RuntimeWindowPreferences>
): void {
  document.documentElement.dataset.platform = "windows";
  render(
    <MemoryRouter initialEntries={["/settings?section=interface"]}>
      <ConfirmationProvider>
        <SettingsView
          gameBrowserSettings={DEFAULT_GAME_BROWSER_SETTINGS}
          isUpdateBusy={false}
          language="en"
          macroSettings={DEFAULT_MACRO_SETTINGS}
          onApplyPortableImport={async () => { throw new Error("not used"); }}
          onCheckForUpdates={async () => undefined}
          onDiscardPortableImport={async () => undefined}
          onError={vi.fn()}
          onExportPortableData={async () => null}
          onGameBrowserSettingsChange={async (settings) => settings}
          onGameBrowserSettingsPatch={async () => DEFAULT_GAME_BROWSER_SETTINGS}
          onInstallDownloadedUpdate={async () => undefined}
          onLanguageChange={() => undefined}
          onLoadSystemFonts={async () => []}
          onMacroSettingsChange={async (settings) => settings}
          onOpenUpdateDownload={async () => undefined}
          onPreviewPortableImport={async () => null}
          onRuntimeWindowPreferencesChange={onRuntimeWindowPreferencesChange}
          onSetAutoUpdateEnabled={async () => undefined}
          onThemeModeChange={() => undefined}
          portableDataCounts={{
            gameCount: 0,
            gameWindowCount: 0,
            macroCount: 0,
            roleCount: 0,
            workspaceCount: 0
          }}
          resolvedTheme="light"
          runtimeWindowPreferences={preferences}
          systemFonts={[]}
          t={t}
          themeMode="system"
          updateStatus={null}
          updateVersion=""
        />
      </ConfirmationProvider>
    </MemoryRouter>
  );
}
