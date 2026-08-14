// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfirmationProvider } from "../src/renderer/src/components/ConfirmationDialog";
import { DiagnosticsSettingsSection } from "../src/renderer/src/features/settings/DiagnosticsSettingsSection";
import en from "../src/renderer/src/i18n/en.json";
import type { Translator } from "../src/renderer/src/i18n";
import type { RionStudioApi } from "../src/shared/api";
import type {
  BrowserPerformanceDiagnosticOperation,
  BrowserPerformanceDiagnostics,
  Role
} from "../src/shared/types";

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
      presentationFps: 72,
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
      webGlExecutionPath: "webContentDirect",
      webGlCommandBatchingStatus: "verifiedAbsent",
      performanceTargetStatus: "notRun",
      browserProcessPresent: undefined,
      rendererProcessPresent: true,
      gpuProcessPresent: false,
      hardwareAccelerationEnabled: true,
      primaryCanvas: {
        cssWidth: 1280,
        cssHeight: 720,
        pixelWidth: 2560,
        pixelHeight: 1440,
        devicePixelRatio: 2,
        megapixels: 3.6864
      },
      ...surfaceOverrides
    }],
    ...overrides
  };
}

async function renderPerformanceDiagnostics(
  diagnostics: BrowserPerformanceDiagnostics
): Promise<ReturnType<typeof vi.fn>> {
  let listener: ((operation: BrowserPerformanceDiagnosticOperation) => void) | undefined;
  const beginBrowserPerformanceDiagnostics = vi.fn(async () => {
    const accepted: BrowserPerformanceDiagnosticOperation = {
      operationId: "performance-diagnostic-1",
      revision: 1,
      phase: "waitingForFocus"
    };
    queueMicrotask(() => listener?.({
      ...accepted,
      revision: 3,
      phase: "completed",
      diagnostics
    }));
    return accepted;
  });
  window.rionStudio = {
    beginBrowserPerformanceDiagnostics,
    cancelBrowserPerformanceDiagnostics: async () => undefined,
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
    onLogEntryAdded: () => () => undefined,
    onBrowserPerformanceDiagnosticsChanged: (
      callback: (operation: BrowserPerformanceDiagnosticOperation) => void
    ) => {
      listener = callback;
      return () => { listener = undefined; };
    }
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
  fireEvent.click(screen.getByRole("button", { name: "Measure presentation FPS" }));
  await waitFor(() => expect(beginBrowserPerformanceDiagnostics).toHaveBeenCalledOnce());
  return beginBrowserPerformanceDiagnostics;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("foreground performance diagnostics UI", () => {
  it("cancels the exact operation and ignores a stale completion", async () => {
    let listener: ((operation: BrowserPerformanceDiagnosticOperation) => void) | undefined;
    const accepted: BrowserPerformanceDiagnosticOperation = {
      operationId: "performance-diagnostic-cancel",
      revision: 1,
      phase: "waitingForFocus"
    };
    const cancelBrowserPerformanceDiagnostics = vi.fn(async (_operationId: string) => {
      listener?.({ ...accepted, revision: 2, phase: "cancelled" });
      listener?.({
        ...accepted,
        revision: 1,
        phase: "completed",
        diagnostics: performanceDiagnostics()
      });
      listener?.({
        operationId: "performance-diagnostic-older",
        revision: 99,
        phase: "completed",
        diagnostics: performanceDiagnostics()
      });
    });
    window.rionStudio = {
      beginBrowserPerformanceDiagnostics: async () => accepted,
      cancelBrowserPerformanceDiagnostics,
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
      onLogEntryAdded: () => () => undefined,
      onBrowserPerformanceDiagnosticsChanged: (
        callback: (operation: BrowserPerformanceDiagnosticOperation) => void
      ) => {
        listener = callback;
        return () => { listener = undefined; };
      }
    } as unknown as RionStudioApi;

    render(
      <ConfirmationProvider>
        <DiagnosticsSettingsSection roles={[]} t={t} onError={vi.fn()} />
      </ConfirmationProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: "Measure presentation FPS" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel measurement" }));
    await waitFor(() => expect(cancelBrowserPerformanceDiagnostics)
      .toHaveBeenCalledWith("performance-diagnostic-cancel"));
    expect(screen.queryByText("72.0 presentation FPS")).toBeNull();
    expect(screen.getByRole("button", { name: "Measure presentation FPS" })).toBeTruthy();
  });

  it("runs the native sample and explains an FPS rate below display refresh", async () => {
    await renderPerformanceDiagnostics(performanceDiagnostics());
    expect(await screen.findByText("72.0 presentation FPS")).toBeTruthy();
    expect(document.body.textContent).toContain("120 Hz");
    expect(document.body.textContent).toContain("Low power mode: Disabled");
    expect(document.body.textContent).toContain("Thermal state: Nominal");
    expect(document.body.textContent).toContain("14.70 ms");
    expect(document.body.textContent).toContain("0 / 0.0 ms");
    expect(screen.getByText(/Observed 72.0 FPS on a 120 Hz display/u)).toBeTruthy();
    expect(screen.getByText("applied")).toBeTruthy();
    expect(screen.queryByText("UseGPUProcessForWebGLEnabled")).toBeNull();
    expect(screen.getByText("WebGL command batching")).toBeTruthy();
  });

  it("shows the retained WebKit command-batching capability values", async () => {
    await renderPerformanceDiagnostics(performanceDiagnostics({}, {
      webGlExecutionPath: "gpuProcess",
      webGlCommandBatchingStatus: "verifiedAvailable",
      webKitRuntimeVersion: "21626.1.1"
    }));
    const text = document.body.textContent ?? "";
    expect(text).toContain("Experimental high refresh rateapplied");
    expect(text).toContain("WebGL pathGPU process");
    expect(text).toContain("WebGL command batchingVerified available");
    expect(text).toContain("WebKit: STP 249／21626.1.1");
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
