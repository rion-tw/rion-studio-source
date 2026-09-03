import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

async function source(path: string): Promise<string> {
  return readFile(path, "utf8");
}

describe("Chromium controlled Role Reload source contract", () => {
  it("keeps two platform verdicts on one visible-menu phase", async () => {
    const [spec, phases, manifestSource, fixture] = await Promise.all([
      source("e2e/desktop/specs/chromium-controlled-role-reload.e2e.ts"),
      source("e2e/desktop/phaseSpecs.ts"),
      source("docs/e2e-coverage.json"),
      source("scripts/runtimeAuthorityFixtureServer.mjs")
    ]);
    const manifest = JSON.parse(manifestSource) as {
      journeys: Array<Record<string, unknown>>;
      profiles: Record<string, { phases: string[]; specs: string[] }>;
    };
    for (const [id, profile, platform] of [
      [
        "CHROMIUM-MACOS-APPKIT-RUNTIME-TAB-RELOAD-031",
        "chromium-macos-appkit-smoke",
        "macos"
      ],
      [
        "CHROMIUM-WINDOWS-RUNTIME-TAB-RELOAD-031",
        "chromium-windows-smoke",
        "windows"
      ]
    ] as const) {
      expect(spec).toContain(`[journey:${id}]`);
      expect(manifest.journeys).toContainEqual(expect.objectContaining({
        coverageGroup: "chromium-v23-runtime-tab-reload",
        id,
        kind: "native",
        phases: ["chromium-controlled-role-reload"],
        platforms: [platform],
        priority: "P1",
        profile,
        status: "automated"
      }));
      expect(manifest.profiles[profile]!.phases).toContain(
        "chromium-controlled-role-reload"
      );
      expect(manifest.profiles[profile]!.specs).toContain(
        "e2e/desktop/specs/chromium-controlled-role-reload.e2e.ts"
      );
    }
    expect(phases).toContain('"chromium-controlled-role-reload"');
    expect(phases).toContain("chromium-controlled-role-reload.e2e.ts");
    expect(spec.match(/await selectReload\(/gu)).toHaveLength(4);
    expect(spec).toContain("failNextElectronDesktopE2eRuntimeTabReload");
    expect(spec).toContain("ELECTRON_DESKTOP_E2E_RUNTIME_TAB_RELOAD_INJECTED");
    expect(spec).toContain("selectMacosVisibleRuntimeTabMenuAction");
    expect(spec).toContain("selectVisibleWindowsRuntimeTabMenuAction");
    expect(spec).toContain("electronDesktopE2eRuntimeTabReload");
    expect(spec).toContain("stableNativeWindowIdentity");
    expect(spec).toContain("toBeGreaterThanOrEqual(");
    expect(spec).not.toContain('rendererCall("browserRuntimeTabReload"');
    expect(await source("e2e/desktop/support/macos-appkit-ui.ts")).toContain(
      "expectedWindowIdentifier"
    );
    expect(fixture).toContain('qaTarget.classList.add("contained-fullscreen-layout")');
    expect(fixture).toContain(
      "#qa-target.contained-fullscreen-layout { position: static; transform: none; }"
    );
  });

  it("preserves captured source fences through both native menu implementations", async () => {
    const [menu, windowsRenderer, windowsController, ingress, inspection,
      observer, docs] =
      await Promise.all([
        source("src/electron/main/macosAppKitRuntimeTabMenu.ts"),
        source("src/renderer/src/runtime-windows-host.ts"),
        source("src/electron/main/windowsRuntimeHostChromeController.ts"),
        source("src/electron/main/controlledRuntimeTabReload.ts"),
        source("src/electron/e2e/runtimeTabReloadInspection.ts"),
        source("src/electron/e2e/runtimeTabReloadObserver.ts"),
        source("docs/chromium-runtime-migration.md")
      ]);
    expect(menu).toContain('type: "reload"');
    expect(menu).toContain("tabId: context.tabId");
    expect(menu).toContain("lifecycleEpoch");
    expect(windowsRenderer).toContain('type: "reloadTab"');
    expect(windowsRenderer).toContain("projectionRevision: projection.projectionRevision");
    expect(windowsController).toContain("reloadTerminal = this.#applyTabCommand(candidate)");
    expect(windowsController).toContain("command.lifecycleEpoch");
    expect(ingress).toContain('type: "browserRuntimeTabReload"');
    expect(ingress).toContain("windowGeneration: fence.windowGeneration");
    expect(ingress).toContain("topologyRevision: fence.topologyRevision");
    expect(ingress).toContain("lifecycleEpoch: fence.lifecycleEpoch");
    expect(inspection).toContain("nativeInputResumed");
    expect(inspection).toContain("coreInputResumed");
    expect(observer).toContain("ELECTRON_DESKTOP_E2E_RUNTIME_TAB_RELOAD_INJECTED");
    expect(docs).toContain("Tauri v22");
  });
});
