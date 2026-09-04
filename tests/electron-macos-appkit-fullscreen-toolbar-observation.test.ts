import { describe, expect, it, vi } from "vitest";

import { readMacosAppKitFullscreenToolbar } from
  "../src/electron/main/macosAppKitFullscreenToolbarObservation";

const identity = Object.freeze({
  launchGeneration: "10000000-0000-4000-8000-000000000001",
  logicalWindowId: "20000000-0000-4000-8000-000000000001",
  nativeGeneration: 3
});
const tabId = "30000000-0000-4000-8000-000000000001";

function state() {
  return {
    accessoryOnScreen: true,
    accessoryVisibleHeight: 40,
    alwaysHideTabCloseButton: false,
    alwaysShowInFullScreen: false,
    fullscreen: true,
    fullscreenHostReady: true,
    presentationAutoHideToolbar: true,
    revealLocked: false,
    tabCloseButtonEnabledCount: 1,
    tabStripOnScreen: true,
    toolbarPinned: false,
    valid: true,
    visibleTrafficLightCount: 3
  };
}

function titlebarGeometry() {
  return {
    rootMinX: 100,
    rootWidth: 960,
    tabMinX: 184,
    tabMinY: 704,
    tabMaxX: 952,
    tabMaxY: 740,
    windowNameMaxX: 920,
    trafficLightsMaxX: 172,
    fullscreenControlMinX: 150,
    fullscreenControlMinY: 706,
    fullscreenControlWidth: 14,
    fullscreenControlHeight: 14,
    titleHidden: true,
    valid: true
  };
}

describe("retained AppKit fullscreen-toolbar observation", () => {
  it("derives revealed native controls only from the exact AppKit readback", () => {
    expect(readMacosAppKitFullscreenToolbar({
      identity,
      nativeFullscreen: true,
      nativeProjectionRevision: 8,
      read: (expected) => {
        expect(expected).toBe(identity);
        return state();
      },
      topologyRevision: 7,
      windowGeneration: 2
    })).toEqual(expect.objectContaining({
      alwaysShowToolbarInFullScreen: false,
      fullscreen: true,
      nativeControlsVisible: true,
      nativeWindowControlCount: 3,
      projectionRevision: 8,
      revealed: true,
      toolbarVisible: true,
      topologyRevision: 7,
      windowGeneration: 2,
      windowId: identity.logicalWindowId
    }));
  });

  it("projects valid native titlebar screen geometry into immutable tab bounds", () => {
    const observation = readMacosAppKitFullscreenToolbar({
      identity,
      nativeFullscreen: true,
      nativeProjectionRevision: 8,
      read: () => state(),
      readTitlebarGeometry: (expected) => {
        expect(expected).toBe(identity);
        return titlebarGeometry();
      },
      readTabAnchor: (expected, expectedTabId) => {
        expect(expected).toBe(identity);
        expect(expectedTabId).toBe(tabId);
        return { x: 420, y: 18 };
      },
      tabIds: [tabId],
      topologyRevision: 7,
      windowGeneration: 2
    });

    expect(observation.appKit?.tabScreenBounds).toEqual({
      height: 36,
      width: 768,
      x: 184,
      y: 704
    });
    expect(observation.appKit?.fullscreenControlScreenBounds).toEqual({
      height: 14,
      width: 14,
      x: 150,
      y: 706
    });
    expect(Object.isFrozen(observation.appKit?.tabScreenBounds)).toBe(true);
    expect(observation.appKit?.tabAnchors).toEqual({
      [tabId]: { x: 420, y: 18 }
    });
    expect(Object.isFrozen(observation.appKit?.tabAnchors?.[tabId])).toBe(true);
  });

  it("omits tab screen bounds when the optional titlebar observer is unavailable", () => {
    const observation = readMacosAppKitFullscreenToolbar({
      identity,
      nativeFullscreen: true,
      nativeProjectionRevision: 8,
      read: () => state(),
      topologyRevision: 7,
      windowGeneration: 2
    });

    expect(observation.appKit).not.toHaveProperty("tabScreenBounds");
  });

  it("keeps normal presentation observable while AppKit tears down fullscreen chrome", () => {
    const observation = readMacosAppKitFullscreenToolbar({
      identity,
      nativeFullscreen: false,
      nativeProjectionRevision: 9,
      read: () => ({ ...state(), fullscreen: false }),
      readTitlebarGeometry: () => {
        throw new Error("InvalidLayout");
      },
      topologyRevision: 8,
      windowGeneration: 2
    });

    expect(observation.fullscreen).toBe(false);
    expect(observation.appKit).not.toHaveProperty("tabScreenBounds");
  });

  it("preserves strict geometry failures while fullscreen remains active", () => {
    expect(() => readMacosAppKitFullscreenToolbar({
      identity,
      nativeFullscreen: true,
      nativeProjectionRevision: 9,
      read: () => state(),
      readTitlebarGeometry: () => {
        throw new Error("InvalidLayout");
      },
      topologyRevision: 8,
      windowGeneration: 2
    })).toThrowError("InvalidLayout");
  });

  it("omits unavailable screen geometry while fullscreen chrome is off screen", () => {
    const readTitlebarGeometry = vi.fn(() => {
      throw new Error("InvalidLayout");
    });
    const readTabAnchor = vi.fn(() => {
      throw new Error("InvalidLayout");
    });
    const observation = readMacosAppKitFullscreenToolbar({
      identity,
      nativeFullscreen: true,
      nativeProjectionRevision: 9,
      read: () => ({
        ...state(),
        accessoryOnScreen: false,
        tabStripOnScreen: false,
        visibleTrafficLightCount: 0
      }),
      readTitlebarGeometry,
      readTabAnchor,
      tabIds: [tabId],
      topologyRevision: 8,
      windowGeneration: 2
    });

    expect(readTitlebarGeometry).not.toHaveBeenCalled();
    expect(readTabAnchor).not.toHaveBeenCalled();
    expect(observation.toolbarVisible).toBe(false);
    expect(observation.appKit).not.toHaveProperty("tabScreenBounds");
    expect(observation.appKit).not.toHaveProperty("tabAnchors");
  });

  it.each([
    ["an invalid native marker", { valid: false }],
    ["a visible native title", { titleHidden: false }],
    ["a non-positive root width", { rootWidth: 0 }],
    ["a non-positive tab width", { tabMaxX: 184 }],
    ["a non-positive tab height", { tabMaxY: 704 }],
    ["traffic-light overlap", { tabMinX: 171 }],
    ["a tab outside the titlebar root", { tabMaxX: 1_061 }],
    ["a non-finite coordinate", { tabMinY: Number.NaN }]
  ])("fails closed when titlebar geometry contains %s", (_label, override) => {
    expect(() => readMacosAppKitFullscreenToolbar({
      identity,
      nativeFullscreen: true,
      nativeProjectionRevision: 8,
      read: () => state(),
      readTitlebarGeometry: () => ({ ...titlebarGeometry(), ...override }),
      topologyRevision: 7,
      windowGeneration: 2
    })).toThrowError(expect.objectContaining({
      code: "ELECTRON_MACOS_APPKIT_TITLEBAR_GEOMETRY_INVALID"
    }));
  });

  it("fails closed when desktop-E2E native evidence is absent or malformed", () => {
    expect(() => readMacosAppKitFullscreenToolbar({
      identity,
      nativeFullscreen: false,
      nativeProjectionRevision: 1,
      topologyRevision: 1,
      windowGeneration: 1
    })).toThrowError(expect.objectContaining({
      code: "ELECTRON_MACOS_APPKIT_FULLSCREEN_OBSERVATION_UNAVAILABLE"
    }));
    expect(() => readMacosAppKitFullscreenToolbar({
      identity,
      nativeFullscreen: true,
      nativeProjectionRevision: 1,
      read: () => ({ ...state(), visibleTrafficLightCount: 4 }),
      topologyRevision: 1,
      windowGeneration: 1
    })).toThrowError(expect.objectContaining({
      code: "ELECTRON_MACOS_APPKIT_FULLSCREEN_OBSERVATION_INVALID"
    }));
  });
});
