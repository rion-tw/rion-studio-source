import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("foreground System WebView performance diagnostics", () => {
  it("samples live role surfaces and exports the most recent result", async () => {
    const [core, model, shell, runtime, native, cargo] = await Promise.all([
      readFile(new URL("../crates/rion-core/src/app.rs", import.meta.url), "utf8"),
      readFile(new URL("../crates/rion-core/src/model.rs", import.meta.url), "utf8"),
      readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
      readFile(new URL("../src-tauri/src/system_runtime.rs", import.meta.url), "utf8"),
      readFile(new URL("../src-tauri/native/macos/RionWKWebViewInput.m", import.meta.url), "utf8"),
      readFile(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8")
    ]);

    expect(model).toContain("pub struct BrowserPerformanceDiagnosticsRecord");
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
    expect(cargo).toContain('"Win32_Graphics_Gdi"');
    expect(runtime).toContain("GetDeviceCaps(Some(device_context), VREFRESH)");
  });
});
