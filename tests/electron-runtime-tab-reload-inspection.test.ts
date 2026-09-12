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
      appKitIdentity: appKit ? appKitIdentity(POPUP_WINDOW_ID) : null,
      hostKind: appKit ? "appkit-chromium" : "bundled-chromium",
      logicalWindowId: POPUP_WINDOW_ID,
      nativeHostId: 42,
      openOperationId: OPEN_OPERATION_ID,
      popupId: POPUP_ID,
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
        appKitIdentity: null,
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
});
