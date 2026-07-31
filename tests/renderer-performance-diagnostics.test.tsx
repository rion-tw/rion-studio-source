// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfirmationProvider } from "../src/renderer/src/components/ConfirmationDialog";
import { DiagnosticsSettingsSection } from "../src/renderer/src/features/settings/DiagnosticsSettingsSection";
import en from "../src/renderer/src/i18n/en.json";
import type { Translator } from "../src/renderer/src/i18n";
import type { RionStudioApi } from "../src/shared/api";
import type { BrowserPerformanceDiagnostics, Role } from "../src/shared/types";

const t: Translator = (key) => en[key] ?? key;

function performanceDiagnostics(
  overrides: Partial<BrowserPerformanceDiagnostics> = {},
  surfaceOverrides: Partial<BrowserPerformanceDiagnostics["surfaces"][number]> = {}
): BrowserPerformanceDiagnostics {
  return {
    capturedAt: "2026-07-29T00:00:00Z",
    platform: "macos",
    status: "available",
    windowId: "window-1",
    windowFocused: true,
    displayRefreshRateHz: 120,
    systemLowPowerModeEnabled: false,
    systemThermalState: "nominal",
    highRefreshRateRequested: true,
    sampleDurationMs: 1500,
    surfaces: [{
      roleId: "role-1",
      origin: "https://game.example.test",
      documentVisibilityState: "visible",
      documentHasFocus: true,
      viewportWidth: 1280,
      viewportHeight: 720,
      devicePixelRatio: 2,
      hardwareConcurrency: 8,
      frameCount: 108,
      observedDurationMs: 1500,
      averageFps: 72,
      p50FrameIntervalMs: 13.89,
      p95FrameIntervalMs: 14.2,
      p99FrameIntervalMs: 14.7,
      longestFrameIntervalMs: 18,
      slowFrameCount: 0,
      missedVsyncCount: 0,
      longTaskCount: 0,
      longTaskTotalDurationMs: 0,
      longestTaskMs: 0,
      graphics: {
        renderer: "Apple GPU",
        vendor: "Apple",
        webgl: "available",
        webgl2: "available",
        webgpu: "available"
      },
      highRefreshRateStatus: "applied",
      ...surfaceOverrides
    }],
    ...overrides
  };
}

async function renderPerformanceDiagnostics(
  diagnostics: BrowserPerformanceDiagnostics
): Promise<ReturnType<typeof vi.fn>> {
  const collectBrowserPerformanceDiagnostics = vi.fn(async () => diagnostics);
  window.rionStudio = {
    collectBrowserPerformanceDiagnostics,
    getLogStatus: async () => ({
      currentLevel: "debug",
      entryCount: 0,
      fileCount: 0,
      totalBytes: 0,
      retentionDays: 14,
      maxBytes: 1024,
      directory: "/logs"
    }),
    queryLogs: async () => ({ entries: [] }),
    onLogEntryAdded: () => () => undefined
  } as unknown as RionStudioApi;

  render(
    <ConfirmationProvider>
      <DiagnosticsSettingsSection
        roles={[{ id: "role-1", name: "Knight" } as Role]}
        t={t}
        onError={vi.fn()}
      />
    </ConfirmationProvider>
  );
  fireEvent.click(screen.getByRole("button", { name: "Measure foreground FPS" }));
  await waitFor(() => expect(collectBrowserPerformanceDiagnostics).toHaveBeenCalledOnce());
  return collectBrowserPerformanceDiagnostics;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("foreground performance diagnostics UI", () => {
  it("runs the native sample and explains an FPS rate below display refresh", async () => {
    await renderPerformanceDiagnostics(performanceDiagnostics());
    expect(await screen.findByText("72.0 FPS")).toBeTruthy();
    expect(document.body.textContent).toContain("120 Hz");
    expect(document.body.textContent).toContain("Low power mode: Disabled");
    expect(document.body.textContent).toContain("Thermal state: Nominal");
    expect(document.body.textContent).toContain("14.70 ms");
    expect(document.body.textContent).toContain("0 / 0.0 ms");
    expect(screen.getByText(/Observed 72.0 FPS on a 120 Hz display/u)).toBeTruthy();
    expect(screen.getByText("Applied")).toBeTruthy();
  });

  it.each([
    {
      name: "low power mode before every lower-priority issue",
      diagnostics: performanceDiagnostics({
        systemLowPowerModeEnabled: true,
        systemThermalState: "critical"
      }, {
        highRefreshRateStatus: "failed",
        longTaskCount: 1,
        longestTaskMs: 80
      }),
      finding: /macOS Low Power Mode is enabled/u
    },
    {
      name: "serious thermal pressure before high-refresh setup failures",
      diagnostics: performanceDiagnostics({
        systemThermalState: "serious"
      }, {
        highRefreshRateStatus: "failed"
      }),
      finding: /System thermal pressure is Serious/u
    },
    {
      name: "high-refresh setup failures before page workload findings",
      diagnostics: performanceDiagnostics({}, {
        highRefreshRateStatus: "scheduleFailed",
        longTaskCount: 1,
        longestTaskMs: 80
      }),
      finding: /high-refresh preference was not applied \(Could not schedule\)/u
    }
  ])("prioritizes $name", async ({ diagnostics, finding }) => {
    await renderPerformanceDiagnostics(diagnostics);
    expect(await screen.findByText(finding)).toBeTruthy();
  });

  it("explains that high refresh is disabled on a high-refresh macOS display", async () => {
    await renderPerformanceDiagnostics(performanceDiagnostics({
      highRefreshRateRequested: false
    }, {
      highRefreshRateStatus: "disabled"
    }));
    expect(await screen.findByText(/high-refresh preference is disabled/u)).toBeTruthy();
  });
});
