import { describe, expect, it } from "vitest";

import { parseElectronDesktopE2eRuntimeTabReloadInspection } from
  "../src/electron/e2e/runtimeTabReloadInspection";

const WINDOW_ID = "10000000-0000-4000-8000-000000000001";
const TAB_ID = "20000000-0000-4000-8000-000000000001";
const POPUP_ID = "30000000-0000-4000-8000-000000000001";
const POPUP_WINDOW_ID = `popup-${POPUP_ID}`;
const OPEN_OPERATION_ID = "50000000-0000-4000-8000-000000000001";
const LAUNCH_GENERATION = "60000000-0000-4000-8000-000000000001";
const RELOAD_OPERATION_ID = "70000000-0000-4000-8000-000000000001";
const ROLE_ID = "80000000-0000-4000-8000-000000000001";
const DOCUMENT_IDS = [
  "90000000-0000-4000-8000-000000000001",
  "90000000-0000-4000-8000-000000000002",
  "90000000-0000-4000-8000-000000000003"
] as const;

function appKitIdentity(logicalWindowId: string) {
  return { launchGeneration: LAUNCH_GENERATION, logicalWindowId, nativeGeneration: 1 };
}

function inspection(platform: "darwin" | "win32") {
  const appKit = platform === "darwin";
  return {
    capacity: 32,
    failures: [],
    journalVersion: 1,
    nativeWindow: {
      appKitIdentity: appKit ? appKitIdentity(WINDOW_ID) : null,
      hostKind: appKit ? "appkit-chromium" : "bundled-chromium",
      parentNativeHostId: 41,
      tabIds: [TAB_ID],
      topologyRevision: 2,
      windowGeneration: 1
    },
    observations: [],
    platform,
    popups: [{
      appKitIdentity: null,
      currentUrl: "https://example.test/popup",
      hostKind: "electronBrowserWindow",
      logicalWindowId: POPUP_WINDOW_ID,
      nativeHostId: 42,
      nativeParentId: 41,
      openOperationId: OPEN_OPERATION_ID,
      openerPolicy: "connectedOpener",
      popupId: POPUP_ID,
      sessionMatchesOwner: true,
      title: "Rion Popup — example.test",
      visible: true
    }],
    roles: [],
    windowId: WINDOW_ID,
    windowsMenuCaptures: []
  };
}

describe("Electron desktop E2E runtime-tab Reload inspection", () => {
  it("fails closed when the platform and retained native hosts disagree", () => {
    expect(parseElectronDesktopE2eRuntimeTabReloadInspection(
      inspection("darwin")
    ).nativeWindow.hostKind).toBe("appkit-chromium");
    expect(parseElectronDesktopE2eRuntimeTabReloadInspection(
      inspection("win32")
    ).nativeWindow.hostKind).toBe("bundled-chromium");

    expect(() => parseElectronDesktopE2eRuntimeTabReloadInspection({
      ...inspection("darwin"),
      platform: "win32"
    })).toThrow(/inspection is invalid/u);
    expect(() => parseElectronDesktopE2eRuntimeTabReloadInspection({
      ...inspection("darwin"),
      popups: [{
        ...inspection("darwin").popups[0],
        hostKind: "bundled-chromium"
      }]
    })).toThrow(/inspection is invalid/u);
    expect(() => parseElectronDesktopE2eRuntimeTabReloadInspection({
      ...inspection("darwin"),
      popups: [{
        ...inspection("darwin").popups[0],
        logicalWindowId: POPUP_ID
      }]
    })).toThrow(/inspection is invalid/u);
  });

  it("binds an injected Windows failure to the current native/menu fence", () => {
    const current = inspection("win32");
    const request = {
      lifecycleEpoch: 3,
      operationId: RELOAD_OPERATION_ID,
      tabId: TAB_ID,
      topologyRevision: 2,
      type: "browserRuntimeTabReload",
      windowGeneration: 1,
      windowId: WINDOW_ID
    } as const;
    const capture = {
      lifecycleEpoch: 3,
      projectionRevision: 7,
      sequence: 1,
      tabId: TAB_ID,
      topologyRevision: 2,
      type: "reloadTab",
      windowGeneration: 1,
      windowId: WINDOW_ID
    } as const;
    const valid = {
      ...current,
      failures: [{
        failureCode: "ELECTRON_DESKTOP_E2E_RUNTIME_TAB_RELOAD_INJECTED",
        menuProjectionRevision: 7,
        request,
        sequence: 1
      }],
      windowsMenuCaptures: [capture]
    };
    expect(parseElectronDesktopE2eRuntimeTabReloadInspection(valid).failures)
      .toHaveLength(1);
    expect(() => parseElectronDesktopE2eRuntimeTabReloadInspection({
      ...valid,
      failures: [{ ...valid.failures[0], menuProjectionRevision: 8 }]
    })).toThrow(/failure capture is invalid/u);
    expect(() => parseElectronDesktopE2eRuntimeTabReloadInspection({
      ...valid,
      failures: [{
        ...valid.failures[0],
        request: { ...request, topologyRevision: 3 }
      }]
    })).toThrow(/failure capture is invalid/u);
  });

  it("retains a fenced AppKit failure after a later focus revision", () => {
    const current = inspection("darwin");
    current.nativeWindow.topologyRevision = 3;
    const request = {
      lifecycleEpoch: 3,
      operationId: RELOAD_OPERATION_ID,
      tabId: TAB_ID,
      topologyRevision: 2,
      type: "browserRuntimeTabReload",
      windowGeneration: 1,
      windowId: WINDOW_ID
    } as const;
    const parsed = parseElectronDesktopE2eRuntimeTabReloadInspection({
      ...current,
      failures: [{
        failureCode: "ELECTRON_DESKTOP_E2E_RUNTIME_TAB_RELOAD_INJECTED",
        menuProjectionRevision: null,
        request,
        sequence: 1
      }]
    });
    expect(parsed.failures[0]?.request.topologyRevision).toBe(2);
    expect(parsed.nativeWindow.topologyRevision).toBe(3);
  });

  it("chains a document-retained failure between committed reloads", () => {
    const request = (sequence: number) => ({
      lifecycleEpoch: 3,
      operationId: `70000000-0000-4000-8000-00000000000${sequence}`,
      tabId: TAB_ID,
      topologyRevision: 2,
      type: "browserRuntimeTabReload",
      windowGeneration: 1,
      windowId: WINDOW_ID
    } as const);
    const observation = (
      sequence: number,
      before: string,
      after: string,
      navigationSequence: number | undefined
    ) => {
      const retained = navigationSequence === undefined;
      return {
        receipt: {
          receipt: {
            completionPolicy: "eventBound",
            completionScope: "inputReady",
            lifecycleEpoch: 3,
            operationId: request(sequence).operationId,
            status: retained ? "failed" : "applied",
            subsystem: "navigation",
            tabId: TAB_ID,
            topologyRevision: 2,
            windowGeneration: 1,
            windowId: WINDOW_ID,
            ...(retained ? { failureCode: "ELECTRON_ROLE_RELOAD_NOT_APPLIED" } : {})
          },
          roles: [{
            afterDocumentInstanceId: after,
            beforeDocumentInstanceId: before,
            coreInputResumed: true,
            inputEpoch: 4,
            nativeInputResumed: true,
            ownerGeneration: 5,
            restartRequired: false,
            roleId: ROLE_ID,
            status: retained ? "failed" : "applied",
            submissionState: "submitted",
            surfaceGeneration: 6,
            ...(retained
              ? { failureCode: "ELECTRON_ROLE_RELOAD_DOCUMENT_RETAINED" }
              : { navigationSequence })
          }]
        },
        request: request(sequence),
        sequence
      };
    };
    const role = {
      audioMuted: false,
      documentInstanceId: DOCUMENT_IDS[2],
      ownerGeneration: 5,
      roleId: ROLE_ID,
      surfaceGeneration: 6,
      tabId: TAB_ID,
      visible: true
    };
    const observations = [
      observation(1, DOCUMENT_IDS[0], DOCUMENT_IDS[1], 2),
      observation(2, DOCUMENT_IDS[1], DOCUMENT_IDS[1], undefined),
      observation(3, DOCUMENT_IDS[1], DOCUMENT_IDS[2], 3)
    ];
    const valid = { ...inspection("darwin"), observations, roles: [role] };
    expect(parseElectronDesktopE2eRuntimeTabReloadInspection(valid).observations)
      .toHaveLength(3);
    expect(parseElectronDesktopE2eRuntimeTabReloadInspection({
      ...valid,
      observations: observations.slice(0, 2),
      roles: [{ ...role, documentInstanceId: DOCUMENT_IDS[1] }]
    }).observations[1]?.receipt.receipt.status).toBe("failed");

    const restartRequired = structuredClone(observations);
    restartRequired[1]!.receipt.roles[0]!.restartRequired = true;
    expect(() => parseElectronDesktopE2eRuntimeTabReloadInspection({
      ...valid,
      observations: restartRequired
    })).toThrow(
      "inspection is invalid: receipt 2 failed/ELECTRON_ROLE_RELOAD_NOT_APPLIED " +
        "roles failed/ELECTRON_ROLE_RELOAD_DOCUMENT_RETAINED/submitted/restartRequired."
    );
    const replaced = structuredClone(observations);
    replaced[1]!.receipt.roles[0]!.afterDocumentInstanceId = DOCUMENT_IDS[2];
    expect(() => parseElectronDesktopE2eRuntimeTabReloadInspection({
      ...valid,
      observations: replaced
    })).toThrow(/inspection is invalid: receipt 2/u);
    const stale = structuredClone(observations);
    Object.assign(stale[2]!.receipt.roles[0]!, { navigationSequence: 2 });
    expect(() => parseElectronDesktopE2eRuntimeTabReloadInspection({
      ...valid,
      observations: stale
    })).toThrow(/not monotonic/u);
  });
});
