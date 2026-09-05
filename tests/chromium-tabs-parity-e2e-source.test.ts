import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

async function source(path: string): Promise<string> {
  return readFile(path, "utf8");
}

describe("Chromium native tab exact replacements", () => {
  it("shares one visible-UI journey across retained AppKit and Windows Chromium", async () => {
    const [spec, helper, appKitHelper, appKitTabs] = await Promise.all([
      source("e2e/desktop/specs/chromium-tabs-parity.e2e.ts"),
      source("e2e/desktop/support/native-runtime-tabs.ts"),
      source("e2e/desktop/support/macos-appkit-ui.ts"),
      source("crates/rion-appkit/native/macos/RionRuntimeTabsController/03_shortcut_model.mm")
    ]);
    for (const marker of [
      "CHROMIUM-MACOS-APPKIT-TABS-VISIBLE-ACTIVATION-019",
      "CHROMIUM-WINDOWS-TABS-VISIBLE-ACTIVATION-019",
      "CHROMIUM-MACOS-APPKIT-GAME-WINDOWS-TABS-020",
      "CHROMIUM-WINDOWS-GAME-WINDOWS-TABS-020",
      "clickVisibleRuntimeTab",
      "closeVisibleRuntimeTab",
      "closeVisibleRuntimeWindow",
      "electronDesktopE2eFullscreenToolbarRuntime",
      "electronDesktopE2eGameWindowRuntime",
      "sameOrderedIds(current.coreTabIds, input.orderedTabIds)",
      "sameOrderedIds(current.nativeTabIds, input.orderedTabIds)",
      "logical?.activeTabId === input.activeTabId",
      "const alreadyActive =",
      "if (afterSequence !== undefined)",
      "focused: true",
      "clickVisibleElectronRolePageButton",
      "button=New game",
      "button=New game window",
      "quick-access-destination-option-window"
    ]) {
      expect(spec).toContain(marker);
    }
    expect(spec).not.toContain("runtimeUiAction(");
    expect(spec).not.toContain("controlWindow(");
    expect(spec).not.toContain("browser.execute(");
    expect(helper).toContain('perform action "AXRaise" of targetWindow');
    expect(helper).toContain('if targetCount is 0 then return "pending:" & observedTabs');
    expect(helper).toContain(
      "did not become Accessibility-ready"
    );
    expect(helper).toContain('if targetCount is 0 then return "pending"');
    expect(helper).toContain("await clickMacosScreenPoint(point[0]!, point[1]!)");
    expect(helper).toContain(".leftMouseDown");
    expect(helper).toContain(".leftMouseUp");
    expect(helper).toContain(
      "if focusedIdentifier is not targetIdentifier then"
    );
    expect(helper).toContain("const appKit = toolbar.native.appKit");
    expect(helper).toContain("appKit?.tabAnchors?.[input.tabId]");
    expect(helper).toContain("bounds.x + anchor.x - 18");
    expect(helper).toContain("tabScreenBounds.y + tabScreenBounds.height / 2");
    expect(helper).toContain("evidence.tabId !== tabId");
    expect(helper).toContain("await switchTrackedWindow(mainWindowHandle)");
    expect(helper).toContain("The visible AppKit close control did not close");
    expect(appKitTabs).toContain("com.rionstudio.runtime.appkit-tab.v1:%@");
    expect(appKitTabs).not.toContain("self.accessibilityIdentifier = tab.identifier;");
    expect(helper).toContain('whose subrole is "AXCloseButton"');
    expect(helper).toContain("[data-runtime-tab-activate]");
    expect(helper).toContain("[data-runtime-tab-close]");
    expect(helper).toContain("button[data-window-command='closeWindow']");
    expect(spec).toContain("dragMacosVisibleRuntimeTab");
    expect(spec).toContain("selectMacosVisibleRuntimeTabMenuAction");
    expect(spec).toContain("dragVisibleWindowsRuntimeTab");
    expect(spec).toContain("selectVisibleWindowsRuntimeTabMenuAction");
    expect(spec).toContain("revealRoleThroughVisibleUi");
    expect(spec).toContain("button[aria-label='Open']");
    expect(spec).toContain("chromium-tabs-topology-observations.json");
    expect(spec).toContain('stage: "detached-with-successor"');
    expect(spec).toContain('stage: "windows-geometry"');
    expect(appKitHelper).toContain('perform action "AXShowMenu" of targetTab');
    expect(appKitHelper).toContain("CGEvent(mouseEventSource: source");
    expect(helper).toContain('.down("right")');
    expect(helper).toContain("readVisibleWindowsRuntimeHostLayout");
    expect(helper).toContain("resizeVisibleWindowsRuntimeWindow");
    expect(spec).toContain("visibleRuntimeTabPhase");
    expect(spec).toContain('/api/gates/${fixtureId}/waiting');
    expect(spec).toContain('toBe("loading")');
    expect(spec).toContain('toBe("ready")');
  });

  it("projects authoritative phase through retained AppKit native chrome", async () => {
    const [core, model, node, platform, header, native, factory, follower] = await Promise.all([
      source("crates/rion-core/src/app/section_16_appkit_runtime_events.rs"),
      source("crates/rion-core/src/model/section_10_appkit_runtime.rs"),
      source("crates/rion-node/src/appkit_runtime_host.rs"),
      source("crates/rion-node/src/appkit_runtime_host/platform.rs"),
      source("crates/rion-appkit/native/macos/RionRuntimeTabsController.h"),
      source("crates/rion-appkit/native/macos/RionRuntimeTabsController/06_fullscreen.mm"),
      source("src/electron/main/macosAppKitRuntimeHostFactory.ts"),
      source("src/electron/main/chromiumRuntimeOwnershipFollower.ts")
    ]);
    expect(model).toContain("pub phase: RuntimeTabActivationPhaseRecord");
    expect(core).toContain(".tab_activations");
    expect(node).toContain("phase_c: CString");
    expect(node).toContain("phases_match(controller, &phases_json)");
    expect(platform).toContain("&tab.phase_c");
    expect(header).toContain("phase:(NSString *)phase");
    expect(native).toContain("tab.phase = phase.length > 0 ? phase");
    expect(native).toContain("[item configureWithTab:tab");
    expect(native).toContain("if (tab.active) [self updateStatusForActiveTab]");
    expect(factory).toContain("phase: tab.phase");
    expect(factory).toContain("RION_APPKIT_RUNTIME_ABI_VERSION = 6");
    expect(factory).toContain("#applyPhaseProjection");
    expect(factory).toContain("restoreLastVerifiedTabProjection");
    expect(factory).toContain("previousNativeProjectionRevision");
    expect(follower).toContain("applyAppKitPhaseProjection(projection)");
    expect(follower).toContain("ELECTRON_MACOS_APPKIT_PHASE_PROJECTION_INCOMPLETE");
    expect(follower).toContain("ELECTRON_MACOS_APPKIT_PHASE_PROJECTION_INVALID");
  });

  it("routes Windows visible tab buttons through one fenced Core native-action lane", async () => {
    const [shared, renderer, controller, native, factory, bootstrap, main, menu] =
      await Promise.all([
        source("src/shared/windowsRuntimeHost.ts"),
        source("src/renderer/src/runtime-windows-host.ts"),
        source("src/electron/main/windowsRuntimeHostChromeController.ts"),
        source("src/electron/main/chromiumRuntimeNativeWindowController.ts"),
        source("src/electron/main/chromiumRuntimeHostFactory.ts"),
        source("src/electron/main/chromiumRuntimeBootstrap.ts"),
        source("src/electron/main/index.ts"),
        source("src/electron/main/macosAppKitRuntimeTabMenu.ts")
      ]);
    expect(shared).toContain('type: "activateTab"');
    expect(shared).toContain('type: "closeTab"');
    expect(shared).toContain('type: "reorderTab"');
    expect(shared).toContain('type: "moveTabToNewWindow"');
    expect(renderer).toContain('submitTab(tab.tabId, "activateTab")');
    expect(renderer).toContain('submitTab(tab.tabId, "closeTab")');
    expect(renderer).toContain('openTabMenu(event, tab.tabId)');
    expect(renderer).toContain('type: "reorderTab"');
    expect(controller).toContain("#commandLane");
    expect(controller).toContain('type: "moveTab"');
    expect(controller).toContain('type: "reorderTab"');
    expect(native).toContain('{ type: "showGameWindowTab", tabId }');
    expect(native).toContain('{ type: "stopGameWindowTab", tabId }');
    expect(native).toContain('{ type: "setGameWindowTabHidden", tabId, hidden: true }');
    expect(native).toContain('{ type: "setGameWindowTabMuted", tabId, muted: action.muted }');
    expect(factory).toContain("requestTabControl: this.#onTabControl");
    expect(bootstrap).toContain("input.windows!.onTabControl");
    expect(main).toContain("runtimeActionServices.requestRuntimeTabControl");
    expect(main).toContain("activeRuntimeRestoreSession()");
    expect(main).toContain("MacosAppKitRuntimeTabMenuController");
    expect(main).toContain("BaseWindow.fromId(parentNativeHostId)");
    expect(menu).toContain('id: "runtime-tab-menu-reload"');
    expect(menu).toContain('type: "reload"');
    expect(menu).toContain("lifecycleEpoch");
    expect(menu).toContain('id: "runtime-tab-menu-mute"');
    expect(menu).toContain('id: "runtime-tab-menu-stop"');
  });

  it("keeps separate exact macOS and Windows verdicts for both legacy journeys", async () => {
    const [manifestSource, phases, runner, aggregator, evidence] = await Promise.all([
      source("docs/e2e-coverage.json"),
      source("e2e/desktop/phaseSpecs.ts"),
      source("scripts/runDesktopE2e.mjs"),
      source("scripts/desktopE2eChromiumJourneyEvidence.mjs"),
      source("scripts/desktopE2eChromiumTabsEvidence.mjs")
    ]);
    const manifest = JSON.parse(manifestSource) as {
      journeys: Array<Record<string, unknown>>;
    };
    for (const [coverageGroup, replacement, outcomes] of [
      [
        "chromium-v23-tabs-visible-activation",
        "TABS-VISIBLE-ACTIVATION-003",
        ["success", "failure", "restart"]
      ],
      [
        "chromium-v23-game-window-tabs",
        "GAME-WINDOWS-TABS-001",
        ["success", "restart"]
      ]
    ] as const) {
      const journeys = manifest.journeys.filter(
        (journey) => journey.coverageGroup === coverageGroup
      );
      expect(journeys).toHaveLength(2);
      expect(journeys.map((journey) => journey.platforms)).toEqual([
        ["macos"],
        ["windows"]
      ]);
      for (const journey of journeys) {
        expect(journey.replaces).toEqual([replacement]);
        expect(journey.outcomes).toEqual(outcomes);
        expect(journey.phases).toEqual([
          "chromium-tabs-visible-seed",
          "chromium-tabs-visible-restart"
        ]);
      }
    }
    expect(phases).toContain('"chromium-tabs-visible-seed"');
    expect(phases).toContain('"chromium-tabs-visible-restart"');
    expect(runner).toContain("...chromiumJourneyPhaseDependencies");
    expect(runner).toContain("...chromiumJourneyPhaseNamespaces");
    expect(runner).toContain("validateChromiumJourneyRuntimeEvidence");
    expect(runner).toContain("validateChromiumJourneySqliteEvidence");
    expect(aggregator).toContain("...chromiumTabsPhaseDependencies");
    expect(aggregator).toContain("...chromiumTabsPhaseNamespaces");
    expect(aggregator).toContain("validateChromiumTabsRuntimeEvidence(input)");
    expect(aggregator).toContain("validateChromiumTabsSqliteEvidence(phase, entities, settings)");
    expect(evidence).toContain("chromium-tabs-topology-observations.json");
    expect(evidence).toContain('"detached-with-successor"');
    expect(evidence).toContain('"restart-distributed"');
    expect(evidence).toContain("window.owner.parentNativeHostId > 0");
    expect(evidence).toContain("geometry.source.resized.resizeEventCount");
    expect(evidence).toContain("sameValue(session.liveWindowIds, [])");
  });

  it("keeps native display semantics in paired hardware-only profiles", async () => {
    const [manifestSource, spec, helper, phases, evidence] = await Promise.all([
      source("docs/e2e-coverage.json"),
      source("e2e/desktop/specs/chromium-native-window-display.e2e.ts"),
      source("e2e/desktop/support/native-runtime-tabs.ts"),
      source("e2e/desktop/phaseSpecs.ts"),
      source("scripts/desktopE2eChromiumTabsEvidence.mjs")
    ]);
    const manifest = JSON.parse(manifestSource) as {
      journeys: Array<Record<string, unknown>>;
      profiles: Record<string, Record<string, unknown>>;
    };
    for (const group of [
      "chromium-v23-runtime-launch-destinations",
      "chromium-v23-runtime-tab-topology",
      "chromium-v23-game-windows-native",
      "chromium-v23-native-display"
    ]) {
      expect(manifest.journeys.filter((journey) => journey.coverageGroup === group))
        .toHaveLength(2);
    }
    expect(manifest.profiles["chromium-macos-appkit-hardware-extended"]?.gate)
      .toBe("nightly");
    expect(manifest.profiles["chromium-windows-hardware-extended"]?.gate)
      .toBe("nightly");
    expect(spec).toContain("BLOCKED: Chromium native display profile requires two real displays");
    expect(spec).toContain("new Set(topology.displays.map((display) => display.scaleFactor))");
    expect(spec).toContain("clickVisibleRuntimeWindowControl");
    expect(spec).toContain("dragVisibleRuntimeWindow");
    expect(spec).toContain("resizeVisibleRuntimeWindow");
    expect(spec).toContain("pressVisibleMacosApplicationShortcut");
    expect(spec).not.toContain("controlWindow(");
    expect(helper).toContain("AXMinimizeButton");
    expect(phases).toContain('"chromium-native-window-display-extended"');
    expect(evidence).toContain('"chromium-native-window-display-extended"');
  });
});
