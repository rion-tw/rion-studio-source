import { readSourceTree as readFile } from "./helpers/readSourceTree";

import { describe, expect, it } from "vitest";

describe("foreground System WebView performance diagnostics", () => {
  it("samples live role surfaces and exports the most recent result", async () => {
    const [core, model, shell, runtime, native, cargo] = await Promise.all([
      readFile(new URL("../crates/rion-core/src/app.rs", import.meta.url), "utf8"),
      readFile(new URL("../crates/rion-core/src/model/mod.rs", import.meta.url), "utf8"),
      readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
      readFile(new URL("../src-tauri/src/system_runtime.rs", import.meta.url), "utf8"),
      readFile(new URL("../src-tauri/native/macos/RionWKWebViewInput.m", import.meta.url), "utf8"),
      readFile(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8")
    ]);

    expect(model).toContain("pub struct BrowserPerformanceDiagnosticsRecord");
    expect(model).toContain("pub system_low_power_mode_enabled: Option<bool>");
    expect(model).toContain("pub system_thermal_state: Option<String>");
    expect(runtime).toContain("PERFORMANCE_DIAGNOSTIC_START_SOURCE");
    expect(runtime).toContain("requestAnimationFrame(tick)");
    expect(runtime).toContain("PerformanceObserver");
    expect(runtime).toContain('includes("longtask")');
    expect(runtime).toContain("frame_budget_diagnostics");
    expect(runtime).toContain("p99_frame_interval_ms");
    expect(runtime).toContain("document.hasFocus()");
    expect(runtime).toContain("document.visibilityState");
    expect(runtime).toContain("last_performance_diagnostics");
    expect(shell).toContain('"collectBrowserPerformanceDiagnostics"');
    expect(shell).toContain('"browserPerformance": state.runtime.last_browser_performance_diagnostics()');
    expect(core).toContain('"foregroundPerformance": snapshot.browser_performance');
    expect(native).toContain("rion_ns_window_display_refresh_rate");
    expect(native).toContain("maximumFramesPerSecond");
    expect(native).toContain("rion_ns_low_power_mode_enabled");
    expect(native).toContain("isLowPowerModeEnabled");
    expect(native).toContain("rion_ns_thermal_state");
    expect(native).toContain("NSProcessInfoThermalStateCritical");
    expect(cargo).toContain('"Win32_Graphics_Gdi"');
    expect(cargo).toContain('"Win32_System_Power"');
    expect(runtime).toContain("GetDeviceCaps(Some(device_context), VREFRESH)");
    expect(runtime).toContain("GetSystemPowerStatus(&mut status)");
    expect(runtime).toContain("windows_low_power_mode_from_system_status_flag");
  });
});
