import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "..");

async function source(path: string): Promise<string> {
  return readFile(resolve(repositoryRoot, path), "utf8");
}

describe("Chromium Quick Access exact replacement source", () => {
  it("owns the managed-page shortcut before game delivery on both native targets", async () => {
    const [shortcut, registry, bootstrap, main, macosMenu] = await Promise.all([
      source("src/electron/main/chromiumRoleQuickAccessShortcut.ts"),
      source("src/electron/main/chromiumRoleSurfaceRegistry.ts"),
      source("src/electron/main/chromiumRuntimeBootstrap.ts"),
      source("src/electron/main/index.ts"),
      source("src/electron/main/macosApplicationMenu.ts")
    ]);

    expect(shortcut).toContain("event.preventDefault()");
    expect(shortcut).toContain('platform === "darwin"');
    expect(shortcut).toContain('input.inputEvent.type !== "keyDown"');
    expect(shortcut).toContain("input.inputEvent.isAutoRepeat");
    expect(shortcut).not.toContain("setTimeout");
    expect(shortcut).not.toContain("setInterval");
    expect(registry).toContain('contents.on("before-input-event"');
    expect(registry).toContain('contents.removeListener("before-input-event"');
    expect(bootstrap).toContain("input.onRuntimeTabQuickAccess");
    expect(main).toContain("beginRuntimeTabQuickAccess");
    expect(main).toContain("runtimeActionServices.beginRuntimeTabQuickAccess(tabId)");
    expect(macosMenu).toContain('accelerator: "Command+K"');
    expect(macosMenu).toContain("executeQuickAccess(focusedWindow)");
  });

  it("uses visible sidebar, keyboard, managed-page, dialog, pin, recent, and clear actions", async () => {
    const spec = await source("e2e/desktop/specs/chromium-quick-access.e2e.ts");

    for (const marker of [
      "CHROMIUM-MACOS-APPKIT-QUICK-ACCESS-015",
      "CHROMIUM-WINDOWS-QUICK-ACCESS-015",
      "[data-testid='quick-access-trigger']",
      "submitElectronRolePageQuickAccessShortcut",
      "focusVisibleMacosAppKitRuntime",
      "pressVisibleMacosApplicationShortcut",
      "fixtureEvents",
      "Key.Command",
      "Key.Ctrl",
      "dialog[open]",
      "data-quick-access-group='pinned'",
      "data-quick-access-group='recent'",
      "button=Clear recent",
      "currentRuntime?.focused"
    ]) {
      expect(spec).toContain(marker);
    }
    expect(spec).not.toContain('rendererCall("setQuickAccessPinned"');
    expect(spec).not.toContain('rendererCall("recordQuickAccessUse"');
    expect(spec).not.toContain('rendererCall("clearQuickAccessRecent"');
    expect(spec.indexOf("focusVisibleMacosAppKitRuntime({"))
      .toBeLessThan(spec.indexOf("pressVisibleMacosApplicationShortcut({"));
  });

  it("keeps separate macOS AppKit and Windows replacement verdicts", async () => {
    const manifest = JSON.parse(await source("docs/e2e-coverage.json")) as {
      journeys: Array<Record<string, unknown>>;
    };
    const journeys = manifest.journeys.filter((journey) =>
      journey.coverageGroup === "chromium-v23-quick-access"
    );

    expect(journeys).toHaveLength(2);
    expect(journeys.map((journey) => journey.platforms)).toEqual([
      ["macos"],
      ["windows"]
    ]);
    for (const journey of journeys) {
      expect(journey.replaces).toEqual(["QUICK-ACCESS-UI-001"]);
      expect(journey.outcomes).toEqual(["success", "failure", "restart"]);
      expect(journey.phases).toEqual([
        "chromium-quick-access-seed",
        "chromium-quick-access-restart"
      ]);
    }
  });
});
