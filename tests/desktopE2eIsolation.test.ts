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
});
