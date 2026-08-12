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
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("in-game macro interface settings", () => {
  it("renders shadcn sliders and saves the latest position after the debounce", async () => {
    vi.useFakeTimers();
    const onGameBrowserSettingsPatch = vi.fn(async () => DEFAULT_GAME_BROWSER_SETTINGS);
    renderSettings(DEFAULT_GAME_BROWSER_SETTINGS, onGameBrowserSettingsPatch);

    expect(screen.getByRole("button", { name: "Customize fonts" })).toBeTruthy();
    expect(screen.getByText("In-game macro interface")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Show macro tools button" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("switch", { name: "Show running macro badges" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("switch", { name: "Show macro click markers" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("button", { name: "Left" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Center" }).getAttribute("aria-pressed")).toBe("true");
    const topSlider = screen.getByRole("slider", { name: "Distance from top" });
    const horizontalMarginSlider = screen.getByRole("slider", { name: "Horizontal margin" });
    expect(topSlider.getAttribute("aria-valuemin")).toBe("0");
    expect(topSlider.getAttribute("aria-valuemax")).toBe("320");
    expect(topSlider.getAttribute("aria-valuenow")).toBe("128");
    expect(horizontalMarginSlider.getAttribute("aria-valuemin")).toBe("0");
    expect(horizontalMarginSlider.getAttribute("aria-valuemax")).toBe("128");
    expect(horizontalMarginSlider.getAttribute("aria-valuenow")).toBe("8");
    expect(screen.getByText("128 px")).toBeTruthy();
    expect(screen.getByText("8 px")).toBeTruthy();

    fireEvent.keyDown(topSlider, { key: "ArrowRight" });
    expect(topSlider.getAttribute("aria-valuenow")).toBe("136");

    fireEvent.click(screen.getByRole("button", { name: "Right" }));

    expect(onGameBrowserSettingsPatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);

    expect(onGameBrowserSettingsPatch).toHaveBeenCalledWith({
      macroBadgePosition: {
        horizontalAlign: "right",
        horizontalMarginPx: 8,
        topPx: 136
      }
    });
  });

  it("saves visibility fields independently and rolls back a failed change", async () => {
    const onError = vi.fn();
    const hiddenToolSettings: GameBrowserSettings = {
      ...DEFAULT_GAME_BROWSER_SETTINGS,
      macroOverlay: { ...DEFAULT_GAME_BROWSER_SETTINGS.macroOverlay, showToolButton: false }
    };
    let resolveToolSave: (settings: GameBrowserSettings) => void = () => undefined;
    let rejectMarkerSave: (error: Error) => void = () => undefined;
    const toolSave = new Promise<GameBrowserSettings>((resolve) => {
      resolveToolSave = resolve;
    });
    const markerSave = new Promise<GameBrowserSettings>((_resolve, reject) => {
      rejectMarkerSave = reject;
    });
    const onSave = vi.fn()
      .mockReturnValueOnce(toolSave)
      .mockReturnValueOnce(markerSave);
    renderSettings(DEFAULT_GAME_BROWSER_SETTINGS, onSave, onError);

    fireEvent.click(screen.getByRole("switch", { name: "Show macro tools button" }));
    fireEvent.click(screen.getByRole("switch", { name: "Show macro click markers" }));
    expect(onSave).toHaveBeenNthCalledWith(1, {
      macroOverlay: { showToolButton: false }
    });
    expect(onSave).toHaveBeenNthCalledWith(2, {
      macroOverlay: { showClickMarkers: false }
    });
    expect(screen.getByRole("switch", { name: "Show macro tools button" }).getAttribute("aria-checked")).toBe("false");
    expect(screen.getByRole("switch", { name: "Show macro click markers" }).getAttribute("aria-checked")).toBe("false");

    resolveToolSave(hiddenToolSettings);
    rejectMarkerSave(new Error("save failed"));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Show macro tools button" }).getAttribute("aria-checked")).toBe("false"));
    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "save failed" })));
    expect(screen.getByRole("switch", { name: "Show macro click markers" }).getAttribute("aria-checked")).toBe("true");
  });

  it("keeps badge position values but disables their controls while badges are hidden", () => {
    renderSettings({
      ...DEFAULT_GAME_BROWSER_SETTINGS,
      macroBadgePosition: { horizontalAlign: "right", horizontalMarginPx: 24, topPx: 216 },
      macroOverlay: { ...DEFAULT_GAME_BROWSER_SETTINGS.macroOverlay, showRunningBadges: false }
    }, vi.fn(async () => DEFAULT_GAME_BROWSER_SETTINGS));

    expect(screen.getByRole("button", { name: "Right" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Right" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("slider", { name: "Distance from top" }).getAttribute("aria-valuenow")).toBe("216");
    expect(screen.getByRole("slider", { name: "Distance from top" }).hasAttribute("data-disabled")).toBe(true);
    expect(screen.getByRole("slider", { name: "Horizontal margin" }).getAttribute("aria-valuenow")).toBe("24");
    expect(screen.getByRole("slider", { name: "Horizontal margin" }).hasAttribute("data-disabled")).toBe(true);
  });
});

function renderSettings(
  settings: GameBrowserSettings,
  onGameBrowserSettingsPatch: (patch: GameBrowserSettingsPatch) => Promise<GameBrowserSettings>,
  onError = vi.fn()
): void {
  render(
    <MemoryRouter initialEntries={["/settings?section=interface"]}>
      <ConfirmationProvider>
        <SettingsView
          gameBrowserSettings={settings}
          language="en"
          macroSettings={DEFAULT_MACRO_SETTINGS}
          onApplyPortableImport={async () => { throw new Error("not used"); }}
          onCheckForUpdates={async () => undefined}
          onDiscardPortableImport={async () => undefined}
          onError={onError}
          onExportPortableData={async () => null}
          onGameBrowserSettingsChange={async (value) => value}
          onGameBrowserSettingsPatch={onGameBrowserSettingsPatch}
          onInstallDownloadedUpdate={async () => undefined}
          onSetAutoUpdateEnabled={async () => undefined}
          onLanguageChange={() => undefined}
          onLoadSystemFonts={async () => []}
          onMacroSettingsChange={async (value) => value}
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
          portableDataCounts={{ gameCount: 0, gameWindowCount: 0, macroCount: 0, roleCount: 0, workspaceCount: 0 }}
        />
      </ConfirmationProvider>
    </MemoryRouter>
  );
}
