import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";

import type {
  BrowserTabReloadReceiptRecord,
  CoreCommand,
  CoreCommandResult
} from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";

export interface ControlledRuntimeTabReloadFence {
  readonly lifecycleEpoch: number;
  readonly tabId: string;
  readonly topologyRevision: number;
  readonly windowGeneration: number;
  readonly windowId: string;
}

interface ControlledRuntimeTabReloadCorePort {
  invoke: <Command extends CoreCommand>(
    command: Command
  ) => Promise<CoreCommandResult<Command>>;
}

function reloadError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function validIdentifier(value: string): boolean {
  return value.length > 0 && Buffer.byteLength(value, "utf8") <= 256 &&
    value === value.trim() && [...value].every((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint > 0x1f && codePoint !== 0x7f;
    });
}

function validFence(fence: ControlledRuntimeTabReloadFence): boolean {
  return validIdentifier(fence.tabId) && validIdentifier(fence.windowId) &&
    Number.isSafeInteger(fence.windowGeneration) && fence.windowGeneration >= 1 &&
    Number.isSafeInteger(fence.topologyRevision) && fence.topologyRevision >= 1 &&
    Number.isSafeInteger(fence.lifecycleEpoch) && fence.lifecycleEpoch >= 1;
}

/**
 * Submits one exact native-menu fence to Core without refreshing any field.
 * Only Core's EventBound input-ready receipt is accepted as success.
 */
export async function executeControlledRuntimeTabReload(
  core: ControlledRuntimeTabReloadCorePort,
  fence: ControlledRuntimeTabReloadFence
): Promise<BrowserTabReloadReceiptRecord> {
  if (!validFence(fence)) {
    throw reloadError(
      "ELECTRON_RUNTIME_TAB_RELOAD_FENCE_INVALID",
      "The visible Reload command omitted its exact native source fence."
    );
  }
  const operationId = randomUUID();
  const receipt = await core.invoke({
    type: "browserRuntimeTabReload",
    operationId,
    tabId: fence.tabId,
    windowId: fence.windowId,
    windowGeneration: fence.windowGeneration,
    topologyRevision: fence.topologyRevision,
    lifecycleEpoch: fence.lifecycleEpoch
  });
  const terminal = receipt.receipt;
  if (
    terminal.operationId !== operationId || terminal.status !== "applied" ||
    terminal.completionPolicy !== "eventBound" ||
    terminal.completionScope !== "inputReady" ||
    terminal.subsystem !== "navigation" || terminal.tabId !== fence.tabId ||
    terminal.windowId !== fence.windowId ||
    terminal.windowGeneration !== fence.windowGeneration ||
    terminal.topologyRevision !== fence.topologyRevision ||
    terminal.lifecycleEpoch !== fence.lifecycleEpoch ||
    terminal.failureCode !== undefined || receipt.roles.length < 1 ||
    receipt.roles.some((role) =>
      role.status !== "applied" || role.submissionState !== "submitted" ||
      !role.nativeInputResumed || !role.coreInputResumed ||
      role.restartRequired || role.failureCode !== undefined ||
      !role.afterDocumentInstanceId ||
      role.afterDocumentInstanceId === role.beforeDocumentInstanceId ||
      !Number.isSafeInteger(role.navigationSequence) ||
      (role.navigationSequence ?? 0) < 1
    )
  ) {
    throw reloadError(
      terminal.failureCode ?? "ELECTRON_RUNTIME_TAB_RELOAD_NOT_APPLIED",
      "Core did not terminalize the exact controlled Reload at input-ready."
    );
  }
  const roles = receipt.roles.map((role) => Object.freeze({ ...role }));
  Object.freeze(roles);
  return Object.freeze({
    receipt: Object.freeze({ ...terminal }),
    roles
  });
}
