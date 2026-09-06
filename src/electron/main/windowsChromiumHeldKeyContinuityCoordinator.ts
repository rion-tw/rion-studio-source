import { randomUUID } from "node:crypto";

import type {
  WindowsChromiumHeldKeyContinuityInputInternal,
  WindowsChromiumHeldKeyContinuityReceiptInternal
} from "../core/coreAddonClient";
import { RionBridgeError } from "../ipc/errors";
import type { ChromiumRoleOverlayFrameIdentity } from
  "./chromiumRoleSurfaceRegistry";
import type {
  WindowsChromiumInputPresentationEvent,
  WindowsChromiumInputSurfaceAttachmentCoordinator
} from "./windowsChromiumInputSurfaceAttachmentCoordinator";

interface HeldKeyContinuitySurfaceIdentity {
  readonly roleId: string;
  readonly tabId: string;
  readonly surfaceGeneration: number;
  readonly documentInstanceId: string;
  readonly ownerGeneration: number;
}

interface HeldKeyContinuityCorePort {
  restoreWindowsChromiumHeldKeysInternal: (
    input: WindowsChromiumHeldKeyContinuityInputInternal
  ) => Promise<WindowsChromiumHeldKeyContinuityReceiptInternal>;
}

interface HeldKeyContinuitySurfacePort {
  currentOverlayFrame: (
    roleId: string,
    generation: number
  ) => ChromiumRoleOverlayFrameIdentity;
}

function continuityError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function sameFrame(
  left: ChromiumRoleOverlayFrameIdentity,
  right: ChromiumRoleOverlayFrameIdentity
): boolean {
  return left.roleId === right.roleId && left.generation === right.generation &&
    left.frame === right.frame && left.frameToken === right.frameToken &&
    left.documentInstanceId === right.documentInstanceId;
}

function parseBlurPayload(payload: unknown): number {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw continuityError(
      "ELECTRON_WINDOWS_HELD_CONTINUITY_OBSERVATION_INVALID",
      "The Windows held-key continuity observation is invalid."
    );
  }
  const record = payload as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "reason,revision" ||
    record.reason !== "blur" || !Number.isSafeInteger(record.revision) ||
    (record.revision as number) < 1) {
    throw continuityError(
      "ELECTRON_WINDOWS_HELD_CONTINUITY_OBSERVATION_INVALID",
      "The Windows held-key continuity observation is invalid."
    );
  }
  return record.revision as number;
}

/**
 * Joins authenticated page blur and exact child-host hide events to Core's
 * held-key owner. Per-role ordering is EventBound; each replay then uses the
 * Core-issued BrowserAction deadline and private trusted DOM receipt lane.
 */
export class WindowsChromiumHeldKeyContinuityCoordinator {
  readonly #core: HeldKeyContinuityCorePort;
  readonly #surfaces: HeldKeyContinuitySurfacePort;
  readonly #resolveIdentity: (
    identity: ChromiumRoleOverlayFrameIdentity
  ) => HeldKeyContinuitySurfaceIdentity;
  readonly #onError: (error: RionBridgeError) => void;
  readonly #createOperationId: () => string;
  readonly #tails = new Map<string, Promise<void>>();
  readonly #hiddenRevisionByRole = new Map<string, number>();
  readonly #unsubscribePresentation: () => void;
  #disposed = false;

  constructor(input: Readonly<{
    core: HeldKeyContinuityCorePort;
    surfaces: HeldKeyContinuitySurfacePort;
    attachments: Pick<WindowsChromiumInputSurfaceAttachmentCoordinator, "subscribePresentation">;
    resolveIdentity: (
      identity: ChromiumRoleOverlayFrameIdentity
    ) => HeldKeyContinuitySurfaceIdentity;
    onError: (error: RionBridgeError) => void;
    createOperationId?: () => string;
  }>) {
    this.#core = input.core;
    this.#surfaces = input.surfaces;
    this.#resolveIdentity = input.resolveIdentity;
    this.#onError = input.onError;
    this.#createOperationId = input.createOperationId ?? randomUUID;
    this.#unsubscribePresentation = input.attachments.subscribePresentation(
      (event) => this.#observePresentation(event)
    );
  }

  async observeBlur(
    identity: ChromiumRoleOverlayFrameIdentity,
    payload: unknown
  ): Promise<WindowsChromiumHeldKeyContinuityReceiptInternal> {
    if (this.#disposed) {
      return Promise.reject(continuityError(
        "ELECTRON_WINDOWS_HELD_CONTINUITY_DISPOSED",
        "The Windows held-key continuity coordinator is disposed."
      ));
    }
    const revision = parseBlurPayload(payload);
    return this.#enqueue(identity.roleId, () =>
      this.#dispatch(identity, "blur", revision));
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribePresentation();
    this.#hiddenRevisionByRole.clear();
  }

  #observePresentation(event: WindowsChromiumInputPresentationEvent): void {
    if (this.#disposed || event.visible || !event.previousVisible) return;
    const revision = (this.#hiddenRevisionByRole.get(event.roleId) ?? 0) + 1;
    this.#hiddenRevisionByRole.set(event.roleId, revision);
    void this.#enqueue(event.roleId, async () => {
      const identity = this.#surfaces.currentOverlayFrame(
        event.roleId,
        event.surfaceGeneration
      );
      await this.#dispatch(identity, "hidden", revision);
    }).catch((error) => this.#onError(error instanceof RionBridgeError
      ? error
      : continuityError(
        "ELECTRON_WINDOWS_HELD_CONTINUITY_FAILED",
        "The hidden Windows Role surface could not restore held keys."
      )));
  }

  #enqueue<Value>(roleId: string, operation: () => Promise<Value>): Promise<Value> {
    const previous = this.#tails.get(roleId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.#tails.set(roleId, tail);
    void tail.finally(() => {
      if (this.#tails.get(roleId) === tail) this.#tails.delete(roleId);
    });
    return result;
  }

  async #dispatch(
    observed: ChromiumRoleOverlayFrameIdentity,
    lossReason: "blur" | "hidden",
    lossRevision: number
  ): Promise<WindowsChromiumHeldKeyContinuityReceiptInternal> {
    if (this.#disposed) {
      throw continuityError(
        "ELECTRON_WINDOWS_HELD_CONTINUITY_DISPOSED",
        "The Windows held-key continuity coordinator is disposed."
      );
    }
    const current = this.#surfaces.currentOverlayFrame(
      observed.roleId,
      observed.generation
    );
    if (!sameFrame(current, observed)) {
      throw continuityError(
        "BROWSER_ACTION_STALE",
        "The Chromium Role document changed before held-key continuity admission."
      );
    }
    const surface = this.#resolveIdentity(current);
    const operationId = this.#createOperationId();
    if (typeof operationId !== "string" || operationId.length < 1 ||
      operationId.length > 256 || operationId.trim() !== operationId) {
      throw continuityError(
        "ELECTRON_WINDOWS_HELD_CONTINUITY_OPERATION_INVALID",
        "The Windows held-key continuity operation identity is invalid."
      );
    }
    return this.#core.restoreWindowsChromiumHeldKeysInternal(Object.freeze({
      operationId,
      roleId: surface.roleId,
      tabId: surface.tabId,
      expectedOwnerGeneration: surface.ownerGeneration,
      surfaceGeneration: surface.surfaceGeneration,
      documentInstanceId: surface.documentInstanceId,
      lossReason,
      lossRevision
    }));
  }
}
