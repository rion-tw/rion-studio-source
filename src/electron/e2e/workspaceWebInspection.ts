const WORKSPACE_WEB_CHROME_SHELL_SESSION =
  "rion-web-chrome-shell:memory" as const;

export interface ElectronDesktopE2eWorkspaceWebInspection {
  readonly appKitIdentity: Readonly<{
    launchGeneration: string;
    logicalWindowId: string;
    nativeGeneration: number;
  }> | null;
  readonly attemptGeneration: string;
  readonly coreSlots: readonly Readonly<{
    id: string;
    rect: Readonly<{ height: number; width: number; x: number; y: number }>;
    roleId: string | null;
    web: Readonly<{ name: string; startUrl: string }> | null;
  }>[];
  readonly focused: boolean;
  readonly hostKind: "appkit-chromium" | "bundled-chromium";
  readonly parentNativeHostId: number;
  readonly phase: "activating" | "attaching" | "degraded" | "dormant" |
    "failed" | "loading" | "ready";
  readonly popups: readonly Readonly<{
    appKitIdentity: Readonly<{
      launchGeneration: string;
      logicalWindowId: string;
      nativeGeneration: number;
    }> | null;
    bounds: Readonly<{ height: number; width: number; x: number; y: number }>;
    hostKind: "appkit-chromium" | "bundled-chromium";
    logicalWindowId: string;
    nativeHostId: number;
    openOperationId: string;
    popupId: string;
    presentation: "fullscreen" | "maximized" | "normal";
    topologyRevision: number;
    visible: boolean;
    windowGeneration: number;
  }>[];
  readonly presentation: "fullscreen" | "maximized" | "normal";
  readonly role: Readonly<{
    bounds: Readonly<{ height: number; width: number; x: number; y: number }>;
    generation: number;
    roleId: string;
    visible: boolean;
  }> | null;
  readonly tabId: string;
  readonly topologyRevision: number;
  readonly visible: boolean;
  readonly web: Readonly<{
    canGoBack: boolean;
    canGoForward: boolean;
    chromeBounds: Readonly<{ height: number; width: number; x: number; y: number }>;
    chromeVisible: boolean;
    chromeShellSession: typeof WORKSPACE_WEB_CHROME_SHELL_SESSION;
    chromeShellStoragePath: null;
    chromeShellUrl: string;
    contentBounds: Readonly<{ height: number; width: number; x: number; y: number }>;
    contentVisible: boolean;
    contentProfilePath: string;
    contentSession: "global-web-persistent";
    contentSessionStoragePath: string;
    contentUrl: string;
    containedFullscreen: boolean;
    containedFullscreenRevision: number;
    generation: number;
    isolatedSessions: true;
    slotBounds: Readonly<{ height: number; width: number; x: number; y: number }>;
    slotId: string;
    surfaceId: string;
    tabId: string;
    visible: boolean;
  }>;
  readonly windowBounds: Readonly<{
    height: number;
    width: number;
    x: number;
    y: number;
  }>;
  readonly windowGeneration: number;
  readonly windowId: string;
}

const IDENTIFIER =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function slotIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    value === value.trim();
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function bounds(value: unknown): value is ElectronDesktopE2eWorkspaceWebInspection["web"]["slotBounds"] {
  if (!record(value) || !exact(value, ["height", "width", "x", "y"])) return false;
  return [value.height, value.width, value.x, value.y].every(Number.isSafeInteger) &&
    Number(value.height) > 0 && Number(value.width) > 0 &&
    Number(value.x) >= 0 && Number(value.y) >= 0;
}

function nativeBounds(
  value: unknown
): value is ElectronDesktopE2eWorkspaceWebInspection["windowBounds"] {
  return record(value) && exact(value, ["height", "width", "x", "y"]) &&
    [value.height, value.width, value.x, value.y].every(Number.isSafeInteger) &&
    Number(value.height) > 0 && Number(value.width) > 0;
}

function sameBounds(
  left: ElectronDesktopE2eWorkspaceWebInspection["web"]["slotBounds"],
  right: ElectronDesktopE2eWorkspaceWebInspection["web"]["slotBounds"]
): boolean {
  return left.x === right.x && left.y === right.y &&
    left.width === right.width && left.height === right.height;
}

function canonicalUrl(value: unknown, protocols: readonly string[]): value is string {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return protocols.includes(parsed.protocol) && parsed.href === value &&
      parsed.username === "" && parsed.password === "";
  } catch {
    return false;
  }
}

function globalWebPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    return false;
  }
  return value.replaceAll("\\", "/").toLowerCase()
    .endsWith("/web-profiles/global-web/chromium");
}

function normalizedRect(value: unknown): value is Readonly<{
  height: number;
  width: number;
  x: number;
  y: number;
}> {
  if (!record(value) || !exact(value, ["height", "width", "x", "y"])) return false;
  const coordinates = [value.height, value.width, value.x, value.y];
  return coordinates.every((item) => typeof item === "number" && Number.isFinite(item)) &&
    Number(value.height) > 0 && Number(value.width) > 0 &&
    Number(value.x) >= 0 && Number(value.y) >= 0 &&
    Number(value.x) + Number(value.width) <= 1.000_001 &&
    Number(value.y) + Number(value.height) <= 1.000_001;
}

function coreSlot(value: unknown): value is ElectronDesktopE2eWorkspaceWebInspection["coreSlots"][number] {
  if (!record(value) || !exact(value, ["id", "rect", "roleId", "web"]) ||
      !slotIdentifier(value.id) || !normalizedRect(value.rect) ||
      (value.roleId !== null && !identifier(value.roleId))) {
    return false;
  }
  const validWeb = value.web === null || (
    record(value.web) && exact(value.web, ["name", "startUrl"]) &&
    typeof value.web.name === "string" && value.web.name.length > 0 &&
    canonicalUrl(value.web.startUrl, ["http:", "https:"])
  );
  return validWeb && (value.roleId === null) !== (value.web === null);
}

function appKitIdentity(
  value: unknown,
  windowId: string,
  attemptGeneration: string
): value is NonNullable<ElectronDesktopE2eWorkspaceWebInspection["appKitIdentity"]> {
  return record(value) && exact(value, [
    "launchGeneration", "logicalWindowId", "nativeGeneration"
  ]) && value.launchGeneration === attemptGeneration &&
    value.logicalWindowId === windowId && positiveInteger(value.nativeGeneration);
}

function roleSurface(
  value: unknown,
  slots: ElectronDesktopE2eWorkspaceWebInspection["coreSlots"]
): value is NonNullable<ElectronDesktopE2eWorkspaceWebInspection["role"]> {
  if (!record(value) || !exact(value, [
    "bounds", "generation", "roleId", "visible"
  ]) || !bounds(value.bounds) || !positiveInteger(value.generation) ||
      !identifier(value.roleId) || typeof value.visible !== "boolean") {
    return false;
  }
  return slots.some((slot) => slot.roleId === value.roleId && slot.web === null);
}

function popup(
  value: unknown,
  platform: "appkit-chromium" | "bundled-chromium"
): value is ElectronDesktopE2eWorkspaceWebInspection["popups"][number] {
  if (!record(value) || !exact(value, [
    "appKitIdentity", "bounds", "hostKind", "logicalWindowId", "nativeHostId",
    "openOperationId", "popupId", "presentation", "topologyRevision",
    "visible", "windowGeneration"
  ]) || !nativeBounds(value.bounds) || value.hostKind !== platform ||
      !positiveInteger(value.nativeHostId) || !identifier(value.openOperationId) ||
      !identifier(value.popupId) ||
      value.logicalWindowId !== `popup-${value.popupId}` ||
      !["fullscreen", "maximized", "normal"].includes(String(value.presentation)) ||
      !positiveInteger(value.topologyRevision) || typeof value.visible !== "boolean" ||
      !positiveInteger(value.windowGeneration)) {
    return false;
  }
  return platform === "appkit-chromium"
    ? appKitIdentity(value.appKitIdentity, value.logicalWindowId, value.openOperationId)
    : value.appKitIdentity === null;
}

function workspaceWeb(
  value: unknown,
  tabId: string,
  slots: ElectronDesktopE2eWorkspaceWebInspection["coreSlots"]
): value is ElectronDesktopE2eWorkspaceWebInspection["web"] {
  if (!record(value) || !exact(value, [
    "canGoBack", "canGoForward", "chromeBounds", "chromeShellSession",
    "chromeShellStoragePath", "chromeShellUrl", "chromeVisible", "contentBounds",
    "contentVisible",
    "contentProfilePath", "contentSession", "contentSessionStoragePath",
    "contentUrl", "containedFullscreen", "containedFullscreenRevision",
    "generation", "isolatedSessions", "slotBounds", "slotId", "surfaceId",
    "tabId", "visible"
  ]) || typeof value.canGoBack !== "boolean" ||
      typeof value.canGoForward !== "boolean" || !bounds(value.chromeBounds) ||
      typeof value.chromeVisible !== "boolean" ||
      value.chromeShellSession !== WORKSPACE_WEB_CHROME_SHELL_SESSION ||
      value.chromeShellStoragePath !== null ||
      !canonicalUrl(value.chromeShellUrl, ["file:"]) ||
      !value.chromeShellUrl.endsWith("/runtime-web-chrome-electron.html") ||
      !bounds(value.contentBounds) || typeof value.contentVisible !== "boolean" ||
      !globalWebPath(value.contentProfilePath) ||
      value.contentSession !== "global-web-persistent" ||
      value.contentSessionStoragePath !== value.contentProfilePath ||
      !canonicalUrl(value.contentUrl, ["http:", "https:"]) ||
      typeof value.containedFullscreen !== "boolean" ||
      !Number.isSafeInteger(value.containedFullscreenRevision) ||
      Number(value.containedFullscreenRevision) < 0 ||
      !positiveInteger(value.generation) || value.isolatedSessions !== true ||
      !bounds(value.slotBounds) || !slotIdentifier(value.slotId) ||
      typeof value.surfaceId !== "string" ||
      !new RegExp(`^web-${tabId}-[1-9][0-9]*$`, "u").test(value.surfaceId) ||
      value.tabId !== tabId ||
      typeof value.visible !== "boolean") {
    return false;
  }
  const chrome = value.chromeBounds;
  const content = value.contentBounds;
  const slot = value.slotBounds;
  const configured = slots.find((candidate) => candidate.id === value.slotId);
  const exactProjection = value.containedFullscreen
    ? !value.chromeVisible && value.contentVisible === value.visible &&
      sameBounds(content, slot)
    : value.chromeVisible === value.visible &&
      value.contentVisible === value.visible &&
      content.x === slot.x && content.width === slot.width &&
      content.y === chrome.y + chrome.height &&
      content.height + chrome.height === slot.height;
  return configured?.web !== null && configured?.web !== undefined && exactProjection &&
    chrome.x === slot.x && chrome.y === slot.y && chrome.width === slot.width &&
      (!value.containedFullscreen || Number(value.containedFullscreenRevision) > 0);
}

export function parseElectronDesktopE2eWorkspaceWebInspection(
  candidate: unknown
): ElectronDesktopE2eWorkspaceWebInspection {
  if (!record(candidate) || !exact(candidate, [
    "appKitIdentity", "attemptGeneration", "coreSlots", "focused", "hostKind",
    "parentNativeHostId", "phase", "popups", "presentation", "role", "tabId",
    "topologyRevision", "visible", "web", "windowBounds", "windowGeneration",
    "windowId"
  ]) || !identifier(candidate.attemptGeneration) || !identifier(candidate.tabId) ||
      !identifier(candidate.windowId) || !Array.isArray(candidate.coreSlots) ||
      candidate.coreSlots.length < 1 || candidate.coreSlots.length > 2 ||
      !candidate.coreSlots.every(coreSlot) ||
      new Set(candidate.coreSlots.map((slot) => slot.id)).size !==
        candidate.coreSlots.length ||
      candidate.coreSlots.filter((slot) => slot.web !== null).length !== 1 ||
      candidate.coreSlots.filter((slot) => slot.roleId !== null).length > 1 ||
      typeof candidate.focused !== "boolean" ||
      !positiveInteger(candidate.parentNativeHostId) ||
      !["activating", "attaching", "degraded", "dormant", "failed", "loading",
        "ready"].includes(String(candidate.phase)) ||
      !Array.isArray(candidate.popups) ||
      !["fullscreen", "maximized", "normal"].includes(String(candidate.presentation)) ||
      !positiveInteger(candidate.topologyRevision) || typeof candidate.visible !== "boolean" ||
      !nativeBounds(candidate.windowBounds) ||
      !positiveInteger(candidate.windowGeneration) ||
      !workspaceWeb(candidate.web, candidate.tabId, candidate.coreSlots)) {
    throw new Error("Electron desktop E2E Workspace Web inspection is invalid.");
  }
  const roleSlotCount = candidate.coreSlots.filter(
    (slot) => slot.roleId !== null
  ).length;
  if (
    (roleSlotCount === 0 && candidate.role !== null) ||
    (roleSlotCount === 1 && !roleSurface(candidate.role, candidate.coreSlots))
  ) {
    throw new Error("Electron desktop E2E Workspace Web inspection is invalid.");
  }
  if (candidate.hostKind === "appkit-chromium") {
    if (!appKitIdentity(
      candidate.appKitIdentity,
      candidate.windowId,
      candidate.attemptGeneration
    )) {
      throw new Error("Electron desktop E2E Workspace Web inspection is invalid.");
    }
  } else if (candidate.hostKind !== "bundled-chromium" ||
      candidate.appKitIdentity !== null) {
    throw new Error("Electron desktop E2E Workspace Web inspection is invalid.");
  }
  const hostKind = candidate.hostKind as
    "appkit-chromium" | "bundled-chromium";
  const invalidPopup = candidate.popups.find((value) => !popup(value, hostKind));
  if (invalidPopup !== undefined) {
    throw new Error(
      "Electron desktop E2E Workspace Web inspection has an invalid popup: " +
      JSON.stringify(invalidPopup)
    );
  }
  return candidate as unknown as ElectronDesktopE2eWorkspaceWebInspection;
}
