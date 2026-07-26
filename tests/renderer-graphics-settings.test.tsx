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
import type {
  GameBrowserSettings,
  GraphicsDiagnostics,
  RoleStatus,
  RuntimeWindowPreferences
} from "../src/shared/types";

const t: Translator = (key) => en[key] ?? key;

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class ResizeObserver {
    disconnect(): void {}
    observe(): void {}
    unobserve(): void {}
  });
});

afterEach(cleanup);

afterAll(() => {
  vi.unstubAllGlobals();
});

function createDiagnostics(platform: GraphicsDiagnostics["platform"] = "win32"): GraphicsDiagnostics {
  return {
    appliedSettings: DEFAULT_GAME_BROWSER_SETTINGS.graphics,
    appliedSwitches: ["--force-high-performance-gpu"],
    collectedAt: "2026-07-23T00:00:00.000Z",
    embedded: { webgl: "available", webgl2: "available", webgpu: "available" },
    featureStatus: {},
    gpuInfoReady: true,
    hardwareAccelerationEnabled: true,
    platform,
    restartRequired: false,
    savedSettings: DEFAULT_GAME_BROWSER_SETTINGS.graphics,
    versions: {
      engine: "wkwebview",
      engineVersion: "14.6",
      shell: "tauri",
      shellVersion: "2.11"
    }
  };
}

function renderGameSettings(
  onGameBrowserSettingsChange: (settings: GameBrowserSettings) => Promise<GameBrowserSettings>,
  platform: GraphicsDiagnostics["platform"] = "win32",
  gameBrowserSettings: GameBrowserSettings = DEFAULT_GAME_BROWSER_SETTINGS,
  options: {
    initialEntry?: string;
    roleStatuses?: RoleStatus[];
    onRuntimeWindowPreferencesChange?: (
      preferences: RuntimeWindowPreferences
    ) => Promise<RuntimeWindowPreferences>;
  } = {}
): void {
  render(
    <MemoryRouter initialEntries={[options.initialEntry ?? "/settings?section=game"]}>
      <ConfirmationProvider>
        <SettingsView
          gameBrowserSettings={gameBrowserSettings}
          hasRunningRoles={false}
          roleStatuses={options.roleStatuses}
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
          onLoadGraphicsDiagnostics={async () => createDiagnostics(platform)}
          onLoadSystemFonts={async () => []}
          onMacroSettingsChange={async (settings) => settings}
          onRuntimeWindowPreferencesChange={
            options.onRuntimeWindowPreferencesChange ??
            (async (preferences) => preferences)
          }
          onOpenUpdateDownload={async () => undefined}
          onSetAutoUpdateEnabled={async () => undefined}
          onPreviewPortableImport={async () => null}
          onRestartApplication={async () => undefined}
          onThemeModeChange={() => undefined}
          portableDataCounts={{ gameCount: 0, macroCount: 0, roleCount: 0, workspaceCount: 0 }}
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
        />
      </ConfirmationProvider>
    </MemoryRouter>
  );
}

describe("flattened graphics settings", () => {
  it("shows balanced game defaults and keeps background throttling fixed", async () => {
    renderGameSettings(async (settings) => settings);

    expect(
      screen.getByRole("switch", { name: "Prefer high-performance GPU" }).getAttribute("data-state")
    ).toBe("checked");
    expect(
      screen.getByRole("switch", { name: "Force GPU rasterization" }).getAttribute("data-state")
    ).toBe("unchecked");
    expect(
      screen.getByRole("switch", { name: "Frame-rate limiter" }).getAttribute("data-state")
    ).toBe("checked");
    expect(screen.getByRole("switch", { name: "VSync" }).getAttribute("data-state")).toBe("checked");
    await waitFor(() =>
      expect((screen.getByRole("switch", { name: "VSync" }) as HTMLButtonElement).disabled).toBe(
        false
      )
    );
    expect(
      screen.getByRole("switch", { name: "GPU safety blocklist" }).getAttribute("data-state")
    ).toBe("checked");
    expect(screen.getByRole("switch", { name: "Unsafe WebGPU" }).getAttribute("data-state")).toBe(
      "unchecked"
    );
    expect(
      screen.getByRole("switch", { name: "GPU driver bug workarounds" }).getAttribute("data-state")
    ).toBe("checked");
    expect(
      screen.getByRole("switch", { name: "Windows background-process EcoQoS" }).getAttribute(
        "data-state"
      )
    ).toBe("checked");
    expect(
      screen.getByText("Managed by the operating-system WebView for occluded windows and hidden tabs.")
    ).toBeTruthy();
    expect(await screen.findByRole("combobox", { name: "Graphics API backend" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Graphics acceleration" })).toBeNull();
  });

  it("shows the resolved engine capability matrix without masking degraded behavior", () => {
    renderGameSettings(
      async (settings) => settings,
      "darwin",
      DEFAULT_GAME_BROWSER_SETTINGS,
      {
        roleStatuses: [{
          roleId: "role-1",
          state: "running",
          runtimeMode: "embedded",
          preferredEngine: "system",
          resolvedEngine: "wkwebview",
          hostKind: "system-native",
          capabilitySnapshot: {
            navigation: "supported",
            persistentSession: "supported",
            trustedInput: "unsupported",
            backgroundInput: "unsupported",
            frameEvaluation: "degraded",
            popup: "unsupported",
            audioMute: "supported",
            customFonts: "degraded",
            graphicsTuning: "disabled",
            downloads: "supported",
            fileUpload: "supported",
            permissions: "degraded",
            dialogs: "supported",
            certificateHandling: "supported"
          }
        }]
      }
    );

    expect(screen.getByText("Active engine capabilities")).toBeTruthy();
    expect(screen.getByText("Resolved engine")).toBeTruthy();
    expect(screen.getByText("WKWebView")).toBeTruthy();
    expect(screen.getAllByText("Unsupported").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Partial").length).toBeGreaterThan(0);
    expect(screen.getByText("Disabled")).toBeTruthy();
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
      forceGpuRasterization: false,
      frameRateLimitEnabled: true,
      vsyncEnabled: true
    });
    expect(screen.queryByText("Restart required")).toBeNull();
  });

  it("saves the Windows EcoQoS preference as an opt-out", async () => {
    const onGameBrowserSettingsChange = vi.fn(async (settings: GameBrowserSettings) => settings);
    renderGameSettings(onGameBrowserSettingsChange);

    const toggle = (await screen.findByRole("switch", {
      name: "Windows background-process EcoQoS"
    })) as HTMLButtonElement;
    await waitFor(() => expect(toggle.disabled).toBe(false));
    fireEvent.click(toggle);

    await waitFor(() => expect(onGameBrowserSettingsChange).toHaveBeenCalledOnce());
    expect(onGameBrowserSettingsChange.mock.calls[0][0].graphics.windowsEcoQosEnabled).toBe(false);
  });

  it("keeps the frame-rate limiter on while allowing VSync changes on macOS", async () => {
    const onGameBrowserSettingsChange = vi.fn(async (settings: GameBrowserSettings) => settings);
    renderGameSettings(onGameBrowserSettingsChange, "darwin", {
      ...DEFAULT_GAME_BROWSER_SETTINGS,
      graphics: {
        ...DEFAULT_GAME_BROWSER_SETTINGS.graphics,
        frameRateLimitEnabled: false,
        vsyncEnabled: false
      }
    });

    const frameRateLimit = screen.getByRole("switch", {
      name: "Frame-rate limiter"
    }) as HTMLButtonElement;
    const vsync = screen.getByRole("switch", { name: "VSync" }) as HTMLButtonElement;

    await waitFor(() => {
      expect(frameRateLimit.disabled).toBe(true);
      expect(frameRateLimit.getAttribute("data-state")).toBe("checked");
      expect(vsync.disabled).toBe(false);
      expect(vsync.getAttribute("data-state")).toBe("unchecked");
    });
    expect(
      screen.queryByRole("switch", { name: "Windows background-process EcoQoS" })
    ).toBeNull();
    expect(
      screen.getByText(
        "Always enabled on macOS because Chromium's unlimited-frame-rate flag can crash the GPU process."
      )
    ).toBeTruthy();

    fireEvent.click(vsync);

    await waitFor(() => expect(onGameBrowserSettingsChange).toHaveBeenCalledOnce());
    expect(onGameBrowserSettingsChange.mock.calls[0][0].graphics).toMatchObject({
      frameRateLimitEnabled: true,
      vsyncEnabled: true
    });
  });

  it("saves the Game Window startup restore preference from Interface settings", async () => {
    const onRuntimeWindowPreferencesChange = vi.fn(
      async (preferences: RuntimeWindowPreferences) => preferences
    );
    renderGameSettings(
      async (settings) => settings,
      "win32",
      DEFAULT_GAME_BROWSER_SETTINGS,
      {
        initialEntry: "/settings?section=interface",
        onRuntimeWindowPreferencesChange
      }
    );

    const toggle = screen.getByRole("switch", {
      name: "Restore Game Windows on startup"
    });
    expect(toggle.getAttribute("data-state")).toBe("checked");
    fireEvent.click(toggle);

    await waitFor(() => expect(onRuntimeWindowPreferencesChange).toHaveBeenCalledWith({
      alwaysShowToolbarInFullScreen: false,
      restoreGameWindowsOnStartup: false
    }));
  });
});
