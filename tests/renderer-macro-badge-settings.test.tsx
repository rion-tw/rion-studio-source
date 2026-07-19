// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";

import { ConfirmationProvider } from "../src/renderer/src/components/ConfirmationDialog";
import SettingsView from "../src/renderer/src/features/settings/SettingsRoute";
import en from "../src/renderer/src/i18n/en.json";
import { DEFAULT_GAME_BROWSER_SETTINGS } from "../src/shared/browserFonts";
import { DEFAULT_MACRO_SETTINGS } from "../src/shared/macroSettings";
import type { Translator } from "../src/renderer/src/i18n";

const t: Translator = (key) => en[key] ?? key;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("macro badge interface settings", () => {
  it("renders position controls and saves the selected alignment", async () => {
    const onGameBrowserSettingsChange = vi.fn(async (settings) => settings);

    render(
      <MemoryRouter initialEntries={["/settings?section=interface"]}>
        <ConfirmationProvider>
          <SettingsView
            gameBrowserSettings={DEFAULT_GAME_BROWSER_SETTINGS}
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
            onGameBrowserSettingsChange={onGameBrowserSettingsChange}
            onInstallDownloadedUpdate={async () => undefined}
            onLanguageChange={() => undefined}
            onLoadGraphicsDiagnostics={async () => {
              throw new Error("not used");
            }}
            onLoadSystemFonts={async () => []}
            onMacroSettingsChange={async (settings) => settings}
            onOpenUpdateDownload={async () => undefined}
            onPreviewPortableImport={async () => null}
            onRestartApplication={async () => undefined}
            onThemeModeChange={() => undefined}
            resolvedTheme="light"
            systemFonts={[]}
            t={t}
            themeMode="system"
            updateStatus={null}
            updateVersion=""
            isUpdateBusy={false}
            portableDataCounts={{ gameCount: 0, macroCount: 0, roleCount: 0, workspaceCount: 0 }}
          />
        </ConfirmationProvider>
      </MemoryRouter>
    );

    expect(screen.getByText("Macro badges")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Left" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Center" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("combobox", { name: "Distance from top" }).textContent).toContain("20%");
    expect(screen.getByRole("combobox", { name: "Horizontal margin" }).textContent).toContain("0%");

    fireEvent.click(screen.getByRole("button", { name: "Right" }));

    await waitFor(() => {
      expect(onGameBrowserSettingsChange).toHaveBeenCalledWith({
        ...DEFAULT_GAME_BROWSER_SETTINGS,
        macroBadgePosition: {
          horizontalAlign: "right",
          horizontalMarginPercent: 0,
          topPercent: 20
        }
      });
    });
  });
});
