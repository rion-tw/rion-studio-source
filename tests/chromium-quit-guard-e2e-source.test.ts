import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const specPath = "e2e/desktop/specs/chromium-quit-guard.e2e.ts";

describe("Chromium application quit-guard desktop E2E boundary", () => {
  it("keeps editor decisions visible and enters quit through OS-native input", async () => {
    const [source, nativeActions, e2eBridge, electronDriver] = await Promise.all([
      readFile(specPath, "utf8"),
      readFile("e2e/desktop/support/native-application-actions.ts", "utf8"),
      readFile("src/electron/e2e/desktopE2eBridge.ts", "utf8"),
      readFile("e2e/desktop/support/electron-driver.ts", "utf8")
    ]);

    expect(source).not.toContain("navigate(");
    expect(source).not.toContain("browser.executeAsync");
    expect(source).not.toContain("dispatchEvent");
    expect(source).not.toContain("window.rionStudio");
    expect(source).not.toContain("requestElectronDesktopE2eNativeQuit");
    expect(source).toContain("pressVisibleNativeApplicationQuit");
    expect(source.match(/pressVisibleNativeApplicationQuit\(\)/gu)).toHaveLength(1);
    expect(source.match(/openQuitDialog\(\)/gu)).toHaveLength(3);
    expect(nativeActions).toContain("key code 12 using command down");
    expect(nativeActions).toContain(
      "exact Rion launcher AXWindow unavailable before quit"
    );
    expect(nativeActions).toContain("SetForegroundWindow");
    expect(nativeActions).toContain("keybd_event(0x51");
    expect(nativeActions).not.toContain("requestElectronDesktopE2eNativeQuit");
    expect(e2eBridge).not.toContain("requestNativeQuit");
    expect(electronDriver).not.toContain("requestNativeQuit");

    const rendererMethods = [...source.matchAll(/rendererCall\("([^"]+)"/gu)]
      .map((match) => match[1]);
    expect(new Set(rendererMethods)).toEqual(new Set(["listGames"]));

    for (const label of [
      "Games",
      "New game",
      "Keep editing",
      "Discard changes"
    ]) {
      expect(source).toContain(label);
    }
    expect(source).toContain("electron-final-flush.json");
    expect(source).toContain("Chromium Unsaved Quit Guard Game");
  });
});
