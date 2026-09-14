import type { CoreEvent } from "../../shared/generated";
import type { ElectronCoreCommandPort } from "./coreApiDispatcher";
import type { ElectronCoreEffectPort } from "./coreEffectCoordinator";
import { normalizeRionBridgeError, RionBridgeError } from "../ipc/errors";
import { recordRuntimeTransition } from "./runtimeOperationJournal";

export type RuntimeTabCloseCorePort = ElectronCoreCommandPort & Partial<Pick<
  ElectronCoreEffectPort, "subscribeCoreEvents" | "subscribeCoreEventStreamFailures"
>>;

/** Core retains cleanup ownership after the exact topology receipt completes the UI action. */
export async function admitRuntimeTabClose(core: RuntimeTabCloseCorePort,
  expected: { operationId: string; tabId: string; windowId: string; windowGeneration: number; topologyRevision: number },
  invoke: () => Promise<unknown>): Promise<number> {
  if (!core.subscribeCoreEvents) { await invoke(); return expected.topologyRevision; }
  let resolve!: (revision: number) => void;
  let reject!: (error: unknown) => void;
  let accepted = false;
  const admission = new Promise<number>((yes, no) => { resolve = yes; reject = no; });
  const observe = (stage: string, errorCode?: string) => recordRuntimeTransition({
    operationId: expected.operationId, action: "tabClose", targetKind: "tab", targetId: expected.tabId,
    fences: expected, stage, ...(errorCode ? { errorCode } : {})
  });
  const unsubscribe = core.subscribeCoreEvents((event: CoreEvent) => {
    if (event.type === "shutdown") reject(new RionBridgeError({
      code: "ELECTRON_TAB_CLOSE_ACTOR_STOPPED", message: "Core stopped before accepting tab close." }));
    if (event.type !== "runtimeTabTopologyCommitted" || event.operationId !== expected.operationId) return;
    if (event.tabId !== expected.tabId || event.windowId !== expected.windowId ||
      event.windowGeneration !== expected.windowGeneration || event.topologyRevision <= expected.topologyRevision) {
      reject(new RionBridgeError({ code: "ELECTRON_TAB_CLOSE_RECEIPT_STALE", message: "The tab close receipt lost its exact topology fence." }));
      return;
    }
    accepted = true;
    observe("topology-committed");
    resolve(event.topologyRevision);
  });
  const unsubscribeFailure = core.subscribeCoreEventStreamFailures?.(failure => reject(new RionBridgeError(failure.error)));
  observe("accepted");
  // EventBound: the existing command is retained until exact release/failure, never retried.
  void Promise.resolve().then(invoke).then(() => {
    observe("released");
    if (!accepted) resolve(expected.topologyRevision);
  }, error => {
    observe("cleanup-failed", normalizeRionBridgeError(error).code);
    reject(error);
  });
  try { return await admission; }
  finally { unsubscribe(); unsubscribeFailure?.(); }
}
