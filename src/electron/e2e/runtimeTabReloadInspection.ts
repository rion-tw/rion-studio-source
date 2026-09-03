import type {
  BrowserTabReloadReceiptRecord,
  CoreCommand
} from "../../shared/generated";
import type { WindowsRuntimeHostTabCommand } from
  "../../shared/windowsRuntimeHost";

export type ElectronDesktopE2eReloadCommand = Extract<
  CoreCommand,
  { type: "browserRuntimeTabReload" }
>;
export type ElectronDesktopE2eWindowsReloadCommand = Extract<
  WindowsRuntimeHostTabCommand,
  { type: "reloadTab" }
>;

export const ELECTRON_DESKTOP_E2E_RUNTIME_TAB_RELOAD_JOURNAL_CAPACITY = 32;

export interface ElectronDesktopE2eRuntimeTabReloadObservation {
  readonly receipt: Readonly<BrowserTabReloadReceiptRecord>;
  readonly request: Readonly<ElectronDesktopE2eReloadCommand>;
  readonly sequence: number;
}

export interface ElectronDesktopE2eRuntimeTabReloadFailure {
  readonly failureCode: "ELECTRON_DESKTOP_E2E_RUNTIME_TAB_RELOAD_INJECTED";
  readonly menuProjectionRevision: number | null;
  readonly request: Readonly<ElectronDesktopE2eReloadCommand>;
  readonly sequence: number;
}

export interface ElectronDesktopE2eRuntimeTabReloadInspection {
  readonly capacity: 32;
  readonly journalVersion: 1;
  readonly nativeWindow: Readonly<{
    appKitIdentity: Readonly<{
      launchGeneration: string;
      logicalWindowId: string;
      nativeGeneration: number;
    }> | null;
    hostKind: "appkit-chromium" | "bundled-chromium";
    parentNativeHostId: number;
    tabIds: readonly string[];
    topologyRevision: number;
    windowGeneration: number;
  }>;
  readonly failures: readonly ElectronDesktopE2eRuntimeTabReloadFailure[];
  readonly observations: readonly ElectronDesktopE2eRuntimeTabReloadObservation[];
  readonly platform: "darwin" | "win32";
  readonly popups: readonly Readonly<{
    appKitIdentity: Readonly<{
      launchGeneration: string;
      logicalWindowId: string;
      nativeGeneration: number;
    }> | null;
    hostKind: "appkit-chromium" | "bundled-chromium";
    logicalWindowId: string;
    nativeHostId: number;
    openOperationId: string;
    popupId: string;
    visible: boolean;
  }>[];
  readonly roles: readonly Readonly<{
    documentInstanceId: string;
    ownerGeneration: number;
    roleId: string;
    surfaceGeneration: number;
    tabId: string;
    visible: boolean;
  }>[];
  readonly windowId: string;
  readonly windowsMenuCaptures: readonly Readonly<
    ElectronDesktopE2eWindowsReloadCommand & { sequence: number }
  >[];
}

const IDENTIFIER =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function validReceipt(
  observation: ElectronDesktopE2eRuntimeTabReloadObservation,
  windowId: string
): boolean {
  const { receipt, request } = observation;
  const terminal = receipt.receipt;
  return request.windowId === windowId && identifier(request.operationId) &&
    identifier(request.tabId) && positiveInteger(request.windowGeneration) &&
    positiveInteger(request.topologyRevision) &&
    positiveInteger(request.lifecycleEpoch) &&
    terminal.operationId === request.operationId && terminal.status === "applied" &&
    terminal.completionPolicy === "eventBound" &&
    terminal.completionScope === "inputReady" &&
    terminal.subsystem === "navigation" && terminal.failureCode === undefined &&
    terminal.tabId === request.tabId && terminal.windowId === request.windowId &&
    terminal.windowGeneration === request.windowGeneration &&
    terminal.topologyRevision === request.topologyRevision &&
    terminal.lifecycleEpoch === request.lifecycleEpoch && receipt.roles.length > 0 &&
    receipt.roles.every((role) =>
      identifier(role.roleId) && positiveInteger(role.ownerGeneration) &&
      positiveInteger(role.inputEpoch) && positiveInteger(role.surfaceGeneration) &&
      identifier(role.beforeDocumentInstanceId) &&
      identifier(role.afterDocumentInstanceId) &&
      role.afterDocumentInstanceId !== role.beforeDocumentInstanceId &&
      positiveInteger(role.navigationSequence) && role.status === "applied" &&
      role.submissionState === "submitted" && role.nativeInputResumed &&
      role.coreInputResumed && !role.restartRequired &&
      role.failureCode === undefined
    );
}

function validAppKitIdentity(
  identity: ElectronDesktopE2eRuntimeTabReloadInspection["nativeWindow"]["appKitIdentity"],
  logicalWindowId: string
): boolean {
  return identity !== null && identity.logicalWindowId === logicalWindowId &&
    identifier(identity.launchGeneration) &&
    positiveInteger(identity.nativeGeneration);
}

export function parseElectronDesktopE2eRuntimeTabReloadInspection(
  value: unknown
): ElectronDesktopE2eRuntimeTabReloadInspection {
  if (!record(value) || value.capacity !== 32 || value.journalVersion !== 1 ||
      !identifier(value.windowId) ||
      (value.platform !== "darwin" && value.platform !== "win32") ||
      !record(value.nativeWindow) || !Array.isArray(value.failures) ||
      !Array.isArray(value.observations) ||
      !Array.isArray(value.popups) || !Array.isArray(value.roles) ||
      !Array.isArray(value.windowsMenuCaptures) ||
      value.failures.length > value.capacity ||
      value.observations.length > value.capacity ||
      value.windowsMenuCaptures.length > value.capacity) {
    throw new Error("Electron desktop E2E runtime-tab Reload inspection is invalid.");
  }
  const inspection = value as unknown as ElectronDesktopE2eRuntimeTabReloadInspection;
  const native = inspection.nativeWindow;
  const expectsAppKit = inspection.platform === "darwin";
  if (!positiveInteger(native.parentNativeHostId) ||
      !positiveInteger(native.windowGeneration) ||
      !positiveInteger(native.topologyRevision) ||
      !Array.isArray(native.tabIds) || !native.tabIds.every(identifier) ||
      native.hostKind !== (expectsAppKit
        ? "appkit-chromium"
        : "bundled-chromium") ||
      (expectsAppKit
        ? !validAppKitIdentity(native.appKitIdentity, inspection.windowId)
        : native.appKitIdentity !== null)) {
    throw new Error("Electron desktop E2E runtime-tab Reload inspection is invalid.");
  }
  if (inspection.roles.some((role) =>
    !identifier(role.roleId) || !identifier(role.tabId) ||
    !identifier(role.documentInstanceId) ||
    !positiveInteger(role.ownerGeneration) ||
    !positiveInteger(role.surfaceGeneration) || typeof role.visible !== "boolean" ||
    !native.tabIds.includes(role.tabId)
  ) || inspection.popups.some((popup) =>
    !identifier(popup.popupId) || !identifier(popup.openOperationId) ||
    popup.logicalWindowId !== `popup-${popup.popupId}` ||
    !positiveInteger(popup.nativeHostId) || typeof popup.visible !== "boolean" ||
    popup.hostKind !== (expectsAppKit
      ? "appkit-chromium"
      : "bundled-chromium") ||
    (expectsAppKit
      ? !validAppKitIdentity(popup.appKitIdentity, popup.logicalWindowId)
      : popup.appKitIdentity !== null)
  )) {
    throw new Error("Electron desktop E2E runtime-tab Reload inspection is invalid.");
  }
  if (inspection.failures.some(({ failureCode, request, sequence }, index) =>
    sequence !== index + 1 ||
    failureCode !== "ELECTRON_DESKTOP_E2E_RUNTIME_TAB_RELOAD_INJECTED" ||
    request.windowId !== inspection.windowId || !identifier(request.operationId) ||
    !identifier(request.tabId) || !native.tabIds.includes(request.tabId) ||
    request.windowGeneration !== native.windowGeneration ||
    !positiveInteger(request.topologyRevision) ||
    !positiveInteger(request.lifecycleEpoch)
  )) {
    throw new Error("Electron desktop E2E runtime-tab Reload failure is invalid.");
  }
  if (inspection.failures.some(({ menuProjectionRevision, request }) => {
    if (inspection.platform === "darwin") return menuProjectionRevision !== null;
    if (!positiveInteger(menuProjectionRevision)) return true;
    const captures = inspection.windowsMenuCaptures.filter((capture) =>
      capture.projectionRevision === menuProjectionRevision &&
      capture.tabId === request.tabId &&
      capture.windowId === request.windowId &&
      capture.windowGeneration === request.windowGeneration &&
      capture.topologyRevision === request.topologyRevision &&
      capture.lifecycleEpoch === request.lifecycleEpoch
    );
    return captures.length !== 1;
  })) {
    throw new Error("Electron desktop E2E Windows Reload failure capture is invalid.");
  }
  for (let index = 0; index < inspection.observations.length; index += 1) {
    const observation = inspection.observations[index]!;
    if (observation.sequence !== index + 1 ||
        !validReceipt(observation, inspection.windowId)) {
      throw new Error("Electron desktop E2E runtime-tab Reload inspection is invalid.");
    }
    if (index > 0) {
      const previous = inspection.observations[index - 1]!.receipt.roles;
      for (const role of observation.receipt.roles) {
        const prior = previous.find((candidate) => candidate.roleId === role.roleId);
        if (!prior || role.beforeDocumentInstanceId !== prior.afterDocumentInstanceId ||
            role.navigationSequence! <= prior.navigationSequence!) {
          throw new Error(
            "Electron desktop E2E runtime-tab Reload observations are not monotonic."
          );
        }
      }
    }
  }
  const latest = inspection.observations.at(-1);
  if (latest && latest.receipt.roles.some((receipt) => {
    const current = inspection.roles.find((role) => role.roleId === receipt.roleId);
    return !current || current.tabId !== latest.request.tabId ||
      current.ownerGeneration !== receipt.ownerGeneration ||
      current.surfaceGeneration !== receipt.surfaceGeneration ||
      current.documentInstanceId !== receipt.afterDocumentInstanceId;
  })) {
    throw new Error("Electron desktop E2E runtime-tab Reload owner is stale.");
  }
  if (inspection.windowsMenuCaptures.some((capture, index) =>
    capture.sequence !== index + 1 || capture.windowId !== inspection.windowId ||
    !identifier(capture.tabId) || !positiveInteger(capture.projectionRevision) ||
    !positiveInteger(capture.windowGeneration) ||
    !positiveInteger(capture.topologyRevision) ||
    !positiveInteger(capture.lifecycleEpoch)
  )) {
    throw new Error("Electron desktop E2E Windows Reload capture is invalid.");
  }
  return inspection;
}
