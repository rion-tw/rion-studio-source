// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfirmationProvider } from "../src/renderer/src/components/ConfirmationDialog";
import SettingsView from "../src/renderer/src/features/settings/SettingsRoute";
import type { Translator } from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/en.json";
import { DEFAULT_GAME_BROWSER_SETTINGS } from "../src/shared/browserFonts";
import { DEFAULT_MACRO_SETTINGS } from "../src/shared/macroSettings";
import type { AppUpdateStatus } from "../src/shared/types";

const t: Translator = (key) => en[key] ?? key;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("update settings", () => {
  it("preserves a downloaded update by disabling another check", () => {
    renderSettings({
      autoUpdateEnabled: true,
      availableVersion: "2.0.0",
      currentVersion: "1.0.0",
      installMode: "automatic",
      isPackaged: true,
      state: "downloaded"
    });

    expect((screen.getByRole("button", { name: "Check updates" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Restart and update" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("allows a manual check while the updater is idle", () => {
    renderSettings({
      autoUpdateEnabled: true,
      currentVersion: "1.0.0",
      installMode: "automatic",
      isPackaged: true,
      state: "idle"
    });

    expect((screen.getByRole("button", { name: "Check updates" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Restart and update" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

function renderSettings(updateStatus: AppUpdateStatus): void {
  render(
    <MemoryRouter initialEntries={["/settings?section=updates"]}>
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
          onInstallDownloadedUpdate={async () => undefined}
          onLanguageChange={() => undefined}
          onLoadSystemFonts={async () => []}
          onMacroSettingsChange={async (settings) => settings}
          onOpenUpdateDownload={async () => undefined}
          onPreviewPortableImport={async () => null}
          onRuntimeWindowPreferencesChange={async (preferences) => preferences}
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
          runtimeWindowPreferences={{
            alwaysHideTabCloseButton: false,
            alwaysShowToolbarInFullScreen: false,
            restoreGameWindowsOnStartup: true
          }}
          systemFonts={[]}
          t={t}
          themeMode="system"
          updateStatus={updateStatus}
          updateVersion="1.0.0"
        />
      </ConfirmationProvider>
    </MemoryRouter>
  );
}
