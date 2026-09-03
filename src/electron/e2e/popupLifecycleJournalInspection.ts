import type {
  ChromiumPopupCloseReason,
  ChromiumPopupLifecycleActionRecord,
  ChromiumPopupLifecyclePhase,
  ChromiumPopupOwnerKind,
  SystemRuntimeOperationCompletionScope,
  SystemRuntimeOperationStatus
} from "../../shared/generated";

export interface ElectronDesktopE2ePopupParentFenceInspection {
  readonly ownerKind: ChromiumPopupOwnerKind;
  readonly ownerId: string;
  readonly ownerNativeGeneration: number;
  readonly parentAppkitIdentity: Readonly<{
    launchGeneration: string;
    logicalWindowId: string;
    nativeGeneration: number;
  }> | null;
  readonly parentAttemptGeneration: string;
  readonly parentNativeHostId: number;
  readonly parentTabId: string;
  readonly parentTopologyRevision: number;
  readonly parentWindowGeneration: number;
  readonly parentWindowId: string;
  readonly roleOwnerGeneration: number | null;
  readonly slotId: string | null;
}

export interface ElectronDesktopE2ePopupLifecycleObservation {
  readonly action: ChromiumPopupLifecycleActionRecord["type"];
  readonly closeNative: boolean;
  readonly closeReason: ChromiumPopupCloseReason | null;
  readonly completionScope: SystemRuntimeOperationCompletionScope;
  readonly eventId: string;
  readonly failureCode: string | null;
  readonly lifecycleRevision: number;
  readonly lifecycleTerminal: boolean;
  readonly openOperationId: string;
  readonly operationId: string;
  readonly operationTerminal: boolean;
  readonly parent: ElectronDesktopE2ePopupParentFenceInspection;
  readonly phase: ChromiumPopupLifecyclePhase;
  readonly popupId: string;
  readonly sequence: number;
  readonly status: SystemRuntimeOperationStatus;
  readonly terminalReason: string | null;
}

export interface ElectronDesktopE2ePopupLifecycleJournalInspection {
  readonly capacity: 256;
  readonly journalVersion: 1;
  readonly observations: readonly ElectronDesktopE2ePopupLifecycleObservation[];
  readonly windowId: string;
}

const IDENTIFIER =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const FAILURE_CODE = /^[A-Z][A-Z0-9_]{0,159}$/u;
const ACTIONS = new Set<ChromiumPopupLifecycleActionRecord["type"]>([
  "cancelled", "closeRequested", "failed", "nativeClosed", "nativeReady", "pageReady"
]);
const CLOSE_REASONS = new Set<ChromiumPopupCloseReason>([
  "applicationShutdown", "loadFailed", "navigationRejected", "parentRetired", "user"
]);
const COMPLETION_SCOPES = new Set<SystemRuntimeOperationCompletionScope>([
  "dragCommitted", "inputReady", "lifecycleTransition", "nativeAcknowledgement",
  "nativeDestroyed", "nativeSubmission", "pageFinished", "policyDecision", "runtimeProbe",
  "stateCommit", "topologyCommitted"
]);
const PHASES = new Set<ChromiumPopupLifecyclePhase>([
  "admitted", "cancelled", "closed", "closing", "failed", "indeterminate", "nativeReady",
  "ready"
]);
const STATUSES = new Set<SystemRuntimeOperationStatus>([
  "applied", "cancelled", "degraded", "failed", "indeterminate", "superseded"
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => key in value);
}

function boundedString(value: unknown, maximum = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    value.trim() === value;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function parentFence(value: unknown, windowId: string): boolean {
  if (!record(value) || !exact(value, [
    "ownerId", "ownerKind", "ownerNativeGeneration", "parentAppkitIdentity",
    "parentAttemptGeneration", "parentNativeHostId", "parentTabId",
    "parentTopologyRevision", "parentWindowGeneration", "parentWindowId",
    "roleOwnerGeneration", "slotId"
  ]) || !new Set(["globalWeb", "role"]).has(String(value.ownerKind)) ||
      !boundedString(value.ownerId) || !positiveInteger(value.ownerNativeGeneration) ||
      !boundedString(value.parentAttemptGeneration) ||
      !positiveInteger(value.parentNativeHostId) ||
      typeof value.parentTabId !== "string" || !IDENTIFIER.test(value.parentTabId) ||
      !positiveInteger(value.parentTopologyRevision) ||
      !positiveInteger(value.parentWindowGeneration) ||
      value.parentWindowId !== windowId) {
    return false;
  }
  if (value.ownerKind === "role") {
    if (!IDENTIFIER.test(value.ownerId) || value.slotId !== null ||
        !positiveInteger(value.roleOwnerGeneration)) return false;
  } else if (!boundedString(value.slotId) || value.roleOwnerGeneration !== null) {
    return false;
  }
  if (value.parentAppkitIdentity === null) return true;
  const identity = value.parentAppkitIdentity;
  return record(identity) && exact(identity, [
    "launchGeneration", "logicalWindowId", "nativeGeneration"
  ]) && boundedString(identity.launchGeneration) && identity.logicalWindowId === windowId &&
    positiveInteger(identity.nativeGeneration);
}

function validObservation(value: unknown, windowId: string, priorSequence: number): boolean {
  if (!record(value) || !exact(value, [
    "action", "closeNative", "closeReason", "completionScope", "eventId", "failureCode",
    "lifecycleRevision", "lifecycleTerminal", "openOperationId", "operationId",
    "operationTerminal", "parent", "phase", "popupId", "sequence", "status",
    "terminalReason"
  ]) || !ACTIONS.has(value.action as ChromiumPopupLifecycleActionRecord["type"]) ||
      typeof value.closeNative !== "boolean" ||
      !(value.closeReason === null || CLOSE_REASONS.has(value.closeReason as ChromiumPopupCloseReason)) ||
      !COMPLETION_SCOPES.has(value.completionScope as SystemRuntimeOperationCompletionScope) ||
      typeof value.eventId !== "string" || !IDENTIFIER.test(value.eventId) ||
      !(value.failureCode === null || (
        typeof value.failureCode === "string" && FAILURE_CODE.test(value.failureCode)
      )) || !positiveInteger(value.lifecycleRevision) ||
      typeof value.lifecycleTerminal !== "boolean" ||
      typeof value.openOperationId !== "string" || !IDENTIFIER.test(value.openOperationId) ||
      typeof value.operationId !== "string" || !IDENTIFIER.test(value.operationId) ||
      typeof value.operationTerminal !== "boolean" ||
      !parentFence(value.parent, windowId) ||
      !PHASES.has(value.phase as ChromiumPopupLifecyclePhase) ||
      typeof value.popupId !== "string" || !IDENTIFIER.test(value.popupId) ||
      !positiveInteger(value.sequence) || value.sequence <= priorSequence ||
      !STATUSES.has(value.status as SystemRuntimeOperationStatus) ||
      !(value.terminalReason === null || boundedString(value.terminalReason, 160))) {
    return false;
  }
  if (value.lifecycleTerminal && !value.operationTerminal) return false;
  if (value.operationTerminal !== (value.terminalReason !== null)) return false;
  return value.action !== "nativeClosed" || !value.lifecycleTerminal ||
    value.completionScope === "nativeDestroyed";
}

export function parseElectronDesktopE2ePopupLifecycleJournalInspection(
  value: unknown
): ElectronDesktopE2ePopupLifecycleJournalInspection {
  if (!record(value) || !exact(value, [
    "capacity", "journalVersion", "observations", "windowId"
  ]) || value.capacity !== 256 || value.journalVersion !== 1 ||
      typeof value.windowId !== "string" || !IDENTIFIER.test(value.windowId) ||
      !Array.isArray(value.observations) || value.observations.length > value.capacity) {
    throw new Error("Electron desktop E2E popup lifecycle journal is invalid.");
  }
  let priorSequence = 0;
  const popupFences = new Map<string, string>();
  for (const observation of value.observations) {
    if (!validObservation(observation, value.windowId, priorSequence)) {
      throw new Error("Electron desktop E2E popup lifecycle journal is invalid.");
    }
    const current = observation as unknown as ElectronDesktopE2ePopupLifecycleObservation;
    priorSequence = current.sequence;
    const fence = JSON.stringify({
      openOperationId: current.openOperationId,
      parent: current.parent
    });
    const prior = popupFences.get(current.popupId);
    if (prior !== undefined && prior !== fence) {
      throw new Error("Electron desktop E2E popup lifecycle journal is invalid.");
    }
    popupFences.set(current.popupId, fence);
  }
  return value as unknown as ElectronDesktopE2ePopupLifecycleJournalInspection;
}
