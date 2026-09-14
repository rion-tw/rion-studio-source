import type { CoreEffectRequest } from "../../shared/generated";

interface RuntimeOperationObservation {
  capturedAt: string;
  sequence: number;
  operationId: string;
  effectId?: string;
  action: string;
  targetKind: string;
  targetId: string;
  parentOperationId?: string;
  stage: string;
  errorCode?: string;
  fences?: Readonly<Record<string, string | number>>;
}

const CAPACITY = 512;
const observations: RuntimeOperationObservation[] = [];
let sequence = 0;
let sink: ((entry: RuntimeOperationObservation) => void) | undefined;

export function setRuntimeOperationJournalSink(next: typeof sink): void { sink = next; }

/** Identity-only bounded evidence. No URLs, page data, or effect payloads. */
export function observeRuntimeEffect(effect: CoreEffectRequest, stage: string, errorCode?: string): void {
  recordRuntimeTransition({
    operationId: effect.operationId, effectId: effect.effectId,
    action: effect.action.type, targetKind: effect.target.kind,
    targetId: effect.target.handleId, parentOperationId: effect.parentOperationId,
    fences: effectIdentityFences(effect.action),
    stage, ...(errorCode ? { errorCode } : {})
  });
}

export function recordRuntimeTransition(observation: Omit<RuntimeOperationObservation, "capturedAt" | "sequence">): void {
  const entry = { ...observation, capturedAt: new Date().toISOString(), sequence: ++sequence };
  observations.push(entry);
  if (observations.length > CAPACITY) observations.shift();
  // Diagnostics must never affect effect admission or completion.
  try { sink?.(entry); } catch { /* The bounded in-memory evidence survives. */ }
}

export function runtimeOperationEvidence() {
  return { capacity: CAPACITY, droppedCount: Math.max(0, sequence - CAPACITY),
    entries: observations.map(entry => ({ ...entry })) };
}

function effectIdentityFences(action: CoreEffectRequest["action"]): Record<string, string | number> {
  const result: Record<string, string | number> = {};
  const keys = ["eventId", "windowId", "logicalWindowId", "nativeGeneration", "launchGeneration", "adapterSequence",
    "tabId", "roleId", "surfaceId", "slotId", "generation",
    "windowGeneration", "topologyRevision", "attemptGeneration", "activationAttemptId", "revision", "lifecycleEpoch"];
  const capture = (value: object, prefix = ""): void => {
    for (const [key, field] of Object.entries(value)) {
      if (keys.includes(key) && (typeof field === "string" || typeof field === "number")) result[prefix + key] = field;
    }
  };
  capture(action);
  if ("tab" in action && action.tab && typeof action.tab === "object") {
    capture(action.tab); capture(action.tab.target, "target.");
  }
  if ("windows" in action && Array.isArray(action.windows)) {
    action.windows.forEach((window, index) => capture(window, `windows.${index}.`));
  }
  if (action.type === "embeddedApplyAppKitProjection") {
    action.projection.windows.forEach((window, index) => {
      capture(window, `windows.${index}.`); capture(window.identity, `windows.${index}.identity.`);
    });
  }
  return result;
}
