export interface ElectronDesktopE2eFullscreenToolbarInspection {
  readonly nativeWindowHandle?: string;
  readonly hostKind: "appkit" | "windows";
  readonly native: Readonly<{
    alwaysShowToolbarInFullScreen: boolean;
    appKit?: Readonly<{
      accessoryOnScreen: boolean;
      accessoryVisibleHeight: number;
      fullscreenHostReady: boolean;
      presentationAutoHideToolbar: boolean;
      revealLocked: boolean;
      tabCloseButtonEnabledCount: number;
      fullscreenControlScreenBounds?: Readonly<{
        height: number;
        width: number;
        x: number;
        y: number;
      }>;
      tabScreenBounds?: Readonly<{
        height: number;
        width: number;
        x: number;
        y: number;
      }>;
      tabAnchors?: Readonly<Record<string, Readonly<{ x: number; y: number }>>>;
      tabStripOnScreen: boolean;
      toolbarPinned: boolean;
      visibleTrafficLightCount: number;
    }>;
    fullscreen: boolean;
    nativeControlsVisible: boolean;
    nativeWindowControlCount: number;
    projectionRevision: number;
    revealed: boolean;
    toolbarVisible: boolean;
    topologyRevision: number;
    windowGeneration: number;
    windowId: string;
  }>;
  readonly presentation: "fullscreen" | "maximized" | "normal";
  readonly surfaces: readonly Readonly<{
    bounds: Readonly<{ x: number; y: number; width: number; height: number }>;
    generation: number;
    id: string;
    kind: "role" | "web";
    tabId: string;
    visible: boolean;
  }>[];
  readonly tabIds: readonly string[];
  readonly topologyRevision: number;
  readonly windowGeneration: number;
  readonly windowId: string;
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function positive(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

export function parseElectronDesktopE2eFullscreenToolbarInspection(
  candidate: unknown
): ElectronDesktopE2eFullscreenToolbarInspection {
  if (!record(candidate) || !exact(candidate, [
    "hostKind", "native", "presentation", "surfaces", "tabIds",
    "topologyRevision", "windowGeneration", "windowId",
    ...("nativeWindowHandle" in candidate ? ["nativeWindowHandle"] : [])
  ]) || !ID.test(String(candidate.windowId)) ||
    !new Set(["appkit", "windows"]).has(String(candidate.hostKind)) ||
    !new Set(["fullscreen", "maximized", "normal"]).has(
      String(candidate.presentation)
    ) || !positive(candidate.windowGeneration) ||
    !positive(candidate.topologyRevision) || !Array.isArray(candidate.tabIds) ||
    candidate.tabIds.some((id) => !ID.test(String(id))) ||
    new Set(candidate.tabIds).size !== candidate.tabIds.length ||
    !Array.isArray(candidate.surfaces) || !record(candidate.native)) {
    throw new Error("Electron desktop E2E fullscreen-toolbar inspection is invalid.");
  }
  if ("nativeWindowHandle" in candidate &&
      (candidate.hostKind !== "windows" || typeof candidate.nativeWindowHandle !== "string" ||
        !/^[1-9]\d*$/u.test(candidate.nativeWindowHandle))) {
    throw new Error("Electron desktop E2E native fullscreen window handle is invalid.");
  }
  const native = candidate.native;
  const commonKeys = [
    "alwaysShowToolbarInFullScreen", "fullscreen", "nativeControlsVisible",
    "nativeWindowControlCount", "projectionRevision", "revealed",
    "toolbarVisible", "topologyRevision", "windowGeneration", "windowId"
  ];
  const hasAppKit = candidate.hostKind === "appkit";
  if (!exact(native, hasAppKit ? [...commonKeys, "appKit"] : commonKeys) ||
    native.windowId !== candidate.windowId ||
    native.windowGeneration !== candidate.windowGeneration ||
    native.topologyRevision !== candidate.topologyRevision ||
    !positive(native.projectionRevision) ||
    !Number.isSafeInteger(native.nativeWindowControlCount) ||
    Number(native.nativeWindowControlCount) < 0 ||
    Number(native.nativeWindowControlCount) > 3 ||
    native.nativeControlsVisible !== (Number(native.nativeWindowControlCount) > 0) ||
    native.fullscreen !== (candidate.presentation === "fullscreen") ||
    ["alwaysShowToolbarInFullScreen", "fullscreen", "nativeControlsVisible",
      "revealed", "toolbarVisible"].some(
      (key) => typeof native[key] !== "boolean"
    )) {
    throw new Error("Electron desktop E2E fullscreen-toolbar inspection is invalid.");
  }
  if (hasAppKit) {
    const appKit = native.appKit;
    const appKitKeys = [
      "accessoryOnScreen", "accessoryVisibleHeight", "fullscreenHostReady",
      "presentationAutoHideToolbar", "revealLocked",
      "tabCloseButtonEnabledCount", "tabStripOnScreen", "toolbarPinned",
      "visibleTrafficLightCount"
    ];
    const hasTabScreenBounds = record(appKit) && "tabScreenBounds" in appKit;
    const hasFullscreenControlBounds = record(appKit) &&
      "fullscreenControlScreenBounds" in appKit;
    const hasTabAnchors = record(appKit) && "tabAnchors" in appKit;
    const geometryKeys = [
      ...(hasTabScreenBounds ? ["tabScreenBounds"] : []),
      ...(hasFullscreenControlBounds ? ["fullscreenControlScreenBounds"] : []),
      ...(hasTabAnchors ? ["tabAnchors"] : [])
    ];
    if (!record(appKit) || !exact(appKit, [...appKitKeys, ...geometryKeys]) ||
      !Number.isFinite(appKit.accessoryVisibleHeight) ||
      Number(appKit.accessoryVisibleHeight) < 0 ||
      !Number.isSafeInteger(appKit.visibleTrafficLightCount) ||
      Number(appKit.visibleTrafficLightCount) < 0 ||
      Number(appKit.visibleTrafficLightCount) > 3 ||
      !Number.isSafeInteger(appKit.tabCloseButtonEnabledCount) ||
      Number(appKit.tabCloseButtonEnabledCount) < 0 ||
      ["accessoryOnScreen", "fullscreenHostReady",
        "presentationAutoHideToolbar", "revealLocked", "tabStripOnScreen",
        "toolbarPinned"].some((key) => typeof appKit[key] !== "boolean") ||
      native.toolbarVisible !== (
        appKit.accessoryOnScreen && appKit.tabStripOnScreen
      ) || native.nativeWindowControlCount !== appKit.visibleTrafficLightCount) {
      throw new Error("Electron desktop E2E fullscreen-toolbar inspection is invalid.");
    }
    if (hasTabScreenBounds) {
      const bounds = appKit.tabScreenBounds;
      if (!record(bounds) || !exact(bounds, ["height", "width", "x", "y"]) ||
          ![bounds.height, bounds.width, bounds.x, bounds.y].every(Number.isFinite) ||
          Number(bounds.width) <= 0 || Number(bounds.height) <= 0) {
        throw new Error("Electron desktop E2E fullscreen-toolbar inspection is invalid.");
      }
    }
    if (hasFullscreenControlBounds) {
      const bounds = appKit.fullscreenControlScreenBounds;
      if (!record(bounds) || !exact(bounds, ["height", "width", "x", "y"]) ||
          ![bounds.height, bounds.width, bounds.x, bounds.y].every(Number.isFinite) ||
          Number(bounds.width) <= 0 || Number(bounds.height) <= 0) {
        throw new Error("Electron desktop E2E fullscreen-toolbar inspection is invalid.");
      }
    }
    if (hasTabAnchors) {
      const anchors = appKit.tabAnchors;
      let previousTabIndex = -1;
      if (!record(anchors) || Object.keys(anchors).some((tabId) => {
            const tabIndex = (candidate.tabIds as string[]).indexOf(tabId);
            const anchor = anchors[tabId];
            if (tabIndex <= previousTabIndex) return true;
            previousTabIndex = tabIndex;
            return !record(anchor) || !exact(anchor, ["x", "y"]) ||
              !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y) ||
              Number(anchor.x) < 0 || Number(anchor.y) < 0;
          })) {
        throw new Error("Electron desktop E2E fullscreen-toolbar inspection is invalid.");
      }
    }
  } else if (![0, 3].includes(Number(native.nativeWindowControlCount))) {
    throw new Error("Electron desktop E2E fullscreen-toolbar inspection is invalid.");
  }
  const surfaceIds = new Set<string>();
  for (const surface of candidate.surfaces) {
    const surfaceId = record(surface) ? String(surface.id) : "";
    const surfaceTabId = record(surface) ? String(surface.tabId) : "";
    const surfaceKind = record(surface) ? String(surface.kind) : "";
    const validSurfaceId = surfaceKind === "role"
      ? ID.test(surfaceId)
      : surfaceKind === "web" &&
        new RegExp(`^web-${surfaceTabId}-[1-9][0-9]*$`, "u").test(surfaceId);
    if (!record(surface) || !exact(surface, [
      "bounds", "generation", "id", "kind", "tabId", "visible"
    ]) || !validSurfaceId || !ID.test(surfaceTabId) ||
      !candidate.tabIds.includes(surfaceTabId) || !positive(surface.generation) ||
      !new Set(["role", "web"]).has(surfaceKind) ||
      typeof surface.visible !== "boolean" || !record(surface.bounds) ||
      !exact(surface.bounds, ["height", "width", "x", "y"]) ||
      ![surface.bounds.x, surface.bounds.y, surface.bounds.width,
        surface.bounds.height].every(Number.isSafeInteger) ||
      Number(surface.bounds.width) < 1 || Number(surface.bounds.height) < 1) {
      throw new Error("Electron desktop E2E fullscreen-toolbar inspection is invalid.");
    }
    if (surfaceIds.has(surfaceId)) {
      throw new Error("Electron desktop E2E fullscreen-toolbar inspection is invalid.");
    }
    surfaceIds.add(surfaceId);
  }
  return candidate as unknown as ElectronDesktopE2eFullscreenToolbarInspection;
}
