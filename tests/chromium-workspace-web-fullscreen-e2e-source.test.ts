import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { validateChromiumWorkspaceWebPopupLifecycleEvidence } from
  "../scripts/desktopE2eChromiumWorkspaceWebFullscreenEvidence.mjs";

async function source(path: string): Promise<string> {
  return readFile(path, "utf8");
}

const POPUP_EVIDENCE_WINDOW_ID = "00000000-0000-4000-8000-0000000000a1";
const POPUP_EVIDENCE_TAB_ID = "00000000-0000-4000-8000-0000000000a2";
const POPUP_EVIDENCE_SURFACE_ID = `web-${POPUP_EVIDENCE_TAB_ID}-3`;
const POPUP_EVIDENCE_SLOT_ID = "slot-1";
const POPUP_EVIDENCE_ATTEMPT_ID = "00000000-0000-4000-8000-0000000000a5";
const POPUP_EVIDENCE_FIRST_ID = "00000000-0000-4000-8000-0000000000b1";
const POPUP_EVIDENCE_FIRST_OPEN = "00000000-0000-4000-8000-0000000000b2";
const POPUP_EVIDENCE_FIRST_CLOSE = "00000000-0000-4000-8000-0000000000b3";
const POPUP_EVIDENCE_RETIRED_ID = "00000000-0000-4000-8000-0000000000c1";
const POPUP_EVIDENCE_RETIRED_OPEN = "00000000-0000-4000-8000-0000000000c2";
const popupEvidenceParent = {
  ownerId: POPUP_EVIDENCE_SURFACE_ID,
  ownerKind: "globalWeb",
  ownerNativeGeneration: 3,
  parentAppkitIdentity: null,
  parentAttemptGeneration: POPUP_EVIDENCE_ATTEMPT_ID,
  parentNativeHostId: 41,
  parentTabId: POPUP_EVIDENCE_TAB_ID,
  parentTopologyRevision: 9,
  parentWindowGeneration: 2,
  parentWindowId: POPUP_EVIDENCE_WINDOW_ID,
  roleOwnerGeneration: null,
  slotId: POPUP_EVIDENCE_SLOT_ID
};
const popupEvidenceRetiredParent = {
  ...popupEvidenceParent,
  parentTopologyRevision: 11
};

function popupEvidenceObservation(input: Record<string, unknown>) {
  const sequence = Number(input.sequence);
  return {
    action: "nativeReady",
    closeNative: false,
    closeReason: null,
    completionScope: "nativeAcknowledgement",
    eventId: `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, "0")}`,
    failureCode: null,
    lifecycleRevision: 2,
    lifecycleTerminal: false,
    operationTerminal: false,
    parent: popupEvidenceParent,
    phase: "nativeReady",
    status: "applied",
    terminalReason: null,
    ...input
  };
}

describe("Chromium Workspace Web contained-fullscreen exact replacement", () => {
  it("shares visible main and popup actions across exact platform journeys", async () => {
    const [spec, pageSurface, fixture, nativeUpload] = await Promise.all([
      source("e2e/desktop/specs/chromium-workspace-web-fullscreen.e2e.ts"),
      source("e2e/desktop/support/electron-role-surface.ts"),
      source("scripts/runtimeAuthorityFixtureServer.mjs"),
      source("e2e/desktop/support/native-file-upload.ts")
    ]);

    for (const marker of [
      "CHROMIUM-MACOS-APPKIT-WORKSPACE-WEB-FULLSCREEN-017",
      "CHROMIUM-WINDOWS-WORKSPACE-WEB-FULLSCREEN-017",
      "CHROMIUM-MACOS-APPKIT-POPUP-012",
      "CHROMIUM-WINDOWS-POPUP-012",
      "CHROMIUM-MACOS-APPKIT-WORKSPACE-WEB-SECURITY-POLICY-027",
      "CHROMIUM-WINDOWS-WORKSPACE-WEB-SECURITY-POLICY-027",
      "CHROMIUM-MACOS-APPKIT-WORKSPACE-WEB-FILE-UPLOAD-028",
      "CHROMIUM-WINDOWS-WORKSPACE-WEB-FILE-UPLOAD-028",
      "data-workspace-web-preset='youtube'",
      "data-workspace-role-id",
      "button[aria-label='Open workspace']",
      "clickVisibleElectronPageElement",
      "clickVisibleElectronPageElementKeepingTarget",
      "clickVisibleElectronPageElementWithPointer",
      "restoreElectronMainWindowTarget",
      "submitElectronPageEscape",
      "#contained-fullscreen-enter",
      "#contained-fullscreen-exit",
      "#contained-fullscreen-popup",
      "contained-popup-ready",
      "closeVisibleRuntimeTab",
      "closeVisibleRuntimeWindow",
      "readVisibleMacosRuntimeTabCloseEvidence",
      'fixtureRequest("/api/gate"',
      "/api/gates/${POPUP_FIXTURE_ID}/waiting",
      "electronDesktopE2ePopupLifecycleJournal",
      "popupJournalBaseline",
      'closeReason: "parentRetired"',
      'completionScope: "nativeDestroyed"',
      "operationTerminal: true",
      'kind: "gated-navigation-transport-cancelled"',
      "electronDesktopE2eWorkspaceWebRuntime",
      "electronDesktopE2eWorkspaceWebSecurityPolicy",
      "#permission-geolocation",
      "#blocked-download",
      "download-transport-cancelled",
      "#file-upload",
      "prepareNativeFileUploadFixture",
      "selectVisibleNativeUploadFile",
      "writeVisibleFileUploadEvidence"
    ]) {
      expect(spec).toContain(marker);
    }
    expect(spec).toContain("isTrusted: true");
    expect(spec).not.toContain("runtimeUiAction(");
    expect(spec).not.toContain("controlWindow(");
    expect(spec).not.toContain("keyboardInput(");
    expect(pageSurface).toContain('await element.click()');
    expect(pageSurface).toContain(
      'scrollIntoView({ block: "center", inline: "center" })'
    );
    expect(pageSurface).toContain('.down("left")');
    expect(pageSurface).toContain('.up("left")');
    expect(pageSurface).toContain('command: "escape"');
    expect(pageSurface).toContain('targetMode: "focused-runtime"');
    expect(fixture).toContain('target="_blank" rel="noopener"');
    expect(fixture).toContain('roleId === "chromium-workspace-web-fullscreen"');
    expect(fixture).toContain("navigator.geolocation.getCurrentPosition(");
    expect(fixture).toContain('response.once("close"');
    expect(fixture).toContain('kind: "gated-navigation-transport-cancelled"');
    expect(fixture).toContain('type="file"');
    expect(fixture).toContain('crypto.subtle.digest("SHA-256"');
    expect(fixture).toContain('record("file-upload-selected"');
    expect(fixture).toContain(
      'popupButton.style.cssText = "position:fixed;inset:0;z-index:5;'
    );
    expect(fixture).toContain("const input = event.currentTarget");
    expect(fixture).toContain("targetId: input.id");
    for (const nativeToken of [
      'using terms from application "System Events"',
      'subrole of appWindow is "AXDialog"',
      'role of appSheet is "AXSheet"',
      'perform action "AXRaise"',
      'resolve(homedir(), "RionE2E-")',
      "await link(fixturePath, stagedFixturePath)",
      'actionNames(current).contains("AXOpen")',
      'AXUIElementPerformAction(target, "AXOpen" as CFString)',
      "ProcessIdProperty, $targetPid",
      "ClassNameProperty, '#32770'",
      "AutomationIdProperty, '1148'",
      "AutomationIdProperty, '1'",
      "dialogOwnership: \"exact-app-process\""
    ]) {
      expect(nativeUpload).toContain(nativeToken);
    }
    expect(spec).toContain("await selection.cleanup()");
    expect(spec).toContain("afterSequence,\n    kind: \"session\"");
    expect(spec).toContain("sessionCursor = await fixtureCursor()");
    expect(nativeUpload).not.toContain("Get-CimInstance");
  });

  it("contains Chromium events in paired native envelopes without replacing AppKit", async () => {
    const [security, ports, surface, presentation, popup, popupJournal,
      inspection, entry, appKit] = await Promise.all([
        source("src/electron/main/security.ts"),
        source("src/electron/main/chromiumRoleSurfacePorts.ts"),
        source("src/electron/main/chromiumGlobalWebSurfaceRegistry.ts"),
        source("src/electron/main/chromiumGlobalWebPresentationRegistry.ts"),
        source("src/electron/main/chromiumPopupLifecycleCoordinator.ts"),
        source("src/electron/e2e/popupLifecycleJournalInspection.ts"),
        source("src/electron/e2e/workspaceWebInspection.ts"),
        source("src/electron/e2e/index.ts"),
        source("src/electron/main/macosAppKitRuntimeHostFactory.ts")
      ]);

    expect(security).toContain("disableHtmlFullscreenWindowResize: true");
    expect(ports).toContain('"enter-html-full-screen"');
    expect(ports).toContain('"leave-html-full-screen"');
    expect(surface).toContain("onContainedFullscreenChange?.(true)");
    expect(surface).toContain("onContainedFullscreenChange?.(false)");
    expect(presentation).toContain("#applyContainedFullscreen");
    expect(presentation).toContain("fullscreen ? record.slotBounds");
    expect(presentation).toContain("record.view.setVisible(fullscreen ? false");
    expect(presentation).toContain("#readPairedProjection(");
    expect(presentation).toContain("CONTAINED_FULLSCREEN_COMPENSATION_FAILED");
    expect(presentation).toContain('record.state = "quarantined"');
    expect(popup).toContain("sameHostEnvelope(projection, expected)");
    expect(popup).toContain("record.host.getContentBounds()");
    expect(popup).toContain("CONTAINED_FULLSCREEN_HOST_CHANGED");
    expect(popup).toContain("readLifecycleJournal()");
    expect(popup).toContain("operationTerminal: receipt.operationTerminal");
    expect(popupJournal).toContain("parentWindowGeneration");
    expect(popupJournal).toContain("value.operationTerminal !==");
    expect(inspection).toContain("value.containedFullscreen");
    expect(inspection).toContain("sameBounds(content, slot)");
    expect(entry).toContain("workspaceRoleSurfaceOwners");
    expect(entry).toContain("workspacePopupHostOwners");
    expect(entry).toContain("electron-workspace-web-fullscreen-observations.json");
    expect(appKit).not.toContain("runtime-windows-host.html");
  });

  it("selects the exact native Windows host before a popup or parent tab action", async () => {
    const nativeTabs = await source("e2e/desktop/support/native-runtime-tabs.ts");
    expect(nativeTabs).toContain("windowsRuntimeHostHandle(");
    expect(nativeTabs).toContain("tabId?: string");
    expect(nativeTabs).toContain("[data-tab-id='${tabId}']");
    expect(nativeTabs).toContain("input.mainWindowHandle, input.tabId");
    expect(nativeTabs).toContain("stale preference, presentation, or native fences");
    expect(nativeTabs).toContain("await browser.waitUntil(async () =>");
  });

  it("routes paired restart coverage and exact native/Core history", async () => {
    const [manifestSource, phases, aggregator, evidence, strategy, spec] =
      await Promise.all([
        source("docs/e2e-coverage.json"),
        source("e2e/desktop/phaseSpecs.ts"),
        source("scripts/desktopE2eChromiumJourneyEvidence.mjs"),
        source("scripts/desktopE2eChromiumWorkspaceWebFullscreenEvidence.mjs"),
        source("docs/e2e-strategy.md"),
        source("e2e/desktop/specs/chromium-workspace-web-fullscreen.e2e.ts")
      ]);
    const manifest = JSON.parse(manifestSource) as {
      journeys: Array<Record<string, unknown>>;
      profiles: Record<string, { phases: string[]; specs: string[] }>;
    };
    const journeys = manifest.journeys.filter(
      (journey) => journey.coverageGroup ===
        "chromium-v23-workspace-web-fullscreen"
    );
    expect(journeys).toHaveLength(2);
    expect(journeys.map((journey) => journey.platforms)).toEqual([
      ["macos"],
      ["windows"]
    ]);
    for (const journey of journeys) {
      expect(journey.replaces).toEqual(["WORKSPACE-WEB-FULLSCREEN-005"]);
      expect(journey.phases).toEqual([
        "chromium-workspace-web-fullscreen-seed",
        "chromium-workspace-web-fullscreen-restart"
      ]);
      expect(journey.outcomes).toEqual(["success", "restart"]);
    }
    for (const profile of [
      manifest.profiles["chromium-macos-appkit-smoke"],
      manifest.profiles["chromium-windows-smoke"]
    ]) {
      expect(profile.phases).toEqual(expect.arrayContaining([
        "chromium-workspace-web-fullscreen-seed",
        "chromium-workspace-web-fullscreen-restart"
      ]));
      expect(profile.specs).toContain(
        "e2e/desktop/specs/chromium-workspace-web-fullscreen.e2e.ts"
      );
    }
    expect(phases).toContain('"chromium-workspace-web-fullscreen-seed"');
    expect(phases).toContain('"chromium-workspace-web-fullscreen-restart"');
    expect(aggregator).toContain("...chromiumWorkspaceWebFullscreenPhaseDependencies");
    expect(aggregator).toContain("...chromiumWorkspaceWebFullscreenPhaseNamespaces");
    expect(aggregator).toContain(
      "validateChromiumWorkspaceWebFullscreenRuntimeEvidence(input)"
    );
    expect(evidence).toContain("topologyRevisionsAreMonotonic");
    expect(evidence).toContain(
      "web.contentBounds.height === web.slotBounds.height"
    );
    expect(evidence).not.toContain(
      "sameValue(web.contentBounds, web.slotBounds)"
    );
    expect(evidence).toContain(
      "observation.topologyRevision === mainTopologyRevision"
    );
    expect(evidence).toContain(
      "observation.topologyRevision === popupTopologyRevision"
    );
    expect(evidence).toContain('popup.logicalWindowId !== `popup-${popup.popupId}`');
    expect(evidence).toContain("sameValue(observation.role, first.role)");
    expect(evidence).toContain("popupObservations.length >= 4");
    expect(evidence).toContain("electron-popup-lifecycle-journal.json");
    expect(spec).toContain('"chromium-workspace-web-slot-marker"');
    expect(evidence).toContain("validateChromiumWorkspaceWebPopupLifecycleEvidence(");
    expect(evidence).toContain('nativeClosed?.closeReason === "parentRetired"');
    expect(evidence).toContain('nativeClosed?.completionScope === "nativeDestroyed"');
    expect(evidence).toContain("nativeClosed?.operationTerminal === true");
    expect(evidence).toContain("malformed exact-Session permission/download deny journal");
    expect(evidence).toContain("downloadDenials[0].defaultPrevented === true");
    expect(evidence).toContain("electron-workspace-web-file-upload.json");
    expect(evidence).toContain("validFileUploadEvidence(");
    expect(evidence).toContain("visible native file upload lacks exact path/content evidence");
    expect(evidence).toContain("seedSqliteEvidence !== undefined");
    expect(strategy).toContain(
      "CHROMIUM-MACOS-APPKIT-WORKSPACE-WEB-FULLSCREEN-017"
    );

    const securityJourneys = manifest.journeys.filter(
      (journey) => journey.coverageGroup ===
        "chromium-v23-workspace-web-security-policy"
    );
    expect(securityJourneys).toHaveLength(2);
    expect(securityJourneys.map((journey) => journey.platforms)).toEqual([
      ["macos"],
      ["windows"]
    ]);
    for (const journey of securityJourneys) {
      expect(journey.priority).toBe("P1");
      expect(journey.phases).toEqual([
        "chromium-workspace-web-fullscreen-seed",
        "chromium-workspace-web-fullscreen-restart"
      ]);
      expect(journey.outcomes).toEqual(["failure", "restart"]);
    }

    const fileUploadJourneys = manifest.journeys.filter(
      (journey) => journey.coverageGroup ===
        "chromium-v23-workspace-web-file-upload"
    );
    expect(fileUploadJourneys).toHaveLength(2);
    expect(fileUploadJourneys.map((journey) => journey.platforms)).toEqual([
      ["macos"],
      ["windows"]
    ]);
    for (const journey of fileUploadJourneys) {
      expect(journey.priority).toBe("P1");
      expect(journey.phases).toEqual([
        "chromium-workspace-web-fullscreen-seed",
        "chromium-workspace-web-fullscreen-restart"
      ]);
      expect(journey.outcomes).toEqual(["success", "restart"]);
    }
    expect(strategy).toContain("CHROMIUM-*-WORKSPACE-WEB-FILE-UPLOAD-028");
  });

  it("executes the popup evidence validator and rejects forged terminality", () => {
    const first = {
      appKitIdentity: null,
      attemptGeneration: POPUP_EVIDENCE_ATTEMPT_ID,
      parentNativeHostId: 41,
      tabId: POPUP_EVIDENCE_TAB_ID,
      topologyRevision: 9,
      web: {
        generation: 3,
        slotId: POPUP_EVIDENCE_SLOT_ID,
        surfaceId: POPUP_EVIDENCE_SURFACE_ID
      },
      windowGeneration: 2,
      windowId: POPUP_EVIDENCE_WINDOW_ID
    };
    const visiblePopup = {
      openOperationId: POPUP_EVIDENCE_FIRST_OPEN,
      popupId: POPUP_EVIDENCE_FIRST_ID
    };
    const observations = [
      popupEvidenceObservation({
        openOperationId: POPUP_EVIDENCE_FIRST_OPEN,
        operationId: POPUP_EVIDENCE_FIRST_OPEN,
        popupId: POPUP_EVIDENCE_FIRST_ID,
        sequence: 1
      }),
      popupEvidenceObservation({
        action: "pageReady",
        completionScope: "pageFinished",
        lifecycleRevision: 3,
        openOperationId: POPUP_EVIDENCE_FIRST_OPEN,
        operationId: POPUP_EVIDENCE_FIRST_OPEN,
        operationTerminal: true,
        phase: "ready",
        popupId: POPUP_EVIDENCE_FIRST_ID,
        sequence: 2,
        terminalReason: "pageReady"
      }),
      popupEvidenceObservation({
        action: "closeRequested",
        closeNative: true,
        closeReason: "user",
        completionScope: "stateCommit",
        lifecycleRevision: 4,
        openOperationId: POPUP_EVIDENCE_FIRST_OPEN,
        operationId: POPUP_EVIDENCE_FIRST_CLOSE,
        phase: "closing",
        popupId: POPUP_EVIDENCE_FIRST_ID,
        sequence: 3
      }),
      popupEvidenceObservation({
        action: "nativeClosed",
        closeReason: "user",
        completionScope: "nativeDestroyed",
        lifecycleRevision: 5,
        lifecycleTerminal: true,
        openOperationId: POPUP_EVIDENCE_FIRST_OPEN,
        operationId: POPUP_EVIDENCE_FIRST_CLOSE,
        operationTerminal: true,
        phase: "closed",
        popupId: POPUP_EVIDENCE_FIRST_ID,
        sequence: 4,
        terminalReason: "user"
      }),
      popupEvidenceObservation({
        openOperationId: POPUP_EVIDENCE_RETIRED_OPEN,
        operationId: POPUP_EVIDENCE_RETIRED_OPEN,
        parent: popupEvidenceRetiredParent,
        popupId: POPUP_EVIDENCE_RETIRED_ID,
        sequence: 5
      }),
      popupEvidenceObservation({
        action: "closeRequested",
        closeNative: true,
        closeReason: "parentRetired",
        completionScope: "stateCommit",
        lifecycleRevision: 3,
        openOperationId: POPUP_EVIDENCE_RETIRED_OPEN,
        operationId: POPUP_EVIDENCE_RETIRED_OPEN,
        parent: popupEvidenceRetiredParent,
        phase: "closing",
        popupId: POPUP_EVIDENCE_RETIRED_ID,
        sequence: 6
      }),
      popupEvidenceObservation({
        action: "nativeClosed",
        closeReason: "parentRetired",
        completionScope: "nativeDestroyed",
        failureCode: "CHROMIUM_POPUP_OWNER_RETIRED",
        lifecycleRevision: 4,
        lifecycleTerminal: true,
        openOperationId: POPUP_EVIDENCE_RETIRED_OPEN,
        operationId: POPUP_EVIDENCE_RETIRED_OPEN,
        parent: popupEvidenceRetiredParent,
        operationTerminal: true,
        phase: "cancelled",
        popupId: POPUP_EVIDENCE_RETIRED_ID,
        sequence: 7,
        status: "cancelled",
        terminalReason: "parentRetired"
      })
    ];
    const journal = {
      capacity: 256,
      journalVersion: 1,
      observations,
      windowId: POPUP_EVIDENCE_WINDOW_ID
    };

    expect(validateChromiumWorkspaceWebPopupLifecycleEvidence(
      journal,
      first,
      visiblePopup
    )).toEqual({
      openOperationId: POPUP_EVIDENCE_RETIRED_OPEN,
      popupId: POPUP_EVIDENCE_RETIRED_ID,
      terminalSequence: 7
    });
    expect(() => validateChromiumWorkspaceWebPopupLifecycleEvidence({
      ...journal,
      observations: [
        ...observations.slice(0, -1),
        { ...observations.at(-1), operationTerminal: false }
      ]
    }, first, visiblePopup)).toThrow("malformed exact Core popup lifecycle journal");
  });
});
