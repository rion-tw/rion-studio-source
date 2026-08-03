import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("desktop power lifecycle adapters", () => {
  it("routes macOS sleep and wake notifications into the shared lifecycle actor", async () => {
    const [native, build, adapter] = await Promise.all([
      readFile("src-tauri/native/macos/RionPowerLifecycle.m", "utf8"),
      readFile("src-tauri/build.rs", "utf8"),
      readFile("src-tauri/src/power_lifecycle.rs", "utf8")
    ]);

    expect(native).toContain("NSWorkspaceWillSleepNotification");
    expect(native).toContain("NSWorkspaceDidWakeNotification");
    expect(native).toContain("macos-workspace-will-sleep");
    expect(native).toContain("macos-workspace-did-wake");
    expect(build).toContain("native/macos/RionPowerLifecycle.m");
    expect(adapter).toContain("enqueue_application_lifecycle_signal(suspended, reason)");
  });

  it("uses a Win32 power message window and handles every resume class", async () => {
    const adapter = await readFile("src-tauri/src/power_lifecycle.rs", "utf8");

    expect(adapter).toContain("WM_POWERBROADCAST");
    expect(adapter).toContain("PBT_APMSUSPEND");
    expect(adapter).toContain("PBT_APMRESUMEAUTOMATIC");
    expect(adapter).toContain("PBT_APMRESUMECRITICAL");
    expect(adapter).toContain("PBT_APMRESUMESTANDBY");
    expect(adapter).toContain("PBT_APMRESUMESUSPEND");
    expect(adapter).toContain("windows-power-suspend");
    expect(adapter).toContain("windows-power-resume");
  });
});
