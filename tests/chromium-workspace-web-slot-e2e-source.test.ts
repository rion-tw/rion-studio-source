import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

async function source(path: string): Promise<string> {
  return readFile(path, "utf8");
}

describe("Chromium mixed Workspace Web exact replacement", () => {
  it("shares one visible journey while retaining independent native pointer paths", async () => {
    const [spec, windowsPointer, appKitPointer, appKitLifecycle] = await Promise.all([
      source("e2e/desktop/specs/chromium-workspace-web-slot.e2e.ts"),
      source("e2e/desktop/support/electron-role-surface.ts"),
      source("e2e/desktop/support/macos-appkit-ui.ts"),
      source(
        "crates/rion-appkit/native/macos/RionRuntimeTabsController/" +
        "08_controller_lifecycle.mm"
      )
    ]);

    for (const marker of [
      "CHROMIUM-MACOS-APPKIT-WORKSPACE-WEB-SLOT-016",
      "CHROMIUM-WINDOWS-WORKSPACE-WEB-SLOT-016",
      "data-workspace-web-preset-select",
      "data-workspace-web-preset='youtube'",
      "workspace-web-name",
      "workspace-web-url",
      "data-workspace-role-id",
      "quick-access-destination-option-window-",
      "button=New game window",
      "listGameWindows",
      "dragMacosVisibleWorkspaceDivider",
      "dragWindowsVisibleWorkspaceDivider",
      "electronDesktopE2eWorkspaceWebRuntime",
      "electronDesktopE2eRoleSessionRuntime",
      "rion-web-chrome-shell:memory"
    ]) {
      expect(spec).toContain(marker);
    }
    expect(spec).not.toContain("runtimeUiAction(");
    expect(spec).not.toContain("controlWindow(");
    expect(spec).not.toContain("fullscreen");
    expect(windowsPointer).toContain("button.runtime-workspace-divider:not([hidden])");
    expect(windowsPointer).toContain('browser.action("pointer"');
    expect(windowsPointer).toContain('.down("left")');
    expect(windowsPointer).toContain('.up("left")');
    expect(appKitPointer).toContain('candidateRole is "AXSplitter"');
    expect(appKitPointer).toContain(
      'candidateDescription is "Resize workspace columns"'
    );
    expect(appKitPointer).toContain('return "PENDING|windows="');
    expect(appKitPointer).toContain('candidate.startsWith("PENDING|")');
    expect(appKitPointer).toContain("await browser.waitUntil(async () =>");
    expect(appKitPointer).toContain('perform action "AXRaise" of appWindow');
    expect(appKitPointer).toContain("AXUIElementCopyElementAtPosition(");
    expect(appKitPointer).toContain('hitProcessId !== processId');
    expect(appKitPointer).toContain("CGEvent(mouseEventSource: source");
    expect(appKitPointer).toContain(".leftMouseDragged");
    expect(appKitLifecycle).toContain(
      "addLocalMonitorForEventsMatchingMask:"
    );
    expect(appKitLifecycle).toContain("routeWorkspaceDividerEvent:");
    expect(appKitLifecycle).toContain("event.window != _window");
    expect(appKitLifecycle).toContain("NSPointInRect(point, divider.frame)");
  });

  it("proves two real Chromium surfaces and isolated native session readback", async () => {
    const [registry, shared, preload, inspection, e2eEntry, appKitBuild,
      appKitDivider, windowsHost] = await Promise.all([
        source("src/electron/main/chromiumGlobalWebPresentationRegistry.ts"),
        source("src/shared/workspaceWebChrome.ts"),
        source("src/electron/preload/workspaceWebChrome.ts"),
      source("src/electron/e2e/workspaceWebInspection.ts"),
      source("src/electron/e2e/index.ts"),
      source("crates/rion-appkit/build.rs"),
      source(
          "crates/rion-appkit/native/macos/RionRuntimeTabsController/" +
          "03_workspace_divider_views.mm"
        ),
        source("src/renderer/src/runtime-windows-host.ts")
      ]);

    expect(registry).toContain("input.shell.session.storagePath !== null");
    expect(registry).toContain("content.contentSession.storagePath");
    expect(registry).toContain("contentSessionStoragePath !== content.contentProfilePath");
    expect(registry).toContain("chromeShellStoragePath");
    expect(registry).toContain("readProjection(");
    expect(registry).toContain('record.state = "quarantined"');
    expect(shared).toContain("parseWorkspaceWebChromeAction");
    expect(shared).toContain("parseWorkspaceWebChromeState");
    expect(shared).toContain("canonicalWorkspaceWebUrl");
    expect(preload).toContain('from "../../shared/workspaceWebChrome"');
    expect(preload).not.toContain("../main/");
    expect(inspection).toContain('"rion-web-chrome-shell:memory" as const');
    expect(inspection).not.toContain("shared/workspaceWebChrome");
    expect(inspection).toContain("contentSessionStoragePath !== value.contentProfilePath");
    expect(inspection).toContain("content.height + chrome.height === slot.height");
    expect(e2eEntry).toContain("workspaceWebPresentationOwners");
    expect(e2eEntry).toContain("electron-workspace-web-runtime-observations.json");
    expect(appKitBuild).toContain(
      '"native/macos/RionRuntimeTabsController/03_workspace_divider_views.mm"'
    );
    expect(appKitDivider).toContain(": NSView <NSAccessibilityGroup>");
    expect(appKitDivider).toContain("NSAccessibilityUnignoredChildren(");
    expect(appKitDivider).toContain("self.accessibilityElement = YES;");
    expect(appKitDivider).toContain("self.accessibilityRole = NSAccessibilitySplitterRole;");
    expect(appKitDivider).toContain("return NSAccessibilitySplitterRole;");
    expect(appKitDivider).toContain("workspaceDividerAccessibilityParent");
    expect(appKitDivider).toContain('@"Resize workspace columns"');
    expect(appKitDivider).toContain('@"workspaceDividerPointer"');
    expect(windowsHost).toContain('type: "workspaceDividerPointer"');
    expect(windowsHost).toContain('element.setAttribute("aria-label"');
    expect(windowsHost).toContain('"Resize workspace columns"');
  });

  it("routes paired profile evidence and exact restart accounting", async () => {
    const [manifestSource, phases, runner, aggregator, evidence] = await Promise.all([
      source("docs/e2e-coverage.json"),
      source("e2e/desktop/phaseSpecs.ts"),
      source("scripts/runDesktopE2e.mjs"),
      source("scripts/desktopE2eChromiumJourneyEvidence.mjs"),
      source("scripts/desktopE2eChromiumWorkspaceWebEvidence.mjs")
    ]);
    const manifest = JSON.parse(manifestSource) as {
      journeys: Array<Record<string, unknown>>;
    };
    const journeys = manifest.journeys.filter(
      (journey) => journey.coverageGroup === "chromium-v23-workspace-web-slot"
    );
    expect(journeys).toHaveLength(2);
    expect(journeys.map((journey) => journey.platforms)).toEqual([
      ["macos"],
      ["windows"]
    ]);
    for (const journey of journeys) {
      expect(journey.replaces).toEqual(["WORKSPACE-WEB-SLOT-004"]);
      expect(journey.phases).toEqual([
        "chromium-workspace-web-slot-seed",
        "chromium-workspace-web-slot-restart"
      ]);
      expect(journey.outcomes).toEqual(["success", "restart"]);
    }
    expect(phases).toContain('"chromium-workspace-web-slot-seed"');
    expect(phases).toContain('"chromium-workspace-web-slot-restart"');
    expect(runner).toContain("...chromiumJourneyPhaseDependencies");
    expect(runner).toContain("...chromiumJourneyPhaseNamespaces");
    expect(aggregator).toContain("...chromiumWorkspaceWebPhaseDependencies");
    expect(aggregator).toContain("...chromiumWorkspaceWebPhaseNamespaces");
    expect(aggregator).toContain("validateChromiumWorkspaceWebRuntimeEvidence(input)");
    expect(aggregator).toContain("validateChromiumWorkspaceWebSqliteEvidence(");
    expect(evidence).toContain("terminal.topologyRevision > first.topologyRevision");
    expect(evidence).toContain("terminalWebSlot.rect.width > initialWebSlot.rect.width");
    expect(evidence).toContain("Chromium Workspace Web Window");
    expect(evidence).toContain("workspaceTab.roleSlots");
    expect(evidence).toContain("seedSqliteEvidence !== undefined");
  });
});
