import { describe, expect, it } from "vitest";
import { parseElectronDesktopE2eFullscreenToolbarInspection } from
  "../src/electron/e2e/fullscreenToolbarInspection";

const windowId = "10000000-0000-4000-8000-000000000001";
const inspection = { hostKind: "appkit", presentation: "normal", windowId,
  windowGeneration: 2, topologyRevision: 5, tabIds: [], surfaces: [], workspaceTabs: [],
  native: { windowId, windowGeneration: 2, topologyRevision: 5, projectionRevision: 7,
    alwaysShowToolbarInFullScreen: false, fullscreen: false, nativeControlsVisible: true,
    nativeWindowControlCount: 3, revealed: false, toolbarVisible: true,
    appKit: { accessoryOnScreen: true, accessoryVisibleHeight: 40, addButtonOnScreen: true,
      minimumFrameSize: { width: 640, height: 520 }, fullscreenHostReady: false,
      presentationAutoHideToolbar: false, revealLocked: false, tabCloseButtonEnabledCount: 0,
      tabStripOnScreen: true, toolbarPinned: false, visibleTrafficLightCount: 3, windowNameOnScreen: true }
  }
};

describe("AppKit actual minimum frame inspection boundary", () => {
  it("preserves the exact native NSWindow minimum in a fenced normal-window receipt", () => {
    expect(parseElectronDesktopE2eFullscreenToolbarInspection(inspection)).toEqual(inspection);
  });

  it("preserves positive fractional AppKit points without rounding or adding chrome insets", () => {
    const candidate = { ...inspection, native: { ...inspection.native,
      appKit: { ...inspection.native.appKit, minimumFrameSize: { width: 640.5, height: 520.25 } } } };
    expect(parseElectronDesktopE2eFullscreenToolbarInspection(candidate).native.appKit?.minimumFrameSize)
      .toEqual({ width: 640.5, height: 520.25 });
  });

  it.each([undefined, null, {}, { width: 640 }, { width: 0, height: 520 },
    { width: 640, height: -1 }, { width: Number.NaN, height: 520 },
    { width: 640, height: Number.POSITIVE_INFINITY }, { width: "640", height: 520 },
    { width: 640, height: 520, cached: true }])("rejects absent or malformed actual native minimum %j", minimumFrameSize => {
    const candidate = { ...inspection, native: { ...inspection.native,
      appKit: { ...inspection.native.appKit, minimumFrameSize } } };
    expect(() => parseElectronDesktopE2eFullscreenToolbarInspection(candidate)).toThrow(/minimum frame|boundary 3/u);
  });

  it.each([{ windowGeneration: 1 }, { topologyRevision: 4 }, { windowId: "another" }])(
    "rejects stale native fences even with a valid minimum %j", change => {
      expect(() => parseElectronDesktopE2eFullscreenToolbarInspection({ ...inspection,
        native: { ...inspection.native, ...change } })).toThrow("boundary 2");
    }
  );
});
