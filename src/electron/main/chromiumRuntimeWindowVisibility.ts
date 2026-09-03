import type {
  CoreEffectRequest,
  RuntimeWindowVisibilityNativeObservationRecord,
  RuntimeWindowVisibilityNativeReceiptRecord
} from "../../shared/generated";
import { normalizeRionBridgeError, RionBridgeError } from "../ipc/errors";
import {
  coreEffectEventContinuation,
  type CoreEffectEventContinuation
} from "./coreEffectContinuation";
import type {
  ChromiumRuntimeGlobalWebSurfacePort,
  ChromiumRuntimeSurfacePort
} from "./chromiumRuntimeEffectExecutor";
import type {
  ChromiumRuntimeRoleRecord,
  ChromiumRuntimeWebSurfaceRecord,
  ChromiumRuntimeWindowRecord
} from "./chromiumRuntimeAppKitProjection";
import type {
  ChromiumRuntimeOwnershipTransitionCoordinator,
  ChromiumRuntimeOwnershipTransitionReceipt
} from "./chromiumRuntimeOwnershipTransitionCoordinator";

interface RuntimeVisibilityState {
  readonly ports: Readonly<{
    surfaces: Pick<ChromiumRuntimeSurfacePort, "setVisible">;
    webSurfaces: Pick<ChromiumRuntimeGlobalWebSurfacePort, "setVisible">;
  }>;
  readonly windows: Map<string, ChromiumRuntimeWindowRecord>;
  readonly roles: Map<string, ChromiumRuntimeRoleRecord>;
  readonly webSurfaces: Map<string, ChromiumRuntimeWebSurfaceRecord>;
}

interface ApplyRuntimeWindowVisibilityEffectInput extends RuntimeVisibilityState {
  readonly effect: CoreEffectRequest;
  readonly action: Extract<CoreEffectRequest["action"], {
    type: "embeddedSetRuntimeWindowVisibility";
  }>;
  readonly quarantineWindows: (windowIds: readonly string[]) => Promise<void>;
  readonly reconcileProjection: () => Promise<void>;
  readonly ownershipTransitions: ChromiumRuntimeOwnershipTransitionCoordinator;
}

function visibilityError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value === value.trim() &&
    ![...value].some((character) => character.codePointAt(0)! <= 0x1f);
}

async function quarantineVisibilityFailure(
  input: ApplyRuntimeWindowVisibilityEffectInput
): Promise<never> {
  try {
    await input.quarantineWindows([input.action.windowId]);
  } catch {
    throw visibilityError(
      "CHROMIUM_RUNTIME_WINDOW_VISIBILITY_QUARANTINE_FAILED",
      "The runtime host visibility result and its quarantine are indeterminate."
    );
  }
  throw visibilityError(
    "CHROMIUM_RUNTIME_WINDOW_VISIBILITY_HOST_QUARANTINED",
    "The runtime host was quarantined after its visibility result became unknown."
  );
}

function exactVisibilityObservation(
  effect: CoreEffectRequest,
  action: ApplyRuntimeWindowVisibilityEffectInput["action"],
  window: ChromiumRuntimeWindowRecord,
  receipt: ChromiumRuntimeOwnershipTransitionReceipt
): RuntimeWindowVisibilityNativeObservationRecord {
  const observation = receipt.windows[0];
  const expectedAppKitIdentity = window.host.appKitIdentity;
  const appKitIdentityMatches = expectedAppKitIdentity
    ? observation?.appKitIdentity?.logicalWindowId ===
        expectedAppKitIdentity.logicalWindowId &&
      observation.appKitIdentity.launchGeneration ===
        expectedAppKitIdentity.launchGeneration &&
      observation.appKitIdentity.nativeGeneration ===
        expectedAppKitIdentity.nativeGeneration &&
      observation.nativeGeneration === expectedAppKitIdentity.nativeGeneration
    : observation?.appKitIdentity === undefined;
  if (
    receipt.status !== "applied" ||
    receipt.effectId !== effect.effectId ||
    receipt.operationId !== effect.operationId ||
    receipt.lifecycleEpoch !== action.lifecycleEpoch ||
    receipt.windows.length !== 1 || !observation ||
    observation.platform !== (expectedAppKitIdentity ? "macos" : "windows") ||
    !Number.isSafeInteger(observation.sequence) || observation.sequence < 1 ||
    !Number.isSafeInteger(observation.nativeHostId) ||
    observation.nativeHostId < 1 ||
    !Number.isSafeInteger(observation.nativeGeneration) ||
    observation.nativeGeneration < 1 ||
    observation.source === "closed" || observation.source === "failed" ||
    observation.lifecycleEpoch !== action.lifecycleEpoch ||
    observation.logicalWindowId !== action.windowId ||
    observation.windowGeneration !== action.windowGeneration ||
    observation.topologyRevision !== action.topologyRevision ||
    observation.visible !== action.visible ||
    (action.visible && observation.minimized) ||
    (observation.focused && (
      !observation.visible || observation.minimized || !observation.foreground
    )) ||
    (expectedAppKitIdentity !== undefined &&
      observation.focused !== observation.foreground) ||
    observation.failureCode !== undefined ||
    !appKitIdentityMatches
  ) {
    throw visibilityError(
      "ELECTRON_CHROMIUM_WINDOW_VISIBILITY_RECEIPT_INVALID",
      "The native runtime host returned mismatched visibility evidence."
    );
  }
  return observation;
}

function nativeVisibilityReceipt(
  receipt: ChromiumRuntimeOwnershipTransitionReceipt
): RuntimeWindowVisibilityNativeReceiptRecord {
  return {
    effectId: receipt.effectId,
    operationId: receipt.operationId,
    lifecycleEpoch: receipt.lifecycleEpoch,
    status: receipt.status,
    windows: receipt.windows.map((observation) => ({ ...observation }))
  };
}

export function applyChromiumRuntimeWindowSurfaceVisibility(
  input: RuntimeVisibilityState,
  window: ChromiumRuntimeWindowRecord,
  windowVisible: boolean
): void {
  for (const role of input.roles.values()) {
    if (role.windowId !== window.host.logicalWindowId) continue;
    input.ports.surfaces.setVisible(
      role.roleId,
      role.generation,
      windowVisible && role.tabId === window.activeTabId &&
        !window.hiddenTabIds.has(role.tabId)
    );
  }
  for (const surface of input.webSurfaces.values()) {
    if (surface.windowId !== window.host.logicalWindowId) continue;
    input.ports.webSurfaces.setVisible(
      surface.surfaceId,
      surface.generation,
      windowVisible && surface.tabId === window.activeTabId &&
        !window.hiddenTabIds.has(surface.tabId)
    );
  }
}

/**
 * Applies the exact Core visibility effect. AppKit hosts require the native
 * owner identity emitted by the same AppKit event transaction. Any mutation
 * whose result cannot be read back exactly quarantines the affected host.
 */
export function applyChromiumRuntimeWindowVisibilityEffect(
  input: ApplyRuntimeWindowVisibilityEffectInput
): CoreEffectEventContinuation<RuntimeWindowVisibilityNativeReceiptRecord> {
  const { action } = input;
  if (!validIdentifier(action.windowId)) {
    throw visibilityError(
      "ELECTRON_CHROMIUM_WINDOW_VISIBILITY_STALE",
      "Core supplied an invalid runtime window visibility identity."
    );
  }
  const window = input.windows.get(action.windowId);
  if (
    input.effect.target.handleId !== action.windowId ||
    input.effect.completionPolicy !== "eventBound" ||
    input.effect.deadlineMs !== undefined || !window ||
    window.host.isDestroyed() ||
    action.windowGeneration !== window.windowGeneration ||
    action.topologyRevision !== window.topologyRevision
  ) {
    throw visibilityError(
      "ELECTRON_CHROMIUM_WINDOW_VISIBILITY_STALE",
      "Core supplied a stale runtime window visibility fence."
    );
  }
  const nativeIdentity = window.host.appKitIdentity;
  if (action.appkitIdentity === undefined) {
    if (nativeIdentity !== undefined) {
      throw visibilityError(
        "ELECTRON_MACOS_APPKIT_VISIBILITY_FENCE_MISSING",
        "A retained AppKit host requires its exact native visibility identity."
      );
    }
  } else if (
    !nativeIdentity ||
    nativeIdentity.logicalWindowId !== action.appkitIdentity.logicalWindowId ||
    nativeIdentity.launchGeneration !== action.appkitIdentity.launchGeneration ||
    nativeIdentity.nativeGeneration !== action.appkitIdentity.nativeGeneration
  ) {
    throw visibilityError(
      "ELECTRON_MACOS_APPKIT_VISIBILITY_FENCE_STALE",
      "Core supplied a stale AppKit visibility host identity."
    );
  }

  input.ownershipTransitions.synchronize(
    [...input.windows.values()].map((record) => record.host)
  );
  const transition = input.ownershipTransitions.begin(
    input.effect,
    action.lifecycleEpoch,
    [{
      host: window.host,
      mode: action.visible ? "reveal" : "hide",
      windowGeneration: window.windowGeneration,
      topologyRevision: window.topologyRevision
    }]
  );
  const completion = transition.completion.then(
    async (receipt: ChromiumRuntimeOwnershipTransitionReceipt) => {
      if (receipt.status === "superseded") {
        return nativeVisibilityReceipt(receipt);
      }
      try {
        const observation = exactVisibilityObservation(
          input.effect,
          action,
          window,
          receipt
        );
        applyChromiumRuntimeWindowSurfaceVisibility(
          input,
          window,
          observation.visible
        );
        await input.reconcileProjection();
      } catch {
        return quarantineVisibilityFailure(input);
      }
      return nativeVisibilityReceipt(receipt);
    },
    (error: unknown) => {
      const normalized = normalizeRionBridgeError(
        error,
        "ELECTRON_CHROMIUM_WINDOW_VISIBILITY_FAILED"
      );
      return normalized.code ===
        "CHROMIUM_RUNTIME_WINDOW_TRANSITION_INDETERMINATE"
        ? quarantineVisibilityFailure(input)
        : Promise.reject(error);
    }
  );
  return coreEffectEventContinuation(completion, transition.cancel);
}
