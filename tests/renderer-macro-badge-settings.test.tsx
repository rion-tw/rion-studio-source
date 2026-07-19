// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";

import { ConfirmationProvider } from "../src/renderer/src/components/ConfirmationDialog";
import SettingsView from "../src/renderer/src/features/settings/SettingsRoute";
import en from "../src/renderer/src/i18n/en.json";
import { DEFAULT_GAME_BROWSER_SETTINGS } from "../src/shared/browserFonts";
import { DEFAULT_MACRO_SETTINGS } from "../src/shared/macroSettings";
import type { Translator } from "../src/renderer/src/i18n";

const t: Translator = (key) => en[key] ?? key;

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class ResizeObserver {
    disconnect(): void {}
    observe(): void {}
    unobserve(): void {}
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("macro badge interface settings", () => {
  it("renders shadcn sliders and saves the latest position after the debounce", async () => {
    vi.useFakeTimers();
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

    expect(screen.getByRole("button", { name: "Customize fonts" })).toBeTruthy();
    expect(screen.getByText("Macro badges")).toBeTruthy();
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

    expect(onGameBrowserSettingsChange).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);

    expect(onGameBrowserSettingsChange).toHaveBeenCalledWith({
      ...DEFAULT_GAME_BROWSER_SETTINGS,
      macroBadgePosition: {
        horizontalAlign: "right",
        horizontalMarginPx: 8,
        topPx: 136
      }
    });
  });
});
