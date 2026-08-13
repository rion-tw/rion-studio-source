import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("desktop E2E build isolation", () => {
  it("keeps WebDriver permissions out of the production Tauri config", async () => {
    const config = JSON.parse(await readFile("src-tauri/tauri.conf.json", "utf8"));
    expect(config.app.withGlobalTauri).not.toBe(true);
    expect(JSON.stringify(config.app.security.capabilities ?? []))
      .not.toMatch(/wdio|desktop-e2e/iu);
  });

  it("compiles the control plane only behind the desktop-e2e feature", async () => {
    const source = await readFile("src-tauri/src/lib.rs", "utf8");
    expect(source).toContain("#[cfg(feature = \"desktop-e2e\")]\nmod desktop_e2e;");
    const control = await readFile("src-tauri/src/desktop_e2e.rs", "utf8");
    expect(control).toContain("#[cfg(not(debug_assertions))]");
    expect(control).toContain("compile_error!");
  });

  it("grants native runtime evidence commands only in the desktop E2E capability", async () => {
    const config = JSON.parse(await readFile("src-tauri/tauri.e2e.conf.json", "utf8"));
    const capabilities = config.app.security.capabilities as Array<{
      identifier?: string;
      permissions?: string[];
    }>;
    const debug = capabilities.find((capability) =>
      capability.identifier === "desktop-e2e-debug-only"
    );
    expect(debug?.permissions).toEqual(expect.arrayContaining([
      "allow-desktop-e2e-input-diagnostics",
      "allow-desktop-e2e-runtime-ui-action"
    ]));
  });

  it("keeps renderer reload readiness probes retryable", async () => {
    const source = await readFile("e2e/desktop/support/ui.ts", "utf8");

    expect(source).toContain("const RENDERER_PROBE_TIMEOUT_MS = 5_000;");
    expect(source).toContain("const RENDERER_READY_TIMEOUT_MS = 30_000;");
    expect(source).toContain("await browser.getTimeouts()");
    expect(source).toContain("await browser.setTimeout({ script: RENDERER_PROBE_TIMEOUT_MS })");
    expect(source).toContain("await browser.setTimeout({ script: previousScriptTimeout })");
    expect(source).toContain("lastProbeError = error;");
    expect(source).toContain("return false;");
    expect(source).toContain('localStorage.getItem(storageKey) !== "en"');
    expect(source).toContain('document.documentElement.lang !== "en"');
    expect(source).toContain("await browser.refresh()");
    expect(source).not.toContain("window.location.reload()");
  });

  it("keeps router-native test navigation out of production renderer assets", async () => {
    const renderer = await readFile("src/renderer/src/main.tsx", "utf8");
    const isolationCheck = await readFile("scripts/verifyDesktopE2eIsolation.mjs", "utf8");

    expect(renderer).toContain("if (__RION_DESKTOP_E2E__)");
    expect(renderer).toContain("window.__rionStudioDesktopE2eNavigate");
    expect(renderer).toContain("router.navigate(path)");
    expect(isolationCheck).toContain("__rionStudioDesktopE2eNavigate");
  });

  it("submits Windows close through the native window queue", async () => {
    const source = await readFile(
      "src-tauri/src/system_runtime/section_31_desktop_e2e.rs",
      "utf8"
    );
    const windowsControl = source.slice(
      source.indexOf("#[cfg(windows)]\nfn desktop_e2e_apply_native_window_control("),
      source.indexOf("#[cfg(target_os = \"macos\")]\nfn desktop_e2e_apply_native_window_control(")
    );
    const closeControl = windowsControl.slice(
      windowsControl.indexOf("DesktopE2eWindowControlRequest::Close =>"),
      windowsControl.indexOf("DesktopE2eWindowControlRequest::Minimize =>")
    );

    expect(closeControl).toContain("PostMessageW(");
    expect(closeControl).toContain("WM_CLOSE");
    expect(closeControl).not.toContain("window.close()");
  });

  it("focuses the native Game Window before the desktop E2E role surface", async () => {
    const [controlSource, journeySource] = await Promise.all([
      readFile("src-tauri/src/system_runtime/section_31_desktop_e2e_ui.rs", "utf8"),
      readFile("e2e/desktop/specs/game-window-lifecycle.e2e.ts", "utf8")
    ]);
    const focusRole = controlSource.slice(
      controlSource.indexOf("DesktopE2eRuntimeUiActionRequest::FocusRole"),
      controlSource.indexOf("DesktopE2eRuntimeUiActionRequest::PressRoleSlot")
    );
    const forceTerminate = journeySource.slice(
      journeySource.indexOf("async function forceTerminatePhase"),
      journeySource.indexOf("async function crashRestartPhase")
    );

    expect(focusRole).toContain("host.window.clone()");
    expect(focusRole.indexOf("request_platform_window_show_foreground(&window)"))
      .toBeLessThan(focusRole.indexOf("webview.set_focus()"));
    expect(forceTerminate.indexOf('kind: "window-focus-persisted"'))
      .toBeLessThan(forceTerminate.indexOf("await runtimeUiAction(WINDOW_C"));
  });
});
