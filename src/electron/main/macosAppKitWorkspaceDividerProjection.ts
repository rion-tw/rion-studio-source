import type {
  AppKitRuntimeHostIdentityRecord,
  AppKitRuntimeWindowProjectionRecord,
  AppKitRuntimeWorkspaceDividerLayoutRecord
} from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";
import type { ChromiumRoleSurfaceBounds } from "./chromiumRoleSurfacePorts";
import type { ChromiumRuntimeAppKitProjectionTransaction } from
  "./chromiumRuntimeProjectionTransaction";

export interface MacosAppKitWorkspaceDividerProjectionState {
  nativeRevision: number;
  version: number;
  poisoned: boolean;
  contentBounds: ChromiumRoleSurfaceBounds | null;
  dividers: readonly AppKitRuntimeWorkspaceDividerLayoutRecord[];
}

interface WorkspaceDividerProjectionReceipt {
  readonly projectionRevision: string;
  readonly dividerCount: number;
  readonly contentBounds: ChromiumRoleSurfaceBounds;
}

interface PrepareWorkspaceDividerProjectionInput {
  readonly identity: AppKitRuntimeHostIdentityRecord;
  readonly projection: AppKitRuntimeWindowProjectionRecord;
  readonly state: MacosAppKitWorkspaceDividerProjectionState;
  readonly contentBounds: () => ChromiumRoleSurfaceBounds;
  readonly currentFenceMatches: () => boolean;
  readonly apply: (
    revision: string,
    contentBounds: ChromiumRoleSurfaceBounds,
    dividers: readonly AppKitRuntimeWorkspaceDividerLayoutRecord[]
  ) => WorkspaceDividerProjectionReceipt;
}

function dividerError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    value === value.trim() && !value.includes("/") && !value.includes("\\") &&
    ![...value].some((character) => character.codePointAt(0)! <= 0x1f);
}

function validBounds(value: ChromiumRoleSurfaceBounds): boolean {
  return [value.x, value.y, value.width, value.height].every(
    (coordinate) => Number.isSafeInteger(coordinate)
  ) && value.x >= 0 && value.y >= 0 && value.width > 0 && value.height > 0 &&
    Number.isSafeInteger(value.x + value.width) &&
    Number.isSafeInteger(value.y + value.height);
}

function sameBounds(
  left: ChromiumRoleSurfaceBounds,
  right: ChromiumRoleSurfaceBounds
): boolean {
  return left.x === right.x && left.y === right.y &&
    left.width === right.width && left.height === right.height;
}

function cloneBounds(
  bounds: ChromiumRoleSurfaceBounds
): ChromiumRoleSurfaceBounds {
  return Object.freeze({ ...bounds });
}

function cloneDividers(
  dividers: readonly AppKitRuntimeWorkspaceDividerLayoutRecord[]
): readonly AppKitRuntimeWorkspaceDividerLayoutRecord[] {
  return Object.freeze(dividers.map((divider) => Object.freeze({
    ...divider,
    bounds: Object.freeze({ ...divider.bounds })
  })));
}

function sameDividers(
  left: readonly AppKitRuntimeWorkspaceDividerLayoutRecord[],
  right: readonly AppKitRuntimeWorkspaceDividerLayoutRecord[]
): boolean {
  return left.length === right.length && left.every((divider, index) => {
    const candidate = right[index];
    return candidate !== undefined && divider.tabId === candidate.tabId &&
      divider.attemptGeneration === candidate.attemptGeneration &&
      divider.dividerIndex === candidate.dividerIndex &&
      divider.axis === candidate.axis && divider.visible === candidate.visible &&
      sameBounds(divider.bounds, candidate.bounds);
  });
}

function identitiesMatch(
  left: AppKitRuntimeHostIdentityRecord,
  right: AppKitRuntimeHostIdentityRecord
): boolean {
  return left.logicalWindowId === right.logicalWindowId &&
    left.launchGeneration === right.launchGeneration &&
    left.nativeGeneration === right.nativeGeneration;
}

function validateDividers(
  projection: AppKitRuntimeWindowProjectionRecord
): readonly AppKitRuntimeWorkspaceDividerLayoutRecord[] {
  if (
    projection.workspaceDividers.length > 128 ||
    (projection.workspaceDividers.length > 0 && !projection.activeTabId)
  ) {
    throw dividerError(
      "ELECTRON_MACOS_APPKIT_DIVIDER_PROJECTION_INVALID",
      "Core supplied an invalid bounded active workspace-divider projection."
    );
  }
  const tabIds = new Set(projection.tabs.map((tab) => tab.tabId));
  const seen = new Set<string>();
  for (const divider of projection.workspaceDividers) {
    const key = `${divider.tabId.length}:${divider.tabId}` +
      `${divider.attemptGeneration.length}:${divider.attemptGeneration}:` +
      divider.dividerIndex;
    if (
      !validIdentifier(divider.tabId) ||
      !validIdentifier(divider.attemptGeneration) ||
      !tabIds.has(divider.tabId) || divider.tabId !== projection.activeTabId ||
      !Number.isSafeInteger(divider.dividerIndex) || divider.dividerIndex < 0 ||
      (divider.axis !== "horizontal" && divider.axis !== "vertical") ||
      typeof divider.visible !== "boolean" ||
      divider.visible !== projection.windowVisible ||
      !validBounds(divider.bounds) || seen.has(key)
    ) {
      throw dividerError(
        "ELECTRON_MACOS_APPKIT_DIVIDER_PROJECTION_INVALID",
        "Core supplied a malformed, duplicated, or stale workspace-divider identity."
      );
    }
    seen.add(key);
  }
  return cloneDividers(projection.workspaceDividers);
}

function requireContainedDividers(
  contentBounds: ChromiumRoleSurfaceBounds,
  dividers: readonly AppKitRuntimeWorkspaceDividerLayoutRecord[]
): void {
  if (!validBounds(contentBounds) || dividers.some((divider) =>
    divider.bounds.x < contentBounds.x ||
    divider.bounds.y < contentBounds.y ||
    divider.bounds.x + divider.bounds.width >
      contentBounds.x + contentBounds.width ||
    divider.bounds.y + divider.bounds.height >
      contentBounds.y + contentBounds.height
  )) {
    throw dividerError(
      "ELECTRON_MACOS_APPKIT_DIVIDER_BOUNDS_INVALID",
      "The Core workspace-divider hit rect escapes its exact retained content host."
    );
  }
}

function validateReceipt(
  receipt: WorkspaceDividerProjectionReceipt,
  revision: number,
  contentBounds: ChromiumRoleSurfaceBounds,
  dividerCount: number
): void {
  if (
    receipt.projectionRevision !== String(revision) ||
    receipt.dividerCount !== dividerCount ||
    !sameBounds(receipt.contentBounds, contentBounds)
  ) {
    throw dividerError(
      "ELECTRON_MACOS_APPKIT_DIVIDER_RECEIPT_INVALID",
      "The native AppKit controller returned a mismatched workspace-divider receipt."
    );
  }
}

function nextRevision(current: number): number {
  const next = current + 1;
  if (!Number.isSafeInteger(next)) {
    throw dividerError(
      "ELECTRON_MACOS_APPKIT_DIVIDER_REVISION_EXHAUSTED",
      "The native AppKit workspace-divider revision is exhausted."
    );
  }
  return next;
}

export function createMacosAppKitWorkspaceDividerProjectionState():
MacosAppKitWorkspaceDividerProjectionState {
  return {
    nativeRevision: 0,
    version: 0,
    poisoned: false,
    contentBounds: null,
    dividers: Object.freeze([])
  };
}

export function prepareMacosAppKitWorkspaceDividerProjection(
  input: PrepareWorkspaceDividerProjectionInput
): ChromiumRuntimeAppKitProjectionTransaction {
  const { projection, state } = input;
  if (
    !identitiesMatch(projection.identity, input.identity) ||
    !Number.isSafeInteger(projection.windowGeneration) ||
    projection.windowGeneration < 1 ||
    !Number.isSafeInteger(projection.topologyRevision) ||
    projection.topologyRevision < 1 ||
    !Number.isSafeInteger(projection.adapterSequence) ||
    projection.adapterSequence < 1 || state.poisoned
  ) {
    throw dividerError(
      "ELECTRON_MACOS_APPKIT_DIVIDER_FENCE_STALE",
      "Core supplied a stale AppKit host or poisoned divider projection."
    );
  }
  const nextDividers = validateDividers(projection);
  const preparedVersion = state.version;
  const previousContentBounds = state.contentBounds &&
    cloneBounds(state.contentBounds);
  const previousDividers = state.dividers;
  let phase: "prepared" | "committed" | "rolled-back" | "failed" =
    "prepared";
  let committedVersion = 0;
  let nativeMutationCommitted = false;
  let quarantineRequired = false;

  const applyExact = (
    contentBounds: ChromiumRoleSurfaceBounds,
    dividers: readonly AppKitRuntimeWorkspaceDividerLayoutRecord[]
  ): number => {
    requireContainedDividers(contentBounds, dividers);
    const revision = nextRevision(state.nativeRevision);
    const receipt = input.apply(String(revision), contentBounds, dividers);
    validateReceipt(receipt, revision, contentBounds, dividers.length);
    state.nativeRevision = revision;
    state.contentBounds = cloneBounds(contentBounds);
    state.dividers = dividers;
    state.version += 1;
    state.poisoned = false;
    return state.version;
  };

  const compensateToPrevious = (
    fallbackContentBounds: ChromiumRoleSurfaceBounds
  ): boolean => {
    const contentBounds = previousContentBounds ?? fallbackContentBounds;
    try {
      applyExact(contentBounds, previousDividers);
      return true;
    } catch {
      state.poisoned = true;
      quarantineRequired = true;
      return false;
    }
  };

  return Object.freeze({
    commit: () => {
      if (
        phase !== "prepared" || state.version !== preparedVersion ||
        state.poisoned || !input.currentFenceMatches()
      ) {
        phase = "failed";
        throw dividerError(
          "ELECTRON_MACOS_APPKIT_DIVIDER_PREPARE_STALE",
          "The prepared native divider projection lost its exact Core fence."
        );
      }
      const contentBounds = cloneBounds(input.contentBounds());
      // Geometry validation is side-effect free. Do it before entering the
      // native compensation region so malformed Core bounds never mutate the
      // last verified AppKit projection.
      requireContainedDividers(contentBounds, nextDividers);
      if (
        previousContentBounds && sameBounds(previousContentBounds, contentBounds) &&
        sameDividers(previousDividers, nextDividers)
      ) {
        committedVersion = state.version;
        phase = "committed";
        return;
      }
      try {
        committedVersion = applyExact(contentBounds, nextDividers);
        nativeMutationCommitted = true;
        phase = "committed";
      } catch (error) {
        phase = "failed";
        compensateToPrevious(contentBounds);
        throw error;
      }
    },
    requiresQuarantine: () => quarantineRequired,
    rollback: () => {
      if (
        phase !== "committed" || state.version !== committedVersion ||
        !input.currentFenceMatches()
      ) {
        phase = "failed";
        throw dividerError(
          "ELECTRON_MACOS_APPKIT_DIVIDER_ROLLBACK_STALE",
          "The committed native divider projection changed before rollback."
        );
      }
      if (!nativeMutationCommitted) {
        phase = "rolled-back";
        return;
      }
      const fallback = cloneBounds(input.contentBounds());
      if (!compensateToPrevious(fallback)) {
        phase = "failed";
        throw dividerError(
          "ELECTRON_MACOS_APPKIT_DIVIDER_ROLLBACK_FAILED",
          "The retained AppKit divider projection could not restore its prior state."
        );
      }
      phase = "rolled-back";
    }
  });
}
