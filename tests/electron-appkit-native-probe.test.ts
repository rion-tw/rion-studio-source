import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("Electron retained AppKit native probe contract", () => {
  it("builds desktop-E2E methods only for an explicit non-release E2E addon", async () => {
    const source = await readFile("scripts/buildElectronRust.mjs", "utf8");

    expect(source).toContain(
      'process.env.RION_STUDIO_DESKTOP_E2E_BUILD === "1"'
    );
    expect(source).toContain("if (release && desktopE2e)");
    expect(source).toContain('["--features=desktop-e2e"]');
    expect(source).toContain(
      "verifyDesktopE2eAddonSurface(destination, desktopE2e)"
    );
    expect(source).toContain(
      "The production Rust addon exposes forbidden desktop-E2E methods"
    );
    expect(source).toContain(
      "The production Rust addon exposes a forbidden desktop-E2E Core factory"
    );
    expect(source).toContain(
      "The Chromium target addon exposes the forbidden source-session vault writer"
    );
    expect(source).toContain(
      "The production Rust addon is missing Chrome-profile import startup recovery"
    );
    expect(source).toContain("recoverPendingChromeProfileImportsInternal");
    expect(source).toContain('const fixtureFactory = "createAppCoreForDesktopE2e"');
    expect(source).toContain('"desktopE2eStatusPresentation"');
  });

  it("proves native AppKit geometry, action identity, focus, and fullscreen state", async () => {
    const source = await readFile("scripts/electronAppKitRuntimeProbe.cjs", "utf8");

    expect(source).toContain("addon.appKitRuntimeAbiVersion() !== 6");
    expect(source).toContain("new WebContentsView");
    expect(source).toContain('evidenceScope: desktopE2eBuild');
    expect(source).toContain('"standalone-native-appkit-chromium-adapter"');
    expect(source).toContain('"production-addon-e2e-surface-absence"');
    expect(source).toContain("desktopE2eTitlebarGeometry");
    expect(source).toContain("trafficLightsMaxX");
    expect(source).toContain("desktopE2eAccessibilityPress");
    expect(source).toContain("desktopE2eAccessibilityClose");
    expect(source).toContain("desktopE2eAccessibilityShowMenu");
    expect(source).toContain('"openTabMenu"');
    expect(source).toContain('tabType: "popup"');
    expect(source).toContain("popupAccessibilityPressEvent");
    expect(source).toContain("popupAccessibilityCloseEvent");
    expect(source).toContain("The AppKit popup close action retained a foreign tab owner");
    expect(source).toContain("backgroundFocusAfter");
    expect(source).toContain('window.once("enter-full-screen"');
    expect(source).toContain('window.once("leave-full-screen"');
    expect(source).toContain("fullscreenToolbarEntered");
    expect(source).toContain("fullscreenToolbarExited");
    expect(source).toContain("desktopE2eStatusPresentation");
    expect(source).toContain(
      "desktopE2eBuild &&\n        nativeHost.desktopE2eStatusPresentation"
    );
    expect(source).toContain("AppKit activating phase did not expose native loading status");
    expect(source).toContain("AppKit ready phase did not clear native loading status");
    expect(source).toContain("same-revision phase conflict");
    expect(source).toContain("Elapsed time only terminalizes this probe as failed");
    expect(source).not.toContain("BrowserWindow");
  });

  it("keeps the AppKit threadsafe callback as one raw JSON string argument", async () => {
    const [adapter, probe] = await Promise.all([
      readFile("crates/rion-node/src/appkit_runtime_host.rs", "utf8"),
      readFile("scripts/electronAppKitRuntimeProbe.cjs", "utf8")
    ]);

    expect(adapter).toContain(
      "ThreadsafeFunction<String, (), String, Status, false, false, APPKIT_EVENT_QUEUE_CAPACITY>"
    );
    expect(adapter).toContain("callback: Function<'_, String, ()>");
    expect(adapter).toContain(".build_callback(|context| Ok(context.value))?");
    expect(adapter).not.toContain("Function<'_, (String,), ()>");
    expect(adapter).not.toContain("Ok((context.value,))");
    expect(probe).toContain('typeof eventJson !== "string"');
    expect(probe).toContain(
      "The AppKit N-API callback did not emit one raw JSON string argument."
    );
  });
});
