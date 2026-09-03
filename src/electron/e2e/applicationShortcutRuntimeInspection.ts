import type { RuntimeWindowZoomReceiptRecord } from "../../shared/generated";

export const ELECTRON_DESKTOP_E2E_WINDOW_ZOOM_JOURNAL_CAPACITY = 32;

export interface ElectronDesktopE2eWindowZoomObservation {
  readonly receipt: Readonly<RuntimeWindowZoomReceiptRecord>;
  readonly sequence: number;
}

/** Bounded per-window E2E journal; generation changes prune without renumbering. */
export class ElectronDesktopE2eWindowZoomJournal {
  readonly #byWindow = new Map<string, ElectronDesktopE2eWindowZoomObservation[]>();
  readonly #sequenceByWindow = new Map<string, number>();

  append(receipt: RuntimeWindowZoomReceiptRecord): void {
    const nextSequence = (this.#sequenceByWindow.get(receipt.windowId) ?? 0) + 1;
    this.#sequenceByWindow.set(receipt.windowId, nextSequence);
    const retained = [...this.read(receipt.windowId, receipt.windowGeneration)];
    retained.push(Object.freeze({
      receipt: Object.freeze({ ...receipt }),
      sequence: nextSequence
    }));
    if (retained.length > ELECTRON_DESKTOP_E2E_WINDOW_ZOOM_JOURNAL_CAPACITY) {
      retained.shift();
    }
    this.#byWindow.set(receipt.windowId, retained);
  }

  read(
    windowId: string,
    windowGeneration: number
  ): readonly ElectronDesktopE2eWindowZoomObservation[] {
    const stored = this.#byWindow.get(windowId) ?? [];
    const retained = stored.filter((observation) =>
      observation.receipt.windowGeneration === windowGeneration);
    if (retained.length !== stored.length) {
      this.#byWindow.set(windowId, retained);
    }
    return Object.freeze([...retained]);
  }
}

export interface ElectronDesktopE2eApplicationShortcutRuntimeInspection {
  readonly coreWindow: Readonly<{
    activeTabId: string;
    presentation: "fullscreen" | "maximized" | "normal";
    tabIds: readonly string[];
    topologyRevision: number;
    windowGeneration: number;
    windowId: string;
    windowZoomFactor: number;
  }>;
  readonly globalWebSurfaces: readonly Readonly<{
    appliedZoomFactor: number;
    baseZoomFactor: number;
    generation: number;
    slotId: string;
    surfaceId: string;
    tabId: string;
    visible: boolean;
  }>[];
  readonly mainWindow: Readonly<{
    browserWindowId: number;
    fullscreen: boolean;
    webContentsId: number;
    zoomFactor: number;
  }>;
  readonly nativeWindow: Readonly<{
    activeTabId: string;
    appKitIdentity: Readonly<{
      launchGeneration: string;
      logicalWindowId: string;
      nativeGeneration: number;
    }> | null;
    focused: boolean;
    hostKind: "appkit-chromium" | "bundled-chromium";
    parentNativeHostId: number;
    presentation: "fullscreen" | "maximized" | "normal";
    tabIds: readonly string[];
    topologyRevision: number;
    visible: boolean;
    windowGeneration: number;
    windowId: string;
    windowZoomFactor: number;
  }>;
  /** This journey rejects live popups because their exact factor is not inspectable here. */
  readonly popupSurfaces: readonly never[];
  readonly roleSurfaces: readonly Readonly<{
    appliedZoomFactor: number;
    baseZoomFactor: number;
    generation: number;
    roleId: string;
    tabId: string;
    visible: boolean;
  }>[];
  readonly windowId: string;
  readonly zoomJournal: Readonly<{
    capacity: typeof ELECTRON_DESKTOP_E2E_WINDOW_ZOOM_JOURNAL_CAPACITY;
    journalVersion: 1;
    observations: readonly ElectronDesktopE2eWindowZoomObservation[];
  }>;
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

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function zoomFactor(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) &&
    value >= 0.25 && value <= 5;
}

function presentation(value: unknown): value is "fullscreen" | "maximized" | "normal" {
  return ["fullscreen", "maximized", "normal"].includes(String(value));
}

function identifiers(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(identifier) &&
    new Set(value).size === value.length;
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= Number.EPSILON * 16;
}

function effectiveZoom(base: number, windowFactor: number): number {
  return Math.min(5, Math.max(0.25, base * windowFactor));
}

function parseMainWindow(
  value: unknown
): value is ElectronDesktopE2eApplicationShortcutRuntimeInspection["mainWindow"] {
  return record(value) && exact(value, [
    "browserWindowId", "fullscreen", "webContentsId", "zoomFactor"
  ]) && positiveInteger(value.browserWindowId) &&
    typeof value.fullscreen === "boolean" && positiveInteger(value.webContentsId) &&
    zoomFactor(value.zoomFactor);
}

function parseCoreWindow(
  value: unknown,
  windowId: string
): value is ElectronDesktopE2eApplicationShortcutRuntimeInspection["coreWindow"] {
  return record(value) && exact(value, [
    "activeTabId", "presentation", "tabIds", "topologyRevision",
    "windowGeneration", "windowId", "windowZoomFactor"
  ]) && value.windowId === windowId && identifier(value.activeTabId) &&
    identifiers(value.tabIds) && value.tabIds.includes(value.activeTabId) &&
    presentation(value.presentation) && positiveInteger(value.topologyRevision) &&
    positiveInteger(value.windowGeneration) && zoomFactor(value.windowZoomFactor);
}

function parseAppKitIdentity(
  value: unknown,
  windowId: string
): value is NonNullable<
  ElectronDesktopE2eApplicationShortcutRuntimeInspection["nativeWindow"]["appKitIdentity"]
> {
  return record(value) && exact(value, [
    "launchGeneration", "logicalWindowId", "nativeGeneration"
  ]) && identifier(value.launchGeneration) && value.logicalWindowId === windowId &&
    positiveInteger(value.nativeGeneration);
}

function parseNativeWindow(
  value: unknown,
  windowId: string
): value is ElectronDesktopE2eApplicationShortcutRuntimeInspection["nativeWindow"] {
  if (!record(value) || !exact(value, [
    "activeTabId", "appKitIdentity", "focused", "hostKind",
    "parentNativeHostId", "presentation", "tabIds", "topologyRevision",
    "visible", "windowGeneration", "windowId", "windowZoomFactor"
  ]) || value.windowId !== windowId || !identifier(value.activeTabId) ||
      !identifiers(value.tabIds) || !value.tabIds.includes(value.activeTabId) ||
      typeof value.focused !== "boolean" ||
      !["appkit-chromium", "bundled-chromium"].includes(String(value.hostKind)) ||
      !positiveInteger(value.parentNativeHostId) || !presentation(value.presentation) ||
      !positiveInteger(value.topologyRevision) || typeof value.visible !== "boolean" ||
      !positiveInteger(value.windowGeneration) || !zoomFactor(value.windowZoomFactor)) {
    return false;
  }
  return value.hostKind === "appkit-chromium"
    ? parseAppKitIdentity(value.appKitIdentity, windowId)
    : value.appKitIdentity === null;
}

function parseRoleSurface(
  value: unknown,
  native: ElectronDesktopE2eApplicationShortcutRuntimeInspection["nativeWindow"]
): value is ElectronDesktopE2eApplicationShortcutRuntimeInspection["roleSurfaces"][number] {
  return record(value) && exact(value, [
    "appliedZoomFactor", "baseZoomFactor", "generation", "roleId", "tabId",
    "visible"
  ]) && zoomFactor(value.appliedZoomFactor) && zoomFactor(value.baseZoomFactor) &&
    positiveInteger(value.generation) && identifier(value.roleId) &&
    identifier(value.tabId) && native.tabIds.includes(value.tabId) &&
    typeof value.visible === "boolean" && nearlyEqual(
      value.appliedZoomFactor,
      effectiveZoom(value.baseZoomFactor, native.windowZoomFactor)
    );
}

function parseGlobalWebSurface(
  value: unknown,
  native: ElectronDesktopE2eApplicationShortcutRuntimeInspection["nativeWindow"]
): value is ElectronDesktopE2eApplicationShortcutRuntimeInspection[
  "globalWebSurfaces"
][number] {
  return record(value) && exact(value, [
    "appliedZoomFactor", "baseZoomFactor", "generation", "slotId", "surfaceId",
    "tabId", "visible"
  ]) && zoomFactor(value.appliedZoomFactor) && zoomFactor(value.baseZoomFactor) &&
    positiveInteger(value.generation) && identifier(value.slotId) &&
    typeof value.surfaceId === "string" && value.surfaceId.length > 0 &&
    identifier(value.tabId) && native.tabIds.includes(value.tabId) &&
    typeof value.visible === "boolean" && nearlyEqual(
      value.appliedZoomFactor,
      effectiveZoom(value.baseZoomFactor, native.windowZoomFactor)
    );
}

function parseReceipt(
  value: unknown,
  windowId: string,
  windowGeneration: number
): value is RuntimeWindowZoomReceiptRecord {
  if (!record(value)) return false;
  const requiredKeys = [
    "action", "globalWebSurfaceCount", "nextZoomFactor", "operationId",
    "popupSurfaceCount", "previousZoomFactor", "roleSurfaceCount", "status",
    "sourceTopologyRevision", "topologyRevision", "windowGeneration", "windowId"
  ];
  const keys = value.failureCode === undefined
    ? requiredKeys
    : [...requiredKeys, "failureCode"];
  return exact(value, keys) && identifier(value.operationId) &&
    value.windowId === windowId && value.windowGeneration === windowGeneration &&
    ["in", "out", "reset"].includes(String(value.action)) &&
    value.status === "applied" && value.failureCode === undefined &&
    positiveInteger(value.sourceTopologyRevision) && positiveInteger(value.topologyRevision) &&
    Number(value.topologyRevision) >= Number(value.sourceTopologyRevision) &&
    zoomFactor(value.previousZoomFactor) && zoomFactor(value.nextZoomFactor) &&
    nonNegativeInteger(value.roleSurfaceCount) &&
    nonNegativeInteger(value.globalWebSurfaceCount) &&
    nonNegativeInteger(value.popupSurfaceCount);
}

function parseZoomJournal(
  value: unknown,
  core: ElectronDesktopE2eApplicationShortcutRuntimeInspection["coreWindow"],
  native: ElectronDesktopE2eApplicationShortcutRuntimeInspection["nativeWindow"]
): value is ElectronDesktopE2eApplicationShortcutRuntimeInspection["zoomJournal"] {
  if (!record(value) || !exact(value, [
    "capacity", "journalVersion", "observations"
  ]) || value.capacity !== ELECTRON_DESKTOP_E2E_WINDOW_ZOOM_JOURNAL_CAPACITY ||
      value.journalVersion !== 1 || !Array.isArray(value.observations) ||
      value.observations.length > ELECTRON_DESKTOP_E2E_WINDOW_ZOOM_JOURNAL_CAPACITY) {
    return false;
  }
  let priorSequence = 0;
  for (const observation of value.observations) {
    if (!record(observation) || !exact(observation, ["receipt", "sequence"]) ||
        !positiveInteger(observation.sequence) ||
        (priorSequence !== 0 && Number(observation.sequence) !== priorSequence + 1) ||
        !parseReceipt(observation.receipt, core.windowId, core.windowGeneration)) {
      return false;
    }
    const receipt = observation.receipt;
    if (receipt.topologyRevision > core.topologyRevision) return false;
    priorSequence = Number(observation.sequence);
  }
  const latest = value.observations.at(-1)?.receipt;
  if (!nearlyEqual(core.windowZoomFactor, native.windowZoomFactor)) return false;
  return !latest || (
    nearlyEqual(core.windowZoomFactor, latest.nextZoomFactor) &&
    nearlyEqual(native.windowZoomFactor, latest.nextZoomFactor)
  );
}

export function parseElectronDesktopE2eApplicationShortcutRuntimeInspection(
  candidate: unknown
): ElectronDesktopE2eApplicationShortcutRuntimeInspection {
  if (!record(candidate) || !exact(candidate, [
    "coreWindow", "globalWebSurfaces", "mainWindow", "nativeWindow",
    "popupSurfaces", "roleSurfaces", "windowId", "zoomJournal"
  ]) || !identifier(candidate.windowId) || !parseMainWindow(candidate.mainWindow) ||
      !parseCoreWindow(candidate.coreWindow, candidate.windowId) ||
      !parseNativeWindow(candidate.nativeWindow, candidate.windowId) ||
      !Array.isArray(candidate.roleSurfaces) ||
      !Array.isArray(candidate.globalWebSurfaces) ||
      !Array.isArray(candidate.popupSurfaces) || candidate.popupSurfaces.length !== 0) {
    throw new Error(
      "Electron desktop E2E application-shortcut runtime inspection is invalid."
    );
  }
  const core = candidate.coreWindow;
  const native = candidate.nativeWindow;
  const roles = candidate.roleSurfaces;
  const web = candidate.globalWebSurfaces;
  if (
    core.activeTabId !== native.activeTabId ||
    core.presentation !== native.presentation ||
    core.topologyRevision !== native.topologyRevision ||
    core.windowGeneration !== native.windowGeneration ||
    !sameIds(core.tabIds, native.tabIds) ||
    !roles.every((surface) => parseRoleSurface(surface, native)) ||
    new Set(roles.map((surface) => surface.roleId)).size !== roles.length ||
    !web.every((surface) => parseGlobalWebSurface(surface, native)) ||
    new Set(web.map((surface) => surface.surfaceId)).size !== web.length ||
    !parseZoomJournal(candidate.zoomJournal, core, native)
  ) {
    throw new Error(
      "Electron desktop E2E application-shortcut runtime inspection is invalid."
    );
  }
  return candidate as unknown as ElectronDesktopE2eApplicationShortcutRuntimeInspection;
}
