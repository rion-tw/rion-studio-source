// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";

import { ConfirmationProvider } from "../src/renderer/src/components/ConfirmationDialog";
import SettingsView from "../src/renderer/src/features/settings/SettingsRoute";
import en from "../src/renderer/src/i18n/en.json";
import type { Translator } from "../src/renderer/src/i18n";
import { DEFAULT_GAME_BROWSER_SETTINGS } from "../src/shared/browserFonts";
import { DEFAULT_MACRO_SETTINGS } from "../src/shared/macroSettings";
import type { Game } from "../src/shared/types";

const t: Translator = (key) => en[key] ?? key;
const game: Game = {
  id: "game-1",
  source: "custom",
  name: "Example game",
  defaultLaunchUrl: "https://example.test/play",
  browserLaunchMode: "inherit",
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z"
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Chrome profile import settings entry", () => {
  it("opens the shared import flow from Settings > Data", () => {
    const onOpenChromeProfileImport = vi.fn();

    render(
      <MemoryRouter initialEntries={["/settings?section=data"]}>
        <ConfirmationProvider>
          <SettingsView
            gameBrowserSettings={DEFAULT_GAME_BROWSER_SETTINGS}
            games={[game]}
            hasRunningRoles={false}
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
            onInstallDownloadedUpdate={async () => undefined}
            onLanguageChange={() => undefined}
            onLoadGraphicsDiagnostics={async () => {
              throw new Error("not used");
            }}
            onLoadSystemFonts={async () => []}
            onMacroSettingsChange={async (settings) => settings}
            onRuntimeWindowPreferencesChange={async (preferences) => preferences}
            onOpenChromeProfileImport={onOpenChromeProfileImport}
            onOpenUpdateDownload={async () => undefined}
            onPreviewPortableImport={async () => null}
            onRestartApplication={async () => undefined}
            onThemeModeChange={() => undefined}
            resolvedTheme="light"
            runtimeWindowPreferences={{
              alwaysShowToolbarInFullScreen: false,
              restoreGameWindowsOnStartup: true
            }}
            systemFonts={[]}
            t={t}
            themeMode="system"
            updateStatus={null}
            updateVersion=""
            isUpdateBusy={false}
            portableDataCounts={{ gameCount: 1, macroCount: 0, roleCount: 0, workspaceCount: 0 }}
          />
        </ConfirmationProvider>
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole("button", { name: "Import Chrome profiles" }));
    expect(onOpenChromeProfileImport).toHaveBeenCalledOnce();
  });
});
