import { readSourceTree as readFile } from "./helpers/readSourceTree";

import { describe, expect, it } from "vitest";

describe("System WebView background throttling", () => {
  it("uses native hidden-view scheduling without a custom suspension loop", async () => {
    const [runtime, bootstrap] = await Promise.all([
      readFile(new URL("../src-tauri/src/system_runtime.rs", import.meta.url), "utf8"),
      readFile(new URL("../crates/rion-core/src/bootstrap_settings.rs", import.meta.url), "utf8")
    ]);
    const builder = runtime.slice(
      runtime.indexOf("fn webview_builder("),
      runtime.indexOf("fn clear_role_browser_data(")
    );
    const applyRuntime = runtime.slice(
      runtime.indexOf("fn apply_runtime("),
      runtime.indexOf("fn sync_native_tab_metadata(")
    );
    const presentationBatch = runtime.slice(
      runtime.indexOf("fn apply_native_presentation_batch("),
      runtime.indexOf("fn capture_presentation_batch_events(")
    );

    expect(builder.match(/background_throttling\(BackgroundThrottlingPolicy::Throttle\)/gu)).toHaveLength(2);
    expect(builder).toContain("if install_role_features {");
    expect(builder).toContain('#[cfg(target_os = "macos")]');
    expect(presentationBatch).toContain("surface.show()");
    expect(presentationBatch).toContain("surface.hide()");
    expect(applyRuntime).not.toContain("surface.show()");
    expect(applyRuntime).toContain("surface.hide()");
    expect(runtime).not.toContain("PreferredBackgroundTimerWakeInterval");
    expect(runtime).not.toContain("MemoryUsageTargetLevel");
    expect(runtime).not.toContain("TrySuspend");
    expect(bootstrap).not.toContain("disable-background-timer-throttling");
  });
});
