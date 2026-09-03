import type { AppKitRuntimeHostIdentityRecord } from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";
import type { ChromiumRuntimeFullscreenToolbarObservation } from
  "./chromiumRuntimeFullscreenToolbar";
import type { RawAppKitDesktopE2ETitlebarGeometry } from
  "./macosAppKitRuntimePorts";
import type { RawAppKitDesktopE2ETabAnchor } from
  "./macosAppKitRuntimePorts";

export interface RawAppKitFullscreenToolbarState {
  readonly accessoryVisibleHeight: number;
  readonly alwaysHideTabCloseButton: boolean;
  readonly alwaysShowInFullScreen: boolean;
  readonly accessoryOnScreen: boolean;
  readonly fullscreen: boolean;
  readonly fullscreenHostReady: boolean;
  readonly presentationAutoHideToolbar: boolean;
  readonly revealLocked: boolean;
  readonly tabStripOnScreen: boolean;
  readonly toolbarPinned: boolean;
  readonly tabCloseButtonEnabledCount: number;
  readonly visibleTrafficLightCount: number;
  readonly valid: boolean;
}

function observationError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

export function readMacosAppKitFullscreenToolbar(input: Readonly<{
  identity: AppKitRuntimeHostIdentityRecord;
  nativeFullscreen: boolean;
  nativeProjectionRevision: number;
  read?: (
    expected: AppKitRuntimeHostIdentityRecord
  ) => RawAppKitFullscreenToolbarState;
  readTitlebarGeometry?: (
    expected: AppKitRuntimeHostIdentityRecord
  ) => RawAppKitDesktopE2ETitlebarGeometry;
  readTabAnchor?: (
    expected: AppKitRuntimeHostIdentityRecord,
    tabId: string
  ) => RawAppKitDesktopE2ETabAnchor;
  tabIds?: readonly string[];
  topologyRevision: number;
  windowGeneration: number;
}>): ChromiumRuntimeFullscreenToolbarObservation {
  if (!input.read) {
    throw observationError(
      "ELECTRON_MACOS_APPKIT_FULLSCREEN_OBSERVATION_UNAVAILABLE",
      "The AppKit fullscreen-toolbar observer is available only in desktop E2E builds."
    );
  }
  const state = input.read(input.identity);
  if (
    !state.valid || !Number.isFinite(state.accessoryVisibleHeight) ||
    state.accessoryVisibleHeight < 0 ||
    !Number.isSafeInteger(state.tabCloseButtonEnabledCount) ||
    !Number.isSafeInteger(state.visibleTrafficLightCount) ||
    state.visibleTrafficLightCount < 0 || state.visibleTrafficLightCount > 3
  ) {
    throw observationError(
      "ELECTRON_MACOS_APPKIT_FULLSCREEN_OBSERVATION_INVALID",
      "The AppKit fullscreen-toolbar observer returned malformed native evidence."
    );
  }
  const toolbarVisible = state.accessoryOnScreen && state.tabStripOnScreen;
  let geometry: RawAppKitDesktopE2ETitlebarGeometry | undefined;
  if (!state.fullscreen || state.fullscreenHostReady) {
    try {
      geometry = input.readTitlebarGeometry?.(input.identity);
    } catch (error) {
      // AppKit tears the NSToolbarFullScreenWindow down before all rehosted
      // titlebar views regain a normal-window owner. BaseWindow presentation
      // readback is already authoritative; settled fullscreen remains strict.
      if (input.nativeFullscreen) throw error;
    }
  }
  if (geometry && (
    !geometry.valid || !geometry.titleHidden ||
    ![
      geometry.rootMinX, geometry.rootWidth, geometry.tabMinX,
      geometry.tabMinY, geometry.tabMaxX, geometry.tabMaxY,
      geometry.windowNameMaxX, geometry.trafficLightsMaxX,
      geometry.fullscreenControlMinX, geometry.fullscreenControlMinY,
      geometry.fullscreenControlWidth, geometry.fullscreenControlHeight
    ].every(Number.isFinite) || geometry.rootWidth <= 0 ||
    geometry.tabMaxX <= geometry.tabMinX ||
    geometry.tabMaxY <= geometry.tabMinY ||
    geometry.tabMinX < geometry.trafficLightsMaxX ||
    geometry.tabMaxX > geometry.rootMinX + geometry.rootWidth ||
    geometry.fullscreenControlWidth <= 0 || geometry.fullscreenControlHeight <= 0
  )) {
    throw observationError(
      "ELECTRON_MACOS_APPKIT_TITLEBAR_GEOMETRY_INVALID",
      "The AppKit titlebar observer returned malformed native screen geometry."
    );
  }
  const tabAnchors = input.readTabAnchor && input.tabIds
    ? Object.fromEntries(input.tabIds.map((tabId) => {
        const anchor = input.readTabAnchor!(input.identity, tabId);
        if (!Number.isFinite(anchor.x) || !Number.isFinite(anchor.y) ||
            anchor.x < 0 || anchor.y < 0) {
          throw observationError(
            "ELECTRON_MACOS_APPKIT_TAB_ANCHOR_INVALID",
            "The AppKit tab anchor observer returned malformed native geometry."
          );
        }
        return [tabId, Object.freeze({ x: anchor.x, y: anchor.y })];
      }))
    : undefined;
  return Object.freeze({
    alwaysShowToolbarInFullScreen: state.alwaysShowInFullScreen,
    fullscreen: input.nativeFullscreen,
    nativeControlsVisible: state.visibleTrafficLightCount === 3,
    nativeWindowControlCount: state.visibleTrafficLightCount,
    projectionRevision: input.nativeProjectionRevision,
    revealed: input.nativeFullscreen &&
      !state.alwaysShowInFullScreen && toolbarVisible,
    toolbarVisible,
    topologyRevision: input.topologyRevision,
    windowGeneration: input.windowGeneration,
    windowId: input.identity.logicalWindowId,
    appKit: Object.freeze({
      accessoryOnScreen: state.accessoryOnScreen,
      accessoryVisibleHeight: state.accessoryVisibleHeight,
      fullscreenHostReady: state.fullscreenHostReady,
      presentationAutoHideToolbar: state.presentationAutoHideToolbar,
      revealLocked: state.revealLocked,
      tabCloseButtonEnabledCount: state.tabCloseButtonEnabledCount,
      ...(geometry
        ? {
            fullscreenControlScreenBounds: Object.freeze({
              height: geometry.fullscreenControlHeight,
              width: geometry.fullscreenControlWidth,
              x: geometry.fullscreenControlMinX,
              y: geometry.fullscreenControlMinY
            }),
            tabScreenBounds: Object.freeze({
              height: geometry.tabMaxY - geometry.tabMinY,
              width: geometry.tabMaxX - geometry.tabMinX,
              x: geometry.tabMinX,
              y: geometry.tabMinY
            })
          }
        : {}),
      ...(tabAnchors ? { tabAnchors: Object.freeze(tabAnchors) } : {}),
      tabStripOnScreen: state.tabStripOnScreen,
      toolbarPinned: state.toolbarPinned,
      visibleTrafficLightCount: state.visibleTrafficLightCount
    })
  });
}
