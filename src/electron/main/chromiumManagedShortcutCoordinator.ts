import { randomUUID } from "node:crypto";

import type {
  ManagedShortcutPhaseReceiptRecord,
  ManagedShortcutSurfaceRetirementReceiptRecord
} from "../../shared/generated";
import { normalizeRionBridgeError, RionBridgeError } from "../ipc/errors";
import type {
  ChromiumRoleOverlayFrameIdentity,
  ChromiumRoleOverlayLifecycleEvent
} from
  "./chromiumRoleSurfaceRegistry";

type ManagedShortcutPhase = "replay" | "keyDown" | "keyUp";

interface ManagedShortcutRequest {
  readonly code: string;
  readonly macroId: string;
  readonly modifierCodes: readonly string[];
  readonly phase: ManagedShortcutPhase;
  readonly pressId: string;
}

export interface ChromiumManagedShortcutSurfaceIdentity {
  readonly roleId: string;
  readonly tabId: string;
  readonly surfaceGeneration: number;
  readonly documentInstanceId: string;
  readonly ownerGeneration: number;
}

type ManagedShortcutDispatch = (
  input: Readonly<{
    operationId: string;
    surface: ChromiumManagedShortcutSurfaceIdentity;
    request: ManagedShortcutRequest;
  }>
) => Promise<ManagedShortcutPhaseReceiptRecord>;

type ManagedShortcutSurfaceResolver = (
  identity: ChromiumRoleOverlayFrameIdentity,
  phase: ManagedShortcutPhase
) => ChromiumManagedShortcutSurfaceIdentity;

interface ActiveManagedShortcut {
  readonly code: string;
  readonly documentInstanceId: string;
  readonly macroId: string;
  readonly pressId: string;
  readonly roleId: string;
  readonly surfaceGeneration: number;
  state: "provisional" | "held" | "uncertain";
}

interface ManagedShortcutDocumentReplacementFence {
  readonly documentInstanceId: string;
  readonly operationId: string;
  readonly surfaceGeneration: number;
}

type ManagedShortcutSurfaceRetire = (input: Readonly<{
  roleId: string;
  surfaceGeneration: number;
  documentInstanceId: string;
}>) => Promise<ManagedShortcutSurfaceRetirementReceiptRecord>;

function shortcutError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function identifier(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    value.trim() === value && ![...value].some((character) =>
      character.codePointAt(0)! <= 0x1f
    );
}

function parseRequest(raw: unknown): ManagedShortcutRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw shortcutError(
      "ELECTRON_MANAGED_SHORTCUT_INVALID",
      "The managed shortcut request is invalid."
    );
  }
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = ["code", "macroId", "modifierCodes", "phase", "pressId"].sort();
  const allowedModifiers = new Set([
    "AltLeft", "AltRight", "ControlLeft", "ControlRight",
    "MetaLeft", "MetaRight", "ShiftLeft", "ShiftRight"
  ]);
  if (keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    !identifier(record.code, 64) || !identifier(record.macroId, 256) ||
    !identifier(record.pressId, 160) ||
    !(record.phase === "replay" || record.phase === "keyDown" ||
      record.phase === "keyUp") ||
    !Array.isArray(record.modifierCodes) || record.modifierCodes.length > 4 ||
    new Set(record.modifierCodes).size !== record.modifierCodes.length ||
    record.modifierCodes.some((code) =>
      typeof code !== "string" || !allowedModifiers.has(code)
    )) {
    throw shortcutError(
      "ELECTRON_MANAGED_SHORTCUT_INVALID",
      "The managed shortcut request fields are invalid."
    );
  }
  return Object.freeze({
    code: record.code,
    macroId: record.macroId,
    modifierCodes: Object.freeze([...record.modifierCodes]) as readonly string[],
    phase: record.phase,
    pressId: record.pressId
  });
}

function exactReceipt(
  receipt: ManagedShortcutPhaseReceiptRecord,
  operationId: string,
  surface: ChromiumManagedShortcutSurfaceIdentity,
  request: ManagedShortcutRequest
): boolean {
  return receipt.operationId === operationId &&
    receipt.roleId === surface.roleId && receipt.tabId === surface.tabId &&
    receipt.surfaceGeneration === surface.surfaceGeneration &&
    receipt.documentInstanceId === surface.documentInstanceId &&
    receipt.expectedOwnerGeneration === surface.ownerGeneration &&
    receipt.pressId === request.pressId && receipt.macroId === request.macroId &&
    receipt.code === request.code && receipt.phase === request.phase &&
    Array.isArray(receipt.requestIds) && (
      receipt.status === "superseded"
        ? receipt.requestIds.length === 0
        : receipt.requestIds.length === 1 && identifier(receipt.requestIds[0], 256)
    );
}

/** Routes one authenticated physical shortcut phase through Core-owned
 * admission/scheduling. Chromium supplies only the live non-serializable
 * main-frame identity and never converts an observation into success. */
export class ChromiumManagedShortcutCoordinator {
  readonly #dispatch: ManagedShortcutDispatch;
  readonly #resolveSurface: ManagedShortcutSurfaceResolver;
  readonly #createOperationId: () => string;
  readonly #retireSurface: ManagedShortcutSurfaceRetire;
  readonly #onError: (error: ReturnType<typeof normalizeRionBridgeError>) => void;
  readonly #active = new Map<string, ActiveManagedShortcut>();
  readonly #documentReplacementFences = new Map<
    string,
    Map<string, ManagedShortcutDocumentReplacementFence>
  >();
  readonly #documentReplacementRetirements = new Map<
    string,
    Map<string, ManagedShortcutSurfaceRetirementReceiptRecord>
  >();
  readonly #tails = new Map<string, Promise<void>>();
  readonly #unsubscribe: () => void;
  #disposed = false;

  constructor(input: Readonly<{
    dispatch: ManagedShortcutDispatch;
    resolveSurface: ManagedShortcutSurfaceResolver;
    retireSurface: ManagedShortcutSurfaceRetire;
    subscribeSurfaceLifecycle: (
      listener: (event: ChromiumRoleOverlayLifecycleEvent) => void
    ) => () => void;
    onError: (error: ReturnType<typeof normalizeRionBridgeError>) => void;
    createOperationId?: () => string;
  }>) {
    this.#dispatch = input.dispatch;
    this.#resolveSurface = input.resolveSurface;
    this.#retireSurface = input.retireSurface;
    this.#onError = input.onError;
    this.#createOperationId = input.createOperationId ?? randomUUID;
    this.#unsubscribe = input.subscribeSurfaceLifecycle((event) => {
      void this.retireSurface(event.roleId, event.generation, event.reason)
        .catch((error: unknown) => this.#onError(normalizeRionBridgeError(error)));
    });
  }

  async dispatch(
    identity: ChromiumRoleOverlayFrameIdentity,
    raw: unknown
  ): Promise<ManagedShortcutPhaseReceiptRecord> {
    if (this.#disposed) {
      throw shortcutError(
        "ELECTRON_MANAGED_SHORTCUT_DISPOSED",
        "The managed shortcut coordinator is disposed."
      );
    }
    const request = parseRequest(raw);
    const surface = this.#resolveSurface(identity, request.phase);
    if (surface.roleId !== identity.roleId ||
      surface.surfaceGeneration !== identity.generation ||
      surface.documentInstanceId !== identity.documentInstanceId) {
      throw shortcutError(
        "ELECTRON_MANAGED_SHORTCUT_SURFACE_STALE",
        "The managed shortcut belongs to an obsolete Chromium role surface."
      );
    }
    return this.#enqueue(surface.roleId, async () => {
      if (this.#documentReplacementFences.get(surface.roleId)?.size) {
        throw shortcutError(
          "ELECTRON_MANAGED_SHORTCUT_DOCUMENT_REPLACING",
          "Managed shortcut dispatch is fenced while the role document reloads."
        );
      }
      const operationId = this.#createOperationId();
      const shortcutKey = this.#shortcutKey(surface.roleId, request.macroId, request.code);
      if (request.phase === "keyDown") {
        this.#active.set(shortcutKey, {
          code: request.code,
          documentInstanceId: surface.documentInstanceId,
          macroId: request.macroId,
          pressId: request.pressId,
          roleId: surface.roleId,
          surfaceGeneration: surface.surfaceGeneration,
          state: "provisional"
        });
      }
      let receipt: ManagedShortcutPhaseReceiptRecord;
      try {
        receipt = await this.#dispatch({ operationId, surface, request });
      } catch (error) {
        if (request.phase === "keyDown") {
          const active = this.#active.get(shortcutKey);
          if (active?.pressId === request.pressId) {
            const normalized = normalizeRionBridgeError(error);
            if (normalized.code === "SYSTEM_TRUSTED_INPUT_INDETERMINATE") {
              active.state = "uncertain";
            } else {
              this.#active.delete(shortcutKey);
            }
          }
        }
        throw error;
      }
      if (!exactReceipt(receipt, operationId, surface, request)) {
        if (request.phase === "keyDown") {
          const active = this.#active.get(shortcutKey);
          if (active?.pressId === request.pressId) active.state = "uncertain";
        }
        throw shortcutError(
          "ELECTRON_MANAGED_SHORTCUT_RECEIPT_INVALID",
          "Core returned a mismatched managed shortcut receipt."
        );
      }
      if (receipt.status !== "accepted") {
        if (request.phase === "keyDown") this.#active.delete(shortcutKey);
        throw shortcutError(
          receipt.status === "duplicate"
            ? "ELECTRON_MANAGED_SHORTCUT_DUPLICATE"
            : "ELECTRON_MANAGED_SHORTCUT_SUPERSEDED",
          receipt.status === "duplicate"
            ? "The physical shortcut phase was already admitted."
            : "The exact physical shortcut is already held."
        );
      }
      if (request.phase === "keyDown") {
        const active = this.#active.get(shortcutKey);
        if (active?.pressId === request.pressId) active.state = "held";
      } else if (request.phase === "keyUp") {
        this.#active.delete(shortcutKey);
      }
      return Object.freeze({ ...receipt, requestIds: [...receipt.requestIds] });
    });
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe();
    await Promise.allSettled([...this.#tails.values()]);
    this.#tails.clear();
    this.#active.clear();
    this.#documentReplacementFences.clear();
    this.#documentReplacementRetirements.clear();
  }

  prepareDocumentReplacement(input: Readonly<{
    documentInstanceId: string;
    operationId: string;
    roleId: string;
    surfaceGeneration: number;
  }>): Promise<void> {
    if (this.#disposed) {
      return Promise.reject(shortcutError(
        "ELECTRON_MANAGED_SHORTCUT_DISPOSED",
        "The managed shortcut coordinator is disposed."
      ));
    }
    if (
      !identifier(input.roleId, 256) ||
      !identifier(input.documentInstanceId, 128) ||
      !identifier(input.operationId, 256) ||
      !Number.isSafeInteger(input.surfaceGeneration) ||
      input.surfaceGeneration < 1
    ) {
      return Promise.reject(shortcutError(
        "ELECTRON_MANAGED_SHORTCUT_REPLACEMENT_INVALID",
        "The managed shortcut document-replacement identity is invalid."
      ));
    }
    const byOperation = this.#documentReplacementFences.get(input.roleId) ??
      new Map<string, ManagedShortcutDocumentReplacementFence>();
    const existing = byOperation.get(input.operationId);
    if (existing && (
      existing.surfaceGeneration !== input.surfaceGeneration ||
      existing.documentInstanceId !== input.documentInstanceId
    )) {
      return Promise.reject(shortcutError(
        "ELECTRON_MANAGED_SHORTCUT_REPLACEMENT_CONFLICT",
        "The reload operation already fences another managed-shortcut document."
      ));
    }
    const fence = existing ?? Object.freeze({
      documentInstanceId: input.documentInstanceId,
      operationId: input.operationId,
      surfaceGeneration: input.surfaceGeneration
    });
    byOperation.set(input.operationId, fence);
    this.#documentReplacementFences.set(input.roleId, byOperation);
    return this.#enqueue(input.roleId, async () => {
      if (this.#disposed) {
        throw shortcutError(
          "ELECTRON_MANAGED_SHORTCUT_DISPOSED",
          "The managed shortcut coordinator is disposed."
        );
      }
      if (this.#documentReplacementFences
        .get(input.roleId)?.get(input.operationId) !== fence) {
        throw shortcutError(
          "ELECTRON_MANAGED_SHORTCUT_REPLACEMENT_SUPERSEDED",
          "The managed-shortcut document replacement was superseded."
        );
      }
      for (const entry of this.#active.values()) {
        if (entry.roleId !== input.roleId) continue;
        if (
          entry.surfaceGeneration !== input.surfaceGeneration ||
          entry.documentInstanceId !== input.documentInstanceId
        ) {
          throw shortcutError(
            "ELECTRON_MANAGED_SHORTCUT_REPLACEMENT_STALE",
            "The managed-shortcut state belongs to another role document."
          );
        }
      }
    }).catch((error: unknown) => {
      this.releaseDocumentReplacementFence(input);
      throw error;
    });
  }

  canCommitDocumentReplacement(input: Readonly<{
    documentInstanceId: string;
    operationId: string;
    roleId: string;
    surfaceGeneration: number;
  }>): boolean {
    const fence = this.#documentReplacementFences
      .get(input.roleId)?.get(input.operationId);
    if (
      !fence || fence.surfaceGeneration !== input.surfaceGeneration ||
      fence.documentInstanceId !== input.documentInstanceId
    ) return false;
    return this.#documentReplacementRetirements
      .get(input.roleId)?.has(input.operationId) === true;
  }

  commitDocumentReplacement(input: Readonly<{
    documentInstanceId: string;
    operationId: string;
    roleId: string;
    surfaceGeneration: number;
  }>): boolean {
    return this.canCommitDocumentReplacement(input);
  }

  reconcileDocumentReplacementRetirement(
    input: Readonly<{
      documentInstanceId: string;
      operationId: string;
      roleId: string;
      surfaceGeneration: number;
    }>,
    receipt: ManagedShortcutSurfaceRetirementReceiptRecord
  ): boolean {
    const fence = this.#documentReplacementFences
      .get(input.roleId)?.get(input.operationId);
    if (!fence || fence.surfaceGeneration !== input.surfaceGeneration ||
      fence.documentInstanceId !== input.documentInstanceId) return false;
    const byOperation = this.#documentReplacementRetirements.get(input.roleId) ??
      new Map<string, ManagedShortcutSurfaceRetirementReceiptRecord>();
    const replay = byOperation.get(input.operationId);
    if (replay) return this.#sameRetirementReceipt(replay, receipt);
    const expectedPressIds = [...this.#active.values()]
      .filter((entry) => entry.roleId === input.roleId &&
        entry.surfaceGeneration === input.surfaceGeneration &&
        entry.documentInstanceId === input.documentInstanceId)
      .map((entry) => entry.pressId)
      .sort();
    const retiredPressIds = [...receipt.retiredPressIds].sort();
    if (
      receipt.roleId !== input.roleId ||
      receipt.surfaceGeneration !== input.surfaceGeneration ||
      receipt.documentInstanceId !== input.documentInstanceId ||
      receipt.terminal !== true ||
      receipt.cleanupRequestIds.length !== expectedPressIds.length ||
      new Set(receipt.cleanupRequestIds).size !== receipt.cleanupRequestIds.length ||
      receipt.cleanupRequestIds.some((requestId) => !identifier(requestId, 256)) ||
      retiredPressIds.length !== expectedPressIds.length ||
      retiredPressIds.some((pressId, index) => pressId !== expectedPressIds[index])
    ) return false;
    const retained = Object.freeze({
      ...receipt,
      cleanupRequestIds: Object.freeze([...receipt.cleanupRequestIds]),
      retiredPressIds: Object.freeze([...receipt.retiredPressIds])
    }) as ManagedShortcutSurfaceRetirementReceiptRecord;
    byOperation.set(input.operationId, retained);
    this.#documentReplacementRetirements.set(input.roleId, byOperation);
    for (const [key, entry] of this.#active) {
      if (entry.roleId === input.roleId &&
        entry.surfaceGeneration === input.surfaceGeneration &&
        entry.documentInstanceId === input.documentInstanceId) {
        this.#active.delete(key);
      }
    }
    return true;
  }

  releaseDocumentReplacementFence(input: Readonly<{
    documentInstanceId: string;
    operationId: string;
    roleId: string;
    surfaceGeneration: number;
  }>): boolean {
    const byOperation = this.#documentReplacementFences.get(input.roleId);
    const fence = byOperation?.get(input.operationId);
    if (
      !fence || fence.surfaceGeneration !== input.surfaceGeneration ||
      fence.documentInstanceId !== input.documentInstanceId
    ) return false;
    byOperation!.delete(input.operationId);
    if (byOperation!.size === 0) {
      this.#documentReplacementFences.delete(input.roleId);
    }
    const retirements = this.#documentReplacementRetirements.get(input.roleId);
    retirements?.delete(input.operationId);
    if (retirements?.size === 0) {
      this.#documentReplacementRetirements.delete(input.roleId);
    }
    return true;
  }

  retireSurface(
    roleId: string,
    surfaceGeneration: number,
    reason: ChromiumRoleOverlayLifecycleEvent["reason"] = "surface-retired"
  ): Promise<void> {
    if (this.#disposed) {
      return Promise.reject(shortcutError(
        "ELECTRON_MANAGED_SHORTCUT_DISPOSED",
        "The managed shortcut coordinator is disposed."
      ));
    }
    if (!identifier(roleId, 256) || !Number.isSafeInteger(surfaceGeneration) ||
      surfaceGeneration < 1) {
      return Promise.reject(shortcutError(
        "ELECTRON_MANAGED_SHORTCUT_SURFACE_INVALID",
        "The managed shortcut surface retirement identity is invalid."
      ));
    }
    if (reason === "surface-retired") {
      this.#documentReplacementFences.delete(roleId);
      this.#documentReplacementRetirements.delete(roleId);
    }
    return this.#enqueue(roleId, () => this.#retireLifecycle({
      roleId,
      generation: surfaceGeneration,
      reason
    }));
  }

  #shortcutKey(roleId: string, macroId: string, code: string): string {
    return JSON.stringify([roleId, macroId, code]);
  }

  #sameRetirementReceipt(
    left: ManagedShortcutSurfaceRetirementReceiptRecord,
    right: ManagedShortcutSurfaceRetirementReceiptRecord
  ): boolean {
    return left.roleId === right.roleId &&
      left.surfaceGeneration === right.surfaceGeneration &&
      left.documentInstanceId === right.documentInstanceId &&
      left.terminal === right.terminal &&
      left.cleanupRequestIds.length === right.cleanupRequestIds.length &&
      left.cleanupRequestIds.every((value, index) =>
        value === right.cleanupRequestIds[index]) &&
      left.retiredPressIds.length === right.retiredPressIds.length &&
      left.retiredPressIds.every((value, index) =>
        value === right.retiredPressIds[index]);
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

  async #retireLifecycle(event: ChromiumRoleOverlayLifecycleEvent): Promise<void> {
    const active = [...this.#active.values()].filter((entry) =>
      entry.roleId === event.roleId &&
      entry.surfaceGeneration === event.generation
    );
    const documents = [...new Set(active.map((entry) => entry.documentInstanceId))].sort();
    for (const documentInstanceId of documents) {
      const expectedPressIds = active
        .filter((entry) => entry.documentInstanceId === documentInstanceId)
        .map((entry) => entry.pressId)
        .sort();
      const receipt = await this.#retireSurface({
        roleId: event.roleId,
        surfaceGeneration: event.generation,
        documentInstanceId
      });
      const retiredPressIds = [...receipt.retiredPressIds].sort();
      if (receipt.roleId !== event.roleId ||
        receipt.surfaceGeneration !== event.generation ||
        receipt.documentInstanceId !== documentInstanceId ||
        receipt.terminal !== true ||
        receipt.cleanupRequestIds.length !== expectedPressIds.length ||
        receipt.cleanupRequestIds.some((requestId) => !identifier(requestId, 256)) ||
        retiredPressIds.length !== expectedPressIds.length ||
        retiredPressIds.some((pressId, index) => pressId !== expectedPressIds[index])) {
        throw shortcutError(
          "ELECTRON_MANAGED_SHORTCUT_RETIREMENT_INVALID",
          "Core returned a mismatched managed shortcut surface retirement receipt."
        );
      }
      for (const [key, entry] of this.#active) {
        if (entry.roleId === event.roleId &&
          entry.surfaceGeneration === event.generation &&
          entry.documentInstanceId === documentInstanceId) {
          this.#active.delete(key);
        }
      }
    }
  }
}
