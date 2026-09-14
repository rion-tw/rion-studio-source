import { randomUUID } from "node:crypto";
import type { BrowserLaunchAdmissionRecord } from "../../shared/generated";
import { normalizeRionBridgeError } from "../ipc/errors";
import { recordRuntimeTransition } from "./runtimeOperationJournal";
import type { RuntimeScopedQueue } from "./runtimeScopedQueue";

export function recordLaunchAdmission(admission: BrowserLaunchAdmissionRecord, requestId?: string, windowId?: string): void {
  recordRuntimeTransition({ operationId: admission.operationId, parentOperationId: requestId,
    action: "launch", targetKind: "tab", targetId: admission.tabId,
    stage: "core-accepted", fences: { tabId: admission.tabId, attemptId: admission.attemptId, ...(windowId ? { windowId } : {}) } });
}

export function runRecordedLaunch<T>(queue: RuntimeScopedQueue, scopes: readonly string[],
  task: (requestId: string) => Promise<T>): Promise<T> {
  const requestId = randomUUID();
  const observe = (stage: string, errorCode?: string) => recordRuntimeTransition({
    operationId: requestId, action: "launch-admission", targetKind: "scope",
    targetId: scopes[0] ?? "admission", fences: { scopes: scopes.join(",") },
    stage, ...(errorCode ? { errorCode } : {})
  });
  observe("queued");
  return queue.run(scopes, async () => {
    observe("resolving-destination");
    return task(requestId);
  }).then(result => { observe("completed"); return result; }, error => {
    observe("failed", normalizeRionBridgeError(error).code);
    throw error;
  });
}
