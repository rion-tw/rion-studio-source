import { RionBridgeError } from "../ipc/errors";
import type {
  ChromiumRoleSurfaceNativeAttachmentInput,
  ChromiumRoleSurfaceNativeAttachmentPort,
  ChromiumRoleSurfaceNativeReparentInput,
  ChromiumRoleSurfaceParentPort
} from "./chromiumRoleSurfacePorts";
import type { AppKitRuntimeHostIdentity } from "./macosAppKitRuntimeHostFactory";

interface AppKitInputSurfaceCaptureReceipt {
  readonly roleId: string;
  readonly surfaceGeneration: number;
  readonly captureSequence: string;
  readonly observedNodeCount: number;
}

interface AppKitInputSurfaceOwnershipReceipt {
  readonly roleId: string;
  readonly surfaceGeneration: number;
  readonly nativeGeneration: number;
  readonly captureSequence: string;
}

export interface RawNativeAppKitInputSurfaceHost {
  beginInputSurfaceCapture: (
    expected: AppKitRuntimeHostIdentity,
    roleId: string,
    surfaceGeneration: number
  ) => AppKitInputSurfaceCaptureReceipt;
  commitInputSurfaceCapture: (
    expected: AppKitRuntimeHostIdentity,
    roleId: string,
    surfaceGeneration: number,
    captureSequence: string
  ) => AppKitInputSurfaceOwnershipReceipt;
  cancelInputSurfaceCapture: (
    expected: AppKitRuntimeHostIdentity,
    roleId: string,
    surfaceGeneration: number,
    captureSequence: string
  ) => boolean;
  retireInputSurface: (
    expected: AppKitRuntimeHostIdentity,
    roleId: string,
    surfaceGeneration: number
  ) => boolean;
}

export interface MacosAppKitInputHostBinding {
  readonly identity: AppKitRuntimeHostIdentity;
  readonly native: RawNativeAppKitInputSurfaceHost;
  readonly focus: () => void;
  readonly isFocused: () => boolean;
}

export interface MacosAppKitInputHostResolverPort {
  resolve: (
    parent: ChromiumRoleSurfaceParentPort
  ) => MacosAppKitInputHostBinding | null;
  /** True only while the retained Rion launcher still owns application focus. */
  shouldRestoreInitialFocus?: () => boolean;
}

export interface MacosAppKitNonInputSurfaceMutationInput {
  readonly surfaceId: string;
  readonly generation: number;
  readonly parent: ChromiumRoleSurfaceParentPort;
  readonly isCancelled: () => boolean;
  readonly attach: () => void;
  readonly detach: () => void;
}

interface NonInputSurfaceOwnership {
  readonly generation: number;
  readonly detach: () => void;
}

interface HostLane {
  readonly binding: MacosAppKitInputHostBinding;
  readonly ownedGenerationByRole: Map<string, number>;
  readonly nonInputSurfaces: Map<string, NonInputSurfaceOwnership>;
  readonly pendingInputRollbacks: Map<string, PendingInputSurfaceRollback>;
  tail: Promise<void>;
  closing: boolean;
  poisoned: boolean;
}

interface PendingInputSurfaceRollback {
  readonly roleId: string;
  readonly generation: number;
  readonly captureSequence: string;
  readonly nativeAction: "cancel" | "retire";
  detach: (() => void) | null;
  nativePending: boolean;
}

interface InputSurfaceOwner {
  readonly binding: MacosAppKitInputHostBinding;
  readonly generation: number;
}

function attachmentError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function fail(code: string, message: string): never {
  throw attachmentError(code, message);
}

function hostKey(identity: AppKitRuntimeHostIdentity): string {
  if (
    typeof identity.logicalWindowId !== "string" ||
    identity.logicalWindowId.length === 0 ||
    typeof identity.launchGeneration !== "string" ||
    identity.launchGeneration.length === 0 ||
    !Number.isSafeInteger(identity.nativeGeneration) ||
    identity.nativeGeneration < 1
  ) {
    fail(
      "ELECTRON_MACOS_APPKIT_INPUT_HOST_INVALID",
      "The AppKit input attachment does not have an exact native host identity."
    );
  }
  return JSON.stringify([
    identity.logicalWindowId,
    identity.launchGeneration,
    identity.nativeGeneration
  ]);
}

function sameBinding(
  left: MacosAppKitInputHostBinding,
  right: MacosAppKitInputHostBinding
): boolean {
  return left.native === right.native && hostKey(left.identity) === hostKey(right.identity);
}

function exactCapture(
  receipt: AppKitInputSurfaceCaptureReceipt,
  roleId: string,
  generation: number
): string {
  if (
    receipt.roleId !== roleId ||
    receipt.surfaceGeneration !== generation ||
    !/^[1-9][0-9]*$/u.test(receipt.captureSequence) ||
    !Number.isSafeInteger(receipt.observedNodeCount) ||
    receipt.observedNodeCount < 1
  ) {
    fail(
      "ELECTRON_MACOS_APPKIT_INPUT_CAPTURE_INVALID",
      "The AppKit host returned a malformed input-surface capture receipt."
    );
  }
  return receipt.captureSequence;
}

function exactOwnership(
  receipt: AppKitInputSurfaceOwnershipReceipt,
  binding: MacosAppKitInputHostBinding,
  roleId: string,
  generation: number,
  captureSequence: string
): void {
  if (
    receipt.roleId !== roleId ||
    receipt.surfaceGeneration !== generation ||
    receipt.nativeGeneration !== binding.identity.nativeGeneration ||
    receipt.captureSequence !== captureSequence
  ) {
    fail(
      "ELECTRON_MACOS_APPKIT_INPUT_OWNERSHIP_INVALID",
      "The AppKit host returned a mismatched input-surface ownership receipt."
    );
  }
}

/**
 * Serializes begin -> native addChildView -> commit per exact AppKit host.
 * Distinct native hosts retain independent lanes. No timer or repeated scan may
 * infer attachment; each operation settles from the synchronous native ABI.
 */
export class MacosAppKitInputSurfaceAttachmentCoordinator
implements ChromiumRoleSurfaceNativeAttachmentPort {
  readonly #resolver: MacosAppKitInputHostResolverPort;
  readonly #lanes = new Map<string, HostLane>();
  readonly #ownerByRole = new Map<string, InputSurfaceOwner>();
  readonly #initialFocusPreservation = new Map<string, number>();
  readonly #closedBindings = new WeakSet<MacosAppKitInputHostBinding>();

  constructor(resolver: MacosAppKitInputHostResolverPort) {
    this.#resolver = resolver;
  }

  resolveOwnedInputHost(
    roleId: string,
    generation: number
  ): MacosAppKitInputHostBinding | null {
    const owner = this.#ownerByRole.get(roleId);
    if (
      !owner || owner.generation !== generation ||
      this.#closedBindings.has(owner.binding)
    ) {
      return null;
    }
    const lane = this.#lanes.get(hostKey(owner.binding.identity));
    if (
      !lane || lane.closing || lane.poisoned ||
      !sameBinding(lane.binding, owner.binding) ||
      lane.ownedGenerationByRole.get(roleId) !== generation
    ) {
      return null;
    }
    return owner.binding;
  }

  attach(input: ChromiumRoleSurfaceNativeAttachmentInput): Promise<void> {
    const binding = this.#requireBinding(input.parent);
    const lane = this.#lane(binding);
    return this.#enqueue(lane, () => {
      this.#requireOperationalLane(lane);
      if (lane.closing || input.isCancelled()) {
        fail(
          "ELECTRON_MACOS_APPKIT_INPUT_ATTACH_CANCELLED",
          "The AppKit host closed before the input surface could attach."
        );
      }
      if (lane.ownedGenerationByRole.has(input.roleId)) {
        fail(
          "ELECTRON_MACOS_APPKIT_INPUT_OWNERSHIP_CONFLICT",
          "The role already owns an AppKit input surface on this host."
        );
      }
      if (this.#ownerByRole.has(input.roleId)) {
        fail(
          "ELECTRON_MACOS_APPKIT_INPUT_OWNERSHIP_CONFLICT",
          "The role already owns an AppKit input surface on another host."
        );
      }
      const captureSequence = exactCapture(
        binding.native.beginInputSurfaceCapture(
          binding.identity,
          input.roleId,
          input.generation
        ),
        input.roleId,
        input.generation
      );
      const preserveFocus = binding.isFocused();
      let attached = false;
      let nativeCommitted = false;
      try {
        if (lane.closing || input.isCancelled()) {
          fail(
            "ELECTRON_MACOS_APPKIT_INPUT_ATTACH_CANCELLED",
            "The AppKit host closed during input-surface capture."
          );
        }
        attached = true;
        input.attach();
        const ownership = binding.native.commitInputSurfaceCapture(
          binding.identity,
          input.roleId,
          input.generation,
          captureSequence
        );
        nativeCommitted = true;
        exactOwnership(
          ownership,
          binding,
          input.roleId,
          input.generation,
          captureSequence
        );
        lane.ownedGenerationByRole.set(input.roleId, input.generation);
        this.#ownerByRole.set(input.roleId, {
          binding,
          generation: input.generation
        });
        // addChildView may enqueue AppKit's blur after this synchronous native
        // transaction returns, so the captured foreground owner must always
        // be reasserted rather than guarded by an immediate focus readback.
        if (preserveFocus) {
          this.#initialFocusPreservation.set(input.roleId, input.generation);
          binding.focus();
        }
      } catch (error) {
        let rollbackError: RionBridgeError | null = null;
        let detachPending: (() => void) | null = null;
        if (attached) {
          try {
            input.detach();
          } catch {
            detachPending = input.detach;
            rollbackError = attachmentError(
              "ELECTRON_MACOS_APPKIT_INPUT_ATTACH_ROLLBACK_FAILED",
              "The failed AppKit input surface could not detach before the next capture."
            );
          }
        }
        let nativePending = false;
        const nativeAction = nativeCommitted ? "retire" as const : "cancel" as const;
        try {
          const compensated = nativeCommitted
            ? binding.native.retireInputSurface(
              binding.identity,
              input.roleId,
              input.generation
            )
            : binding.native.cancelInputSurfaceCapture(
              binding.identity,
              input.roleId,
              input.generation,
              captureSequence
            );
          if (!compensated) {
            nativePending = true;
          }
        } catch {
          nativePending = true;
        }
        if (detachPending || nativePending) {
          lane.poisoned = true;
          lane.pendingInputRollbacks.set(input.roleId, {
            roleId: input.roleId,
            generation: input.generation,
            captureSequence,
            nativeAction,
            detach: detachPending,
            nativePending
          });
          rollbackError ??= attachmentError(
            "ELECTRON_MACOS_APPKIT_INPUT_ATTACH_ROLLBACK_FAILED",
            "The failed AppKit capture could not establish exact rollback and quarantined its host."
          );
        }
        this.#deleteExactOwner(input.roleId, input.generation, binding);
        if (rollbackError) throw rollbackError;
        throw error;
      }
    });
  }

  initialLoadCommitted(
    roleId: string,
    generation: number,
    parent: ChromiumRoleSurfaceParentPort
  ): void {
    const pendingGeneration = this.#initialFocusPreservation.get(roleId);
    if (pendingGeneration === undefined) return;
    const binding = this.#requireBinding(parent);
    const owner = this.#ownerByRole.get(roleId);
    if (
      pendingGeneration !== generation || !owner ||
      owner.generation !== generation || !sameBinding(owner.binding, binding)
    ) {
      fail(
        "ELECTRON_MACOS_APPKIT_INITIAL_FOCUS_STALE",
        "The loaded Chromium surface no longer owns its captured AppKit focus lease."
      );
    }
    this.#initialFocusPreservation.delete(roleId);
    if (binding.isFocused()) return;
    // Do not reactivate Rion after the user selected an external application
    // or another runtime host. The launcher is the only expected same-app
    // recipient of Chromium's attachment-time focus handoff.
    if (this.#resolver.shouldRestoreInitialFocus?.() !== true) return;
    binding.focus();
  }

  async reparent(input: ChromiumRoleSurfaceNativeReparentInput): Promise<void> {
    const sourceBinding = this.#requireBinding(input.sourceParent);
    const targetBinding = this.#requireBinding(input.targetParent);
    if (sameBinding(sourceBinding, targetBinding)) {
      fail(
        "ELECTRON_MACOS_APPKIT_INPUT_REPARENT_HOST_CONFLICT",
        "An AppKit input surface cannot move between two parents of the same native host."
      );
    }
    const sourceLane = this.#lane(sourceBinding);
    await this.#enqueue(sourceLane, () => {
      this.#requireOperationalLane(sourceLane);
      if (sourceLane.closing || input.isCancelled()) {
        fail(
          "ELECTRON_MACOS_APPKIT_INPUT_REPARENT_CANCELLED",
          "The AppKit input surface move was cancelled before source retirement."
        );
      }
      const ownedGeneration = sourceLane.ownedGenerationByRole.get(input.roleId);
      if (ownedGeneration !== input.generation) {
        fail(
          "ELECTRON_MACOS_APPKIT_INPUT_REPARENT_SOURCE_STALE",
          "The source AppKit host does not own the exact role generation."
        );
      }
      if (!sourceBinding.native.retireInputSurface(
        sourceBinding.identity,
        input.roleId,
        input.generation
      )) {
        fail(
          "ELECTRON_MACOS_APPKIT_INPUT_REPARENT_SOURCE_MISSING",
          "The exact source AppKit input surface was absent during reparenting."
        );
      }
      sourceLane.ownedGenerationByRole.delete(input.roleId);
      this.#deleteExactOwner(input.roleId, input.generation, sourceBinding);
      input.detachSource();
    });

    try {
      await this.attach({
        roleId: input.roleId,
        generation: input.generation,
        parent: input.targetParent,
        isCancelled: input.isCancelled,
        attach: input.attachTarget,
        detach: input.detachTarget
      });
    } catch (targetError) {
      try {
        await this.attach({
          roleId: input.roleId,
          generation: input.generation,
          parent: input.sourceParent,
          isCancelled: input.isCancelled,
          attach: input.restoreSource,
          detach: input.detachSource
        });
      } catch {
        fail(
          "ELECTRON_MACOS_APPKIT_INPUT_REPARENT_ROLLBACK_FAILED",
          "The AppKit input surface could not attach to its target or restore exact source ownership."
        );
      }
      throw targetError;
    }
  }

  retire(
    roleId: string,
    generation: number,
    parent: ChromiumRoleSurfaceParentPort
  ): Promise<void> {
    const binding = this.#requireBinding(parent);
    const lane = this.#lane(binding);
    return this.#enqueue(lane, () => {
      this.#requireOperationalLane(lane);
      const ownedGeneration = lane.ownedGenerationByRole.get(roleId);
      if (ownedGeneration === undefined) return;
      if (ownedGeneration !== generation) {
        fail(
          "ELECTRON_MACOS_APPKIT_INPUT_RETIRE_STALE",
          "The AppKit input-surface retirement generation is stale."
        );
      }
      if (!binding.native.retireInputSurface(binding.identity, roleId, generation)) {
        fail(
          "ELECTRON_MACOS_APPKIT_INPUT_RETIRE_MISSING",
          "The exact AppKit input surface was absent during retirement."
        );
      }
      lane.ownedGenerationByRole.delete(roleId);
      this.#deleteExactOwner(roleId, generation, binding);
    });
  }

  /**
   * Queues an AppKit child-view add that deliberately receives no trusted
   * input ownership. Future global Web surfaces must use this method so their
   * native mutation cannot interleave with role begin/add/commit capture.
   */
  attachNonInputSurface(input: MacosAppKitNonInputSurfaceMutationInput): Promise<void> {
    const binding = this.#requireBinding(input.parent);
    const lane = this.#lane(binding);
    return this.#enqueue(lane, () => {
      this.#requireOperationalLane(lane);
      if (lane.closing || input.isCancelled()) {
        fail(
          "ELECTRON_MACOS_APPKIT_NATIVE_VIEW_ATTACH_CANCELLED",
          "The AppKit host closed before the non-input surface could attach."
        );
      }
      if (
        typeof input.surfaceId !== "string" || input.surfaceId.length === 0 ||
        !Number.isSafeInteger(input.generation) || input.generation < 1 ||
        lane.nonInputSurfaces.has(input.surfaceId)
      ) {
        fail(
          "ELECTRON_MACOS_APPKIT_NATIVE_VIEW_OWNERSHIP_CONFLICT",
          "The non-input AppKit surface identity is invalid or already owned."
        );
      }
      input.attach();
      lane.nonInputSurfaces.set(input.surfaceId, {
        generation: input.generation,
        detach: input.detach
      });
    });
  }

  detachNonInputSurface(
    surfaceId: string,
    generation: number,
    parent: ChromiumRoleSurfaceParentPort
  ): Promise<void> {
    const binding = this.#requireBinding(parent);
    const lane = this.#lane(binding);
    return this.#enqueue(lane, () => {
      this.#requireOperationalLane(lane);
      const ownership = lane.nonInputSurfaces.get(surfaceId);
      if (!ownership || ownership.generation !== generation) {
        fail(
          "ELECTRON_MACOS_APPKIT_NATIVE_VIEW_RETIRE_STALE",
          "The non-input AppKit surface retirement identity is stale."
        );
      }
      ownership.detach();
      lane.nonInputSurfaces.delete(surfaceId);
    });
  }

  closeHost(binding: MacosAppKitInputHostBinding): Promise<void> {
    const key = hostKey(binding.identity);
    const lane = this.#lanes.get(key);
    if (lane && !sameBinding(lane.binding, binding)) {
      return Promise.reject(attachmentError(
        "ELECTRON_MACOS_APPKIT_INPUT_HOST_STALE",
        "The AppKit input host close identity is stale."
      ));
    }
    this.#closedBindings.add(binding);
    if (!lane) return Promise.resolve();
    lane.closing = true;
    return this.#enqueue(lane, () => {
      const failures: unknown[] = [];
      for (const [roleId, rollback] of lane.pendingInputRollbacks) {
        if (rollback.detach) {
          try {
            rollback.detach();
            rollback.detach = null;
          } catch (error) {
            failures.push(error);
          }
        }
        if (rollback.nativePending) {
          try {
            const compensated = rollback.nativeAction === "retire"
              ? binding.native.retireInputSurface(
                binding.identity,
                rollback.roleId,
                rollback.generation
              )
              : binding.native.cancelInputSurfaceCapture(
                binding.identity,
                rollback.roleId,
                rollback.generation,
                rollback.captureSequence
              );
            if (compensated) rollback.nativePending = false;
            else failures.push(roleId);
          } catch (error) {
            failures.push(error);
          }
        }
        if (!rollback.detach && !rollback.nativePending) {
          lane.pendingInputRollbacks.delete(roleId);
        }
      }
      for (const [roleId, generation] of lane.ownedGenerationByRole) {
        try {
          if (binding.native.retireInputSurface(binding.identity, roleId, generation)) {
            lane.ownedGenerationByRole.delete(roleId);
            this.#deleteExactOwner(roleId, generation, binding);
          } else {
            failures.push(roleId);
          }
        } catch (error) {
          failures.push(error);
        }
      }
      for (const [surfaceId, ownership] of lane.nonInputSurfaces) {
        try {
          ownership.detach();
          lane.nonInputSurfaces.delete(surfaceId);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        fail(
          "ELECTRON_MACOS_APPKIT_INPUT_HOST_RETIRE_FAILED",
          "One or more AppKit input surfaces failed exact host-close retirement."
        );
      }
      lane.poisoned = false;
      this.#lanes.delete(key);
    });
  }

  #requireBinding(parent: ChromiumRoleSurfaceParentPort): MacosAppKitInputHostBinding {
    const binding = this.#resolver.resolve(parent);
    if (!binding || parent.isDestroyed()) {
      fail(
        "ELECTRON_MACOS_APPKIT_INPUT_HOST_UNAVAILABLE",
        "The role surface has no live exact AppKit input host."
      );
    }
    if (this.#closedBindings.has(binding)) {
      fail(
        "ELECTRON_MACOS_APPKIT_INPUT_HOST_CLOSED",
        "The exact AppKit input host already completed native retirement."
      );
    }
    return binding;
  }

  #lane(binding: MacosAppKitInputHostBinding): HostLane {
    const key = hostKey(binding.identity);
    const existing = this.#lanes.get(key);
    if (existing) {
      if (!sameBinding(existing.binding, binding)) {
        fail(
          "ELECTRON_MACOS_APPKIT_INPUT_HOST_STALE",
          "The AppKit input host binding changed without exact retirement."
        );
      }
      return existing;
    }
    const lane: HostLane = {
      binding,
      ownedGenerationByRole: new Map(),
      nonInputSurfaces: new Map(),
      pendingInputRollbacks: new Map(),
      tail: Promise.resolve(),
      closing: false,
      poisoned: false
    };
    this.#lanes.set(key, lane);
    return lane;
  }

  #enqueue(lane: HostLane, operation: () => void): Promise<void> {
    const result = lane.tail.catch(() => undefined).then(operation);
    lane.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  #requireOperationalLane(lane: HostLane): void {
    if (lane.poisoned) {
      fail(
        "ELECTRON_MACOS_APPKIT_INPUT_HOST_QUARANTINED",
        "The AppKit input host has an unresolved attachment rollback and must close."
      );
    }
  }

  #deleteExactOwner(
    roleId: string,
    generation: number,
    binding: MacosAppKitInputHostBinding
  ): void {
    const owner = this.#ownerByRole.get(roleId);
    if (
      owner && owner.generation === generation &&
      sameBinding(owner.binding, binding)
    ) {
      this.#ownerByRole.delete(roleId);
      if (this.#initialFocusPreservation.get(roleId) === generation) {
        this.#initialFocusPreservation.delete(roleId);
      }
    }
  }
}
