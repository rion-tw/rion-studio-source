// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";

import { ConfirmationProvider } from "../src/renderer/src/components/ConfirmationDialog";
import SettingsView from "../src/renderer/src/features/settings/SettingsRoute";
import type { Translator } from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/en.json";
import { DEFAULT_GAME_BROWSER_SETTINGS } from "../src/shared/browserFonts";
import { DEFAULT_MACRO_SETTINGS } from "../src/shared/macroSettings";
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
  vi.restoreAllMocks();
});

afterAll(() => vi.unstubAllGlobals());

describe("workspace appearance settings", () => {
  it("sends a complete workspace patch and disables both controls until Core confirms it", async () => {
    let resolveSave = (_settings: GameBrowserSettings): void => undefined;
    const save = new Promise<GameBrowserSettings>((resolve) => {
      resolveSave = resolve;
    });
    const onPatch = vi.fn(() => save);
    renderSettings(onPatch);
    const user = userEvent.setup();

    const gap = screen.getByRole("combobox", { name: "Workspace gap" });
    await user.click(gap);
    await user.click(screen.getByRole("option", { name: "16 px" }));

    expect(onPatch).toHaveBeenCalledWith({
      workspace: { background: "material", gap: 16 }
    });
    expect((gap as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Transparent material" }) as HTMLButtonElement).disabled)
      .toBe(true);

    resolveSave({
      ...DEFAULT_GAME_BROWSER_SETTINGS,
      workspace: { background: "material", gap: 16 }
    });
    await waitFor(() => expect((gap as HTMLButtonElement).disabled).toBe(false));
  });

  it("reports a failed projection and keeps the prior confirmed gap", async () => {
    const error = new Error("native projection failed");
    const onError = vi.fn();
    renderSettings(vi.fn(async () => Promise.reject(error)), onError);
    const user = userEvent.setup();

    const gap = screen.getByRole("combobox", { name: "Workspace gap" });
    await user.click(gap);
    await user.click(screen.getByRole("option", { name: "16 px" }));

    await waitFor(() => expect(onError).toHaveBeenCalledWith(error));
    expect(gap.textContent).toContain("4 px");
    expect((gap as HTMLButtonElement).disabled).toBe(false);
  });
});

function renderSettings(
  onGameBrowserSettingsPatch: (
    patch: GameBrowserSettingsPatch
  ) => Promise<GameBrowserSettings>,
  onError = vi.fn()
): void {
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
          onError={onError}
          onExportPortableData={async () => null}
          onGameBrowserSettingsChange={async (settings) => settings}
          onGameBrowserSettingsPatch={onGameBrowserSettingsPatch}
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
          updateStatus={null}
          updateVersion=""
        />
      </ConfirmationProvider>
    </MemoryRouter>
  );
}
