import type {
  BrowserAction,
  BrowserActionRequest
} from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";

type CoordinatorState = "open" | "draining" | "disposed";

export interface ChromiumTrustedInputSurfaceIdentity {
  readonly roleId: string;
  readonly surfaceGeneration: number;
  readonly documentInstanceId: string;
  readonly state: "active" | "closing";
}

export interface ChromiumTrustedInputSurfacePort {
  resolveInputSurface: (
    roleId: string
  ) => ChromiumTrustedInputSurfaceIdentity | null;
  subscribeTrustedInputLifecycle?: (listener: (event: Readonly<{
    roleId: string;
    generation: number;
    reason: "document-superseded" | "surface-retired";
  }>) => void) => () => void;
}

export interface ChromiumNativeTrustedInputRequest {
  readonly requestId: string;
  readonly roleId: string;
  readonly inputEpoch: number;
  readonly intent: "normal" | "cleanup";
  readonly scheduledAtMs: number;
  readonly deadlineMs: number;
  readonly surfaceGeneration: number;
  readonly expectedInputNeutralityBefore: boolean;
  readonly expectedInputNeutralityAfter: boolean;
  readonly action: BrowserAction;
}

export interface ChromiumNativeTrustedInputReceipt {
  readonly requestId: string;
  readonly roleId: string;
  readonly inputEpoch: number;
  readonly surfaceGeneration: number;
  readonly status: "applied" | "failed" | "indeterminate" | "superseded";
  readonly completedAtMs: number;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  /** True only when the native owner proved that no key/button remains held. */
  readonly confirmedInputNeutrality: boolean;
}

export interface ChromiumNativeTrustedInputPort {
  /**
   * Deadline-bound native submission. The platform adapter must terminalize
   * from its exact callback before `deadlineMs`; it may not poll or infer
   * success from elapsed time. A rejected promise is treated as indeterminate.
   */
  dispatch: (
    request: ChromiumNativeTrustedInputRequest
  ) => Promise<ChromiumNativeTrustedInputReceipt>;
}

export interface ChromiumTrustedInputCoordinatorInput {
  readonly native: ChromiumNativeTrustedInputPort;
  readonly surfaces: ChromiumTrustedInputSurfacePort;
  readonly nowMs: () => number;
  readonly preflightAutomaticInputContext?: (
    roleId: string,
    surfaceGeneration: number
  ) => void | Promise<void>;
  readonly onRecoveryProof?: (proof: ChromiumTrustedInputRecoveryProof) => void;
}

export interface ChromiumTrustedInputRecoveryProof {
  readonly kind: "cleanup-neutral";
  readonly requestId: string;
  readonly roleId: string;
  readonly inputEpoch: number;
  readonly surfaceGeneration: number;
}

interface RoleLaneState {
  inputEpoch: number;
  readonly surfaceGeneration: number;
  quarantined: boolean;
  readonly heldKeys: Set<string>;
}

interface DocumentReplacementQuarantine {
  readonly operationId: string;
  readonly surfaceGeneration: number;
}

export interface ChromiumTrustedInputDocumentReplacementLease {
  readonly documentInstanceId: string;
  readonly inputEpoch: number;
  readonly operationId: string;
  readonly roleId: string;
  readonly surfaceGeneration: number;
}

function heldKeyIdentity(action: Extract<BrowserAction, { type: "key" }>): string {
  return JSON.stringify([action.ownerId, action.code ?? action.key]);
}

function projectedHeldKeys(
  current: ReadonlySet<string>,
  action: BrowserAction
): Set<string> {
  const projected = new Set(current);
  if (action.type !== "key" || action.phase === "tap") return projected;
  const identity = heldKeyIdentity(action);
  if (action.phase === "hold") projected.add(identity);
  else projected.delete(identity);
  return projected;
}

function inputError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function fail(code: string, message: string): never {
  throw inputError(code, message);
}

function requireIdentifier(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    value.includes("/") ||
    value.includes("\\") ||
    [...value].some((character) => character.codePointAt(0)! <= 0x1f)
  ) {
    fail("ELECTRON_CHROMIUM_INPUT_INVALID", `Core supplied an invalid ${field}.`);
  }
}

function requireSafeInteger(value: unknown, field: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    fail("ELECTRON_CHROMIUM_INPUT_INVALID", `Core supplied an invalid ${field}.`);
  }
}

function validateAction(action: BrowserAction): void {
  if (!action || typeof action !== "object") {
    fail("ELECTRON_CHROMIUM_INPUT_INVALID", "Core supplied an invalid browser action.");
  }
  if (action.type === "focus") return;
  if (action.type === "key") {
    const modifiers = new Set(["primary", "ctrl", "alt", "shift", "meta"]);
    if (
      !(["tap", "hold", "release"] as const).includes(action.phase) ||
      typeof action.key !== "string" ||
      action.key.length === 0 ||
      action.key.length > 128 ||
      (action.code !== null &&
        (typeof action.code !== "string" || action.code.length > 128)) ||
      !Array.isArray(action.modifiers) ||
      new Set(action.modifiers).size !== action.modifiers.length ||
      action.modifiers.some((modifier) => !modifiers.has(modifier)) ||
      typeof action.ownerId !== "string" ||
      action.ownerId.length === 0 ||
      action.ownerId.length > 256 ||
      typeof action.suppressOverlayShortcut !== "boolean"
    ) {
      fail("ELECTRON_CHROMIUM_INPUT_INVALID", "Core supplied an invalid key action.");
    }
    return;
  }
  if (action.type === "click") {
    const anchors = new Set([
      null,
      "top-left",
      "top-center",
      "top-right",
      "center-left",
      "center",
      "center-right",
      "bottom-left",
      "bottom-center",
      "bottom-right"
    ]);
    if (
      !anchors.has(action.anchor) ||
      !(["percent", "px", "reference-px"] as const).includes(action.unit) ||
      !Number.isFinite(action.x) ||
      !Number.isFinite(action.y) ||
      !(["left", "middle", "right"] as const).includes(action.button)
    ) {
      fail("ELECTRON_CHROMIUM_INPUT_INVALID", "Core supplied an invalid click action.");
    }
    return;
  }
  fail("ELECTRON_CHROMIUM_INPUT_INVALID", "Core supplied an unknown browser action.");
}

function validateRequest(request: BrowserActionRequest): void {
  requireIdentifier(request.requestId, "browser-action request identity");
  requireIdentifier(request.roleId, "browser-action role identity");
  if (
    request.origin !== "macro" ||
    (request.intent !== "normal" && request.intent !== "cleanup")
  ) {
    fail("ELECTRON_CHROMIUM_INPUT_INVALID", "Core supplied an invalid browser-action origin or intent.");
  }
  requireSafeInteger(request.inputEpoch, "input epoch");
  requireSafeInteger(request.scheduledAtMs, "scheduled time", 1);
  requireSafeInteger(request.deadlineMs, "deadline", 1);
  if (request.scheduledAtMs > request.deadlineMs) {
    fail("ELECTRON_CHROMIUM_INPUT_INVALID", "The browser-action deadline precedes its schedule.");
  }
  const hasSurfaceGeneration = request.surfaceGeneration !== undefined;
  const hasDocumentInstanceId = request.documentInstanceId !== undefined;
  if (hasSurfaceGeneration !== hasDocumentInstanceId) {
    fail(
      "ELECTRON_CHROMIUM_INPUT_INVALID",
      "Core supplied an incomplete browser-action surface fence."
    );
  }
  if (hasSurfaceGeneration) {
    requireSafeInteger(request.surfaceGeneration, "surface generation", 1);
    requireIdentifier(request.documentInstanceId, "document instance identity");
  }
  validateAction(request.action);
}

function validateSurface(
  surface: ChromiumTrustedInputSurfaceIdentity | null,
  roleId: string,
  intent: BrowserActionRequest["intent"]
): ChromiumTrustedInputSurfaceIdentity {
  if (!surface) {
    fail("ELECTRON_CHROMIUM_INPUT_ROLE_NOT_FOUND", "The role has no Chromium input surface.");
  }
  requireSafeInteger(surface.surfaceGeneration, "surface generation", 1);
  requireIdentifier(surface.documentInstanceId, "document instance identity");
  if (surface.roleId !== roleId || !(["active", "closing"] as const).includes(surface.state)) {
    fail("ELECTRON_CHROMIUM_INPUT_SURFACE_INVALID", "The Chromium input surface identity is invalid.");
  }
  if (intent === "normal" && surface.state !== "active") {
    fail(
      "SYSTEM_TRUSTED_INPUT_QUARANTINED",
      "The role is closing and cannot accept normal automatic input."
    );
  }
  return surface;
}

function validNativeError(code: unknown, message: unknown): boolean {
  return typeof code === "string" &&
    /^[A-Z][A-Z0-9_]{2,95}$/u.test(code) &&
    typeof message === "string" &&
    message.length > 0 &&
    message.length <= 1024 &&
    message.trim() === message &&
    ![...message].some((character) => {
      const point = character.codePointAt(0)!;
      return point <= 0x1f || point === 0x7f;
    });
}

function receiptMatches(
  receipt: unknown,
  request: ChromiumNativeTrustedInputRequest,
  observedAtMs: number
): receipt is ChromiumNativeTrustedInputReceipt {
  if (!receipt || typeof receipt !== "object") return false;
  const candidate = receipt as Partial<ChromiumNativeTrustedInputReceipt>;
  const validStatus = (["applied", "failed", "indeterminate", "superseded"] as const)
    .includes(candidate.status as ChromiumNativeTrustedInputReceipt["status"]);
  const exactIdentity = candidate.requestId === request.requestId &&
    candidate.roleId === request.roleId &&
    candidate.inputEpoch === request.inputEpoch &&
    candidate.surfaceGeneration === request.surfaceGeneration;
  const validCompletion = Number.isSafeInteger(candidate.completedAtMs) &&
    candidate.completedAtMs! >= request.scheduledAtMs &&
    candidate.completedAtMs! <= observedAtMs;
  const validError = candidate.status === "applied"
    ? candidate.errorCode === null && candidate.errorMessage === null &&
      candidate.confirmedInputNeutrality === request.expectedInputNeutralityAfter
    : validNativeError(candidate.errorCode, candidate.errorMessage) &&
      (candidate.status === "indeterminate"
        ? candidate.confirmedInputNeutrality === false
        : candidate.confirmedInputNeutrality === request.expectedInputNeutralityBefore);
  return validStatus && exactIdentity && validCompletion && validError &&
    typeof candidate.confirmedInputNeutrality === "boolean";
}

/**
 * Serializes automatic input per role and accepts only exact native terminal
 * receipts. Chromium/WebContents is not the authority for background input;
 * only the injected AppKit or Win32 adapter may implement this port.
 */
export class ChromiumTrustedInputCoordinator {
  readonly #input: ChromiumTrustedInputCoordinatorInput;
  readonly #tails = new Map<string, Promise<void>>();
  readonly #roleStates = new Map<string, RoleLaneState>();
  readonly #documentReplacementLeases = new Map<
    string,
    Map<string, ChromiumTrustedInputDocumentReplacementLease>
  >();
  readonly #documentReplacementQuarantines = new Map<
    string,
    DocumentReplacementQuarantine
  >();
  readonly #unsubscribeSurfaceLifecycle: () => void;
  #state: CoordinatorState = "open";
  #disposePromise: Promise<void> | null = null;

  constructor(input: ChromiumTrustedInputCoordinatorInput) {
    this.#input = input;
    this.#unsubscribeSurfaceLifecycle =
      input.surfaces.subscribeTrustedInputLifecycle?.((event) => {
        void this.#enqueue(event.roleId, () => {
          const state = this.#roleStates.get(event.roleId);
          if (state?.surfaceGeneration === event.generation) {
            if (event.reason === "surface-retired") {
              this.#roleStates.delete(event.roleId);
            } else if (state.heldKeys.size > 0) {
              state.quarantined = true;
            }
          }
          if (event.reason === "surface-retired") {
            const leases = this.#documentReplacementLeases.get(event.roleId);
            if (leases) {
              for (const [operationId, lease] of leases) {
                if (lease.surfaceGeneration === event.generation) {
                  leases.delete(operationId);
                }
              }
              if (leases.size === 0) {
                this.#documentReplacementLeases.delete(event.roleId);
              }
            }
            const quarantine = this.#documentReplacementQuarantines
              .get(event.roleId);
            if (quarantine?.surfaceGeneration === event.generation) {
              this.#documentReplacementQuarantines.delete(event.roleId);
            }
          }
        }).catch(() => undefined);
      }) ?? (() => undefined);
  }

  execute(request: BrowserActionRequest): Promise<ChromiumNativeTrustedInputReceipt> {
    if (this.#state !== "open") {
      return Promise.reject(inputError(
        "ELECTRON_CHROMIUM_INPUT_DRAINING",
        "The Chromium trusted-input coordinator is draining."
      ));
    }
    validateRequest(request);
    return this.#enqueue(request.roleId, () => this.#executeInLane(request));
  }

  prepareControlledDocumentReplacement(
    lease: ChromiumTrustedInputDocumentReplacementLease
  ): Promise<void> {
    if (this.#state !== "open") {
      return Promise.reject(inputError(
        "ELECTRON_CHROMIUM_INPUT_DRAINING",
        "The Chromium trusted-input coordinator is draining."
      ));
    }
    requireIdentifier(lease.operationId, "reload operation identity");
    requireIdentifier(lease.roleId, "browser-action role identity");
    requireIdentifier(lease.documentInstanceId, "document instance identity");
    requireSafeInteger(lease.surfaceGeneration, "surface generation", 1);
    requireSafeInteger(lease.inputEpoch, "input epoch");
    const byOperation = this.#documentReplacementLeases.get(lease.roleId) ??
      new Map<string, ChromiumTrustedInputDocumentReplacementLease>();
    const existing = byOperation.get(lease.operationId);
    if (existing && (
      existing.surfaceGeneration !== lease.surfaceGeneration ||
      existing.documentInstanceId !== lease.documentInstanceId ||
      existing.inputEpoch !== lease.inputEpoch
    )) {
      return Promise.reject(inputError(
        "ELECTRON_CHROMIUM_INPUT_RELOAD_CONFLICT",
        "The reload operation already fences another trusted-input document."
      ));
    }
    const retained = existing ?? Object.freeze({ ...lease });
    byOperation.set(lease.operationId, retained);
    this.#documentReplacementLeases.set(lease.roleId, byOperation);
    return this.#enqueue(lease.roleId, () => {
      if (this.#documentReplacementQuarantines.has(lease.roleId)) {
        fail(
          "SYSTEM_TRUSTED_INPUT_QUARANTINED",
          "A submitted document replacement remains quarantined until exact surface retirement."
        );
      }
      if (this.#documentReplacementLeases
        .get(lease.roleId)?.get(lease.operationId) !== retained) {
        fail(
          "ELECTRON_CHROMIUM_INPUT_RELOAD_SUPERSEDED",
          "The trusted-input document replacement was superseded."
        );
      }
      const surface = validateSurface(
        this.#input.surfaces.resolveInputSurface(lease.roleId),
        lease.roleId,
        "normal"
      );
      if (
        surface.surfaceGeneration !== lease.surfaceGeneration ||
        surface.documentInstanceId !== lease.documentInstanceId
      ) {
        fail(
          "ELECTRON_CHROMIUM_INPUT_RELOAD_STALE",
          "The trusted-input reload preparation targets an obsolete document."
        );
      }
      const state = this.#roleStates.get(lease.roleId);
      if (state && state.surfaceGeneration !== lease.surfaceGeneration) {
        fail(
          "ELECTRON_CHROMIUM_INPUT_RELOAD_STALE",
          "The trusted-input lane belongs to another role surface."
        );
      }
    }).catch((error: unknown) => {
      this.supersedeControlledDocumentReplacement(lease, false);
      throw error;
    });
  }

  confirmControlledDocumentReplacementNeutral(
    lease: ChromiumTrustedInputDocumentReplacementLease
  ): Promise<boolean> {
    return this.#enqueue(lease.roleId, () => {
      const byOperation = this.#documentReplacementLeases.get(lease.roleId);
      const current = byOperation?.get(lease.operationId);
      if (!current || !this.#sameDocumentReplacementLease(current, lease)) {
        return false;
      }
      const latest = byOperation && [...byOperation.values()].at(-1);
      if (latest !== current ||
        this.#documentReplacementQuarantines.has(lease.roleId)) return false;
      const surface = validateSurface(
        this.#input.surfaces.resolveInputSurface(lease.roleId),
        lease.roleId,
        "normal"
      );
      const state = this.#roleStates.get(lease.roleId);
      return surface.surfaceGeneration === lease.surfaceGeneration &&
        surface.documentInstanceId === lease.documentInstanceId &&
        (!state || (
          state.surfaceGeneration === lease.surfaceGeneration &&
          !state.quarantined && state.heldKeys.size === 0 &&
          state.inputEpoch <= lease.inputEpoch
        ));
    });
  }

  resumeControlledDocumentReplacement(
    lease: ChromiumTrustedInputDocumentReplacementLease,
    nextDocumentInstanceId: string
  ): Promise<boolean> {
    requireIdentifier(nextDocumentInstanceId, "replacement document identity");
    return this.#enqueue(lease.roleId, () => {
      const byOperation = this.#documentReplacementLeases.get(lease.roleId);
      const current = byOperation?.get(lease.operationId);
      if (!current || !this.#sameDocumentReplacementLease(current, lease)) {
        return false;
      }
      const latest = byOperation && [...byOperation.values()].at(-1);
      if (latest !== current ||
        this.#documentReplacementQuarantines.has(lease.roleId)) return false;
      const surface = validateSurface(
        this.#input.surfaces.resolveInputSurface(lease.roleId),
        lease.roleId,
        "normal"
      );
      if (
        surface.surfaceGeneration !== lease.surfaceGeneration ||
        surface.documentInstanceId !== nextDocumentInstanceId
      ) return false;
      let state = this.#roleStates.get(lease.roleId);
      if (!state) {
        state = {
          heldKeys: new Set(),
          inputEpoch: lease.inputEpoch,
          quarantined: false,
          surfaceGeneration: lease.surfaceGeneration
        };
        this.#roleStates.set(lease.roleId, state);
      }
      if (
        state.surfaceGeneration !== lease.surfaceGeneration ||
        state.quarantined || state.heldKeys.size > 0 ||
        state.inputEpoch > lease.inputEpoch
      ) return false;
      state.inputEpoch = lease.inputEpoch;
      this.#documentReplacementLeases.delete(lease.roleId);
      return true;
    });
  }

  supersedeControlledDocumentReplacement(
    lease: ChromiumTrustedInputDocumentReplacementLease,
    submitted: boolean
  ): boolean {
    const byOperation = this.#documentReplacementLeases.get(lease.roleId);
    const current = byOperation?.get(lease.operationId);
    if (!current || !this.#sameDocumentReplacementLease(current, lease)) {
      return false;
    }
    if (submitted) {
      const state = this.#roleStates.get(lease.roleId);
      if (state) state.quarantined = true;
      this.#documentReplacementQuarantines.set(lease.roleId, Object.freeze({
        operationId: lease.operationId,
        surfaceGeneration: lease.surfaceGeneration
      }));
      return true;
    }
    byOperation!.delete(lease.operationId);
    if (byOperation!.size === 0) {
      this.#documentReplacementLeases.delete(lease.roleId);
    }
    return true;
  }

  retireSurface(roleId: string, surfaceGeneration: number): Promise<boolean> {
    if (this.#state !== "open") {
      return Promise.reject(inputError(
        "ELECTRON_CHROMIUM_INPUT_DRAINING",
        "The Chromium trusted-input coordinator is draining."
      ));
    }
    requireIdentifier(roleId, "browser-action role identity");
    requireSafeInteger(surfaceGeneration, "surface generation", 1);
    return this.#enqueue(roleId, () => {
      const state = this.#roleStates.get(roleId);
      if (!state || state.surfaceGeneration !== surfaceGeneration) return false;
      if (state.quarantined || state.heldKeys.size > 0) {
        fail(
          "SYSTEM_TRUSTED_INPUT_INDETERMINATE",
          "The Chromium input surface cannot retire before exact input neutrality."
        );
      }
      this.#roleStates.delete(roleId);
      return true;
    });
  }

  retireSurfaceForDestruction(
    roleId: string,
    surfaceGeneration: number
  ): Promise<boolean> {
    if (this.#state !== "open") {
      return Promise.reject(inputError(
        "ELECTRON_CHROMIUM_INPUT_DRAINING",
        "The Chromium trusted-input coordinator is draining."
      ));
    }
    requireIdentifier(roleId, "browser-action role identity");
    requireSafeInteger(surfaceGeneration, "surface generation", 1);
    return this.#enqueue(roleId, () => {
      const state = this.#roleStates.get(roleId);
      const quarantine = this.#documentReplacementQuarantines.get(roleId);
      if (state && state.surfaceGeneration !== surfaceGeneration) return false;
      if (quarantine && quarantine.surfaceGeneration !== surfaceGeneration) {
        return false;
      }
      // Exact destructive retirement is allowed to proceed while the old
      // generation remains quarantined. Its surface-retired event is the only
      // authority that clears the quarantine; no input epoch is resumed here.
      return true;
    });
  }

  resumeAfterDocumentReplacement(
    roleId: string,
    surfaceGeneration: number
  ): Promise<boolean> {
    if (this.#state !== "open") {
      return Promise.reject(inputError(
        "ELECTRON_CHROMIUM_INPUT_DRAINING",
        "The Chromium trusted-input coordinator is draining."
      ));
    }
    requireIdentifier(roleId, "browser-action role identity");
    requireSafeInteger(surfaceGeneration, "surface generation", 1);
    return this.#enqueue(roleId, () => {
      const state = this.#roleStates.get(roleId);
      if (!state || state.surfaceGeneration !== surfaceGeneration || !state.quarantined) {
        return false;
      }
      state.quarantined = false;
      state.heldKeys.clear();
      return true;
    });
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    if (this.#state === "disposed") return Promise.resolve();
    this.#state = "draining";
    this.#unsubscribeSurfaceLifecycle();
    this.#disposePromise = Promise.allSettled([...this.#tails.values()]).then(() => {
      this.#tails.clear();
      this.#roleStates.clear();
      this.#documentReplacementLeases.clear();
      this.#documentReplacementQuarantines.clear();
      this.#state = "disposed";
    });
    return this.#disposePromise;
  }

  #enqueue<Value>(roleId: string, operation: () => Promise<Value> | Value): Promise<Value> {
    const previous = this.#tails.get(roleId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.#tails.set(roleId, tail);
    void tail.finally(() => {
      if (this.#tails.get(roleId) === tail) this.#tails.delete(roleId);
    });
    return result;
  }

  async #executeInLane(
    request: BrowserActionRequest
  ): Promise<ChromiumNativeTrustedInputReceipt> {
    const nowMs = this.#input.nowMs();
    requireSafeInteger(nowMs, "current time", 1);
    if (request.intent === "normal" && nowMs >= request.deadlineMs) {
      fail("BROWSER_ACTION_DEADLINE", "The browser-action deadline expired before submission.");
    }
    if (
      request.intent === "normal" &&
      (this.#documentReplacementLeases.get(request.roleId)?.size ||
        this.#documentReplacementQuarantines.has(request.roleId))
    ) {
      fail(
        "SYSTEM_TRUSTED_INPUT_QUARANTINED",
        "Automatic input is fenced while the Chromium document reloads."
      );
    }
    const surface = validateSurface(
      this.#input.surfaces.resolveInputSurface(request.roleId),
      request.roleId,
      request.intent
    );
    if (request.surfaceGeneration !== undefined &&
      (request.surfaceGeneration !== surface.surfaceGeneration ||
        (request.intent === "normal" &&
          request.documentInstanceId !== surface.documentInstanceId))) {
      fail(
        "BROWSER_ACTION_STALE",
        "The browser action belongs to an obsolete Chromium document."
      );
    }
    const preflight = this.#input.preflightAutomaticInputContext;
    if (request.intent === "normal" && preflight) {
      await preflight(
        request.roleId,
        surface.surfaceGeneration
      );
    }
    let state = this.#roleStates.get(request.roleId);
    if (!state) {
      state = {
        inputEpoch: 0,
        surfaceGeneration: surface.surfaceGeneration,
        quarantined: false,
        heldKeys: new Set()
      };
      this.#roleStates.set(request.roleId, state);
    }
    if (state.surfaceGeneration !== surface.surfaceGeneration ||
      request.inputEpoch < state.inputEpoch) {
      fail("BROWSER_ACTION_STALE", "The browser action belongs to an obsolete input surface or epoch.");
    }
    if (request.inputEpoch > state.inputEpoch) state.inputEpoch = request.inputEpoch;
    if (request.intent === "normal" && state.quarantined) {
      fail(
        "SYSTEM_TRUSTED_INPUT_QUARANTINED",
        "Automatic input is disabled for this role until its surface is restarted."
      );
    }
    const heldKeysAfter = projectedHeldKeys(state.heldKeys, request.action);
    const nativeRequest: ChromiumNativeTrustedInputRequest = Object.freeze({
      requestId: request.requestId,
      roleId: request.roleId,
      inputEpoch: request.inputEpoch,
      intent: request.intent,
      scheduledAtMs: request.scheduledAtMs,
      deadlineMs: request.deadlineMs,
      surfaceGeneration: surface.surfaceGeneration,
      expectedInputNeutralityBefore: state.heldKeys.size === 0,
      expectedInputNeutralityAfter: heldKeysAfter.size === 0,
      action: request.action
    });
    let receipt: unknown;
    try {
      receipt = await this.#input.native.dispatch(nativeRequest);
    } catch {
      state.quarantined = true;
      fail(
        "SYSTEM_TRUSTED_INPUT_INDETERMINATE",
        "The native input adapter ended without an authoritative terminal receipt."
      );
    }
    const observedAtMs = this.#input.nowMs();
    requireSafeInteger(observedAtMs, "native receipt observation time", 1);
    if (!receiptMatches(receipt, nativeRequest, observedAtMs)) {
      state.quarantined = true;
      fail(
        "SYSTEM_TRUSTED_INPUT_INDETERMINATE",
        "The native input adapter returned an invalid or mismatched terminal receipt."
      );
    }
    if (request.intent === "normal" && observedAtMs >= request.deadlineMs) {
      state.quarantined = true;
      fail(
        "SYSTEM_TRUSTED_INPUT_INDETERMINATE",
        "The native input receipt arrived after the declared deadline."
      );
    }
    if (receipt.status === "applied") {
      state.heldKeys.clear();
      for (const identity of heldKeysAfter) state.heldKeys.add(identity);
      if (request.intent === "cleanup" && receipt.confirmedInputNeutrality) {
        state.quarantined = false;
        this.#input.onRecoveryProof?.(Object.freeze({
          kind: "cleanup-neutral",
          requestId: request.requestId,
          roleId: request.roleId,
          inputEpoch: request.inputEpoch,
          surfaceGeneration: surface.surfaceGeneration
        }));
      }
      return Object.freeze({ ...receipt });
    }
    if (receipt.status === "indeterminate" || !receipt.confirmedInputNeutrality) {
      state.quarantined = true;
      fail(
        "SYSTEM_TRUSTED_INPUT_INDETERMINATE",
        receipt.errorMessage ?? "Native input completion is indeterminate."
      );
    }
    if (receipt.status === "superseded") {
      fail("BROWSER_ACTION_STALE", receipt.errorMessage!);
    }
    fail(receipt.errorCode!, receipt.errorMessage!);
  }

  #sameDocumentReplacementLease(
    left: ChromiumTrustedInputDocumentReplacementLease,
    right: ChromiumTrustedInputDocumentReplacementLease
  ): boolean {
    return left.operationId === right.operationId &&
      left.roleId === right.roleId &&
      left.surfaceGeneration === right.surfaceGeneration &&
      left.documentInstanceId === right.documentInstanceId &&
      left.inputEpoch === right.inputEpoch;
  }
}
