import type {
  AppKitRuntimeHostIdentityRecord,
  CoreAppSnapshotRecord,
  DisplayTopologySnapshotRecord,
  EmbeddedLaunchTargetRecord
} from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";
import { displayById, sameBounds, validBounds } from "./chromiumRuntimeLaunchGeometry";
import { inspectLaunchWindowFence } from "./chromiumRuntimeLaunchWindowFence";
import type { ChromiumRuntimeExecutorSnapshot } from "./chromiumRuntimeSnapshot";

function topologyError(message: string): never {
  throw new RionBridgeError({ code: "ELECTRON_CHROMIUM_LAUNCH_TOPOLOGY_INVALID", message });
}

function canonicalTopology(topology: DisplayTopologySnapshotRecord): string {
  if (!Number.isSafeInteger(topology.revision) || topology.revision < 1) {
    topologyError("The Electron display-topology revision is invalid.");
  }
  const displayIds = new Set<number>();
  const displays = [...topology.displays].map(display => {
    if (!Number.isSafeInteger(display.id) || displayIds.has(display.id) ||
        !Number.isFinite(display.scaleFactor) || display.scaleFactor <= 0 ||
        display.scaleFactor > 8 || !validBounds(display.bounds) || !validBounds(display.workArea)) {
      topologyError("Electron reported an invalid display while resolving a Chromium launch.");
    }
    displayIds.add(display.id);
    return { id: display.id, label: display.label, bounds: { ...display.bounds },
      workArea: { ...display.workArea }, resolution: { ...display.resolution },
      scaleFactor: display.scaleFactor, isPrimary: display.isPrimary, isInternal: display.isInternal };
  }).sort((left, right) => left.id - right.id);
  const primary = displays.filter(display => display.isPrimary);
  if (primary.length !== 1 || topology.primaryDisplayId !== String(primary[0]!.id)) {
    topologyError("Electron reported an ambiguous primary display.");
  }
  return JSON.stringify({ primaryDisplayId: topology.primaryDisplayId, displays });
}

export function sameTopologyRevision(
  expected: DisplayTopologySnapshotRecord,
  received: DisplayTopologySnapshotRecord
): boolean {
  return expected.revision === received.revision &&
    canonicalTopology(expected) === canonicalTopology(received);
}

/** Fullscreen Spaces can change only the admitted monitor's usable work area. */
export function fullscreenTargetWorkAreaChanged(
  expected: DisplayTopologySnapshotRecord,
  received: DisplayTopologySnapshotRecord,
  target: EmbeddedLaunchTargetRecord
): boolean {
  if (target.presentation !== "fullscreen" || !Number.isSafeInteger(received.revision) ||
      received.revision <= expected.revision) return false;
  const before = displayById(expected, target.displayId);
  const after = displayById(received, target.displayId);
  if (!before || !after || sameBounds(before.workArea, after.workArea)) return false;
  const comparison = { ...expected, displays: expected.displays.map(display =>
    display.id === target.displayId ? { ...display, workArea: after.workArea } : display) };
  return canonicalTopology(comparison) === canonicalTopology(received);
}

interface EmptyFullscreenOwner {
  readonly nativeHostId: number;
  readonly windowGeneration: number;
  readonly topologyRevision: number;
  readonly identity: Readonly<AppKitRuntimeHostIdentityRecord>;
}

export function captureEmptyAppKitFullscreenOwner(
  core: CoreAppSnapshotRecord,
  native: ChromiumRuntimeExecutorSnapshot,
  target: EmbeddedLaunchTargetRecord
): EmptyFullscreenOwner | null {
  const windows = native.windows.filter(window => window.windowId === target.windowId);
  const window = windows[0];
  const identity = window?.appKitIdentity;
  if (target.presentation !== "fullscreen" || windows.length !== 1 || !window || !identity ||
      identity.logicalWindowId !== target.windowId || identity.launchGeneration.trim().length === 0 ||
      identity.launchGeneration !== identity.launchGeneration.trim() ||
      !Number.isSafeInteger(identity.nativeGeneration) || identity.nativeGeneration < 1 ||
      !Number.isSafeInteger(window.parentNativeHostId) || window.parentNativeHostId! < 1 ||
      !Number.isSafeInteger(window.windowGeneration) || window.windowGeneration < 1 ||
      !Number.isSafeInteger(window.topologyRevision) || window.topologyRevision < 1 ||
      window.presentation !== "fullscreen" || !window.visible || window.tabIds.length !== 0 ||
      window.activeTabId !== "" || window.pendingInitialPresentation !== undefined ||
      !validBounds(window.bounds, 640, 480) ||
      core.logicalWindows.find(logical => logical.windowId === target.windowId)?.presentation !== "fullscreen" ||
      inspectLaunchWindowFence(core, native, target.windowId).reason !== null) return null;
  return Object.freeze({ nativeHostId: window.parentNativeHostId!,
    windowGeneration: window.windowGeneration, topologyRevision: window.topologyRevision,
    identity: Object.freeze({ ...identity }) });
}

/** A comparison target only; the Core request and saved normal geometry stay owned. */
export function emptyWindowRegistrationReceiptTarget(input: Readonly<{
  expected: DisplayTopologySnapshotRecord;
  received: DisplayTopologySnapshotRecord;
  target: EmbeddedLaunchTargetRecord;
  originalOwner: EmptyFullscreenOwner | null;
  core: CoreAppSnapshotRecord;
  native: ChromiumRuntimeExecutorSnapshot;
}>): EmbeddedLaunchTargetRecord | null {
  const { expected, received, target, originalOwner } = input;
  if (sameTopologyRevision(expected, received)) return target;
  if (!originalOwner || !fullscreenTargetWorkAreaChanged(expected, received, target)) return null;
  const current = captureEmptyAppKitFullscreenOwner(input.core, input.native, target);
  if (!current || current.nativeHostId !== originalOwner.nativeHostId ||
      current.windowGeneration !== originalOwner.windowGeneration ||
      current.topologyRevision < originalOwner.topologyRevision ||
      current.identity.logicalWindowId !== originalOwner.identity.logicalWindowId ||
      current.identity.launchGeneration !== originalOwner.identity.launchGeneration ||
      current.identity.nativeGeneration !== originalOwner.identity.nativeGeneration) return null;
  return { ...target, workArea: { ...displayById(received, target.displayId)!.workArea } };
}
