// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";

import { ConfirmationProvider } from "../src/renderer/src/components/ConfirmationDialog";
import SettingsView from "../src/renderer/src/features/settings/SettingsRoute";
import en from "../src/renderer/src/i18n/en.json";
import type { Translator } from "../src/renderer/src/i18n";
import { DEFAULT_GAME_BROWSER_SETTINGS } from "../src/shared/browserFonts";
import { DEFAULT_MACRO_SETTINGS } from "../src/shared/macroSettings";
import type { GameBrowserSettings, GraphicsDiagnostics } from "../src/shared/types";

const t: Translator = (key) => en[key] ?? key;

afterEach(cleanup);

function createDiagnostics(): GraphicsDiagnostics {
  return {
    appliedSettings: DEFAULT_GAME_BROWSER_SETTINGS.graphics,
    appliedSwitches: [
      "--force-high-performance-gpu",
      "--enable-gpu-rasterization",
      "--ignore-gpu-blocklist",
      "--enable-unsafe-webgpu",
      "--disable-frame-rate-limit",
      "--disable-gpu-vsync"
    ],
    collectedAt: "2026-07-23T00:00:00.000Z",
    embedded: { webgl: "available", webgl2: "available", webgpu: "available" },
    externalRoles: [],
    featureStatus: {},
    gpuInfoReady: true,
    hardwareAccelerationEnabled: true,
    platform: "win32",
    restartRequired: false,
    savedSettings: DEFAULT_GAME_BROWSER_SETTINGS.graphics,
    versions: { chromium: "1", electron: "1", node: "1" }
  };
}

function renderGameSettings(
  onGameBrowserSettingsChange: (settings: GameBrowserSettings) => Promise<GameBrowserSettings>
): void {
  render(
    <MemoryRouter initialEntries={["/settings?section=game"]}>
      <ConfirmationProvider>
        <SettingsView
          gameBrowserSettings={DEFAULT_GAME_BROWSER_SETTINGS}
          hasRunningRoles={false}
          language="en"
          macroSettings={DEFAULT_MACRO_SETTINGS}
          onApplyPortableImport={async () => { throw new Error("not used"); }}
          onCheckForUpdates={async () => undefined}
          onDiscardPortableImport={async () => undefined}
          onError={vi.fn()}
          onExportPortableData={async () => null}
          onGameBrowserSettingsChange={onGameBrowserSettingsChange}
          onInstallDownloadedUpdate={async () => undefined}
          onLanguageChange={() => undefined}
          onLoadGraphicsDiagnostics={async () => createDiagnostics()}
          onLoadSystemFonts={async () => []}
          onMacroSettingsChange={async (settings) => settings}
          onOpenUpdateDownload={async () => undefined}
          onPreviewPortableImport={async () => null}
          onRestartApplication={async () => undefined}
          onThemeModeChange={() => undefined}
          portableDataCounts={{ gameCount: 0, macroCount: 0, roleCount: 0, workspaceCount: 0 }}
          resolvedTheme="light"
          systemFonts={[]}
          t={t}
          themeMode="system"
          updateStatus={null}
          updateVersion=""
          isUpdateBusy={false}
        />
      </ConfirmationProvider>
    </MemoryRouter>
  );
}

describe("flattened graphics settings", () => {
  it("shows independent aggressive defaults and keeps background throttling fixed", async () => {
    renderGameSettings(async (settings) => settings);

    expect(
      screen.getByRole("switch", { name: "Prefer high-performance GPU" }).getAttribute("data-state")
    ).toBe("checked");
    expect(
      screen.getByRole("switch", { name: "Force GPU rasterization" }).getAttribute("data-state")
    ).toBe("checked");
    expect(
      screen.getByRole("switch", { name: "Frame-rate limiter" }).getAttribute("data-state")
    ).toBe("unchecked");
    expect((screen.getByRole("switch", { name: "VSync" }) as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByText("Fixed on: occluded windows and hidden tabs continue using Chromium/Electron resource throttling.")
    ).toBeTruthy();
    expect(await screen.findByRole("combobox", { name: "Graphics API backend" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Graphics acceleration" })).toBeNull();
  });

  it("saves one flattened field without opening a restart confirmation", async () => {
    const onGameBrowserSettingsChange = vi.fn(async (settings: GameBrowserSettings) => settings);
    renderGameSettings(onGameBrowserSettingsChange);

    const toggle = screen.getByRole("switch", { name: "Prefer high-performance GPU" }) as HTMLButtonElement;
    await waitFor(() => expect(toggle.disabled).toBe(false));
    fireEvent.click(toggle);

    await waitFor(() => expect(onGameBrowserSettingsChange).toHaveBeenCalledOnce());
    expect(onGameBrowserSettingsChange.mock.calls[0][0].graphics).toMatchObject({
      preferHighPerformanceGpu: false,
      forceGpuRasterization: true,
      frameRateLimitEnabled: false,
      vsyncEnabled: false
    });
    expect(screen.queryByText("Restart required")).toBeNull();
  });
});
