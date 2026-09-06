import { randomUUID } from "node:crypto";

import type {
  CoreCommand,
  CoreCommandResult,
  CoreErrorPayload,
  DisplayInfoRecord,
  DisplayTopologySnapshotRecord,
  WindowsRuntimeWindowPlacementEventRecord,
  WindowsRuntimeWindowPlacementReceiptRecord
} from "../../shared/generated";
import { normalizeRionBridgeError, RionBridgeError } from "../ipc/errors";
import type {
  ChromiumRuntimeHostPort,
  WindowsRuntimeWindowPlacementObservation
} from "./chromiumRuntimeHostPorts";
import type { ChromiumRoleSurfaceBounds } from "./chromiumRoleSurfacePorts";

export interface WindowsRuntimeWindowPlacementInspection {
  readonly event?: WindowsRuntimeWindowPlacementEventRecord;
  readonly receipt?: WindowsRuntimeWindowPlacementReceiptRecord;
  readonly status: WindowsRuntimeWindowPlacementReceiptRecord["status"];
  readonly verified: boolean;
  readonly failureCode?: string;
}

export interface WindowsRuntimeWindowPlacementControllerInput {
  readonly core: {
    invoke: <Command extends CoreCommand>(
      command: Command
    ) => Promise<CoreCommandResult<Command>>;
  };
  readonly readDisplayTopology: () => DisplayTopologySnapshotRecord;
  readonly onError: (error: CoreErrorPayload) => void;
  readonly onApplied?: (
    event: WindowsRuntimeWindowPlacementEventRecord,
    receipt: WindowsRuntimeWindowPlacementReceiptRecord
  ) => void;
}

const MAX_RECEIPTS = 128;

function placementError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function validBounds(bounds: ChromiumRoleSurfaceBounds): boolean {
  return [bounds.x, bounds.y, bounds.width, bounds.height].every(
    Number.isSafeInteger
  ) && bounds.width > 0 && bounds.height > 0;
}

function sameBounds(
  left: ChromiumRoleSurfaceBounds,
  right: ChromiumRoleSurfaceBounds
): boolean {
  return left.x === right.x && left.y === right.y &&
    left.width === right.width && left.height === right.height;
}

function validObservation(
  value: WindowsRuntimeWindowPlacementObservation
): boolean {
  return Number.isSafeInteger(value.nativeHostId) && value.nativeHostId > 0 &&
    Number.isSafeInteger(value.nativeGeneration) && value.nativeGeneration > 0 &&
    value.windowId.length > 0 && value.windowId === value.windowId.trim() &&
    Number.isSafeInteger(value.windowGeneration) && value.windowGeneration > 0 &&
    Number.isSafeInteger(value.topologyRevision) && value.topologyRevision > 0 &&
    Number.isSafeInteger(value.displayId) && value.displayId >= 0 &&
    validBounds(value.normalBounds) && validBounds(value.savedWorkArea) &&
    new Set(["normal", "maximized", "fullscreen"]).has(value.presentation);
}

function cloneObservation(
  value: WindowsRuntimeWindowPlacementObservation
): WindowsRuntimeWindowPlacementObservation {
  if (!validObservation(value)) {
    throw placementError(
      "ELECTRON_WINDOWS_RUNTIME_PLACEMENT_OBSERVATION_INVALID",
      "The native Windows placement observer returned an invalid host fence."
    );
  }
  return Object.freeze({
    ...value,
    normalBounds: Object.freeze({ ...value.normalBounds }),
    savedWorkArea: Object.freeze({ ...value.savedWorkArea })
  });
}

function sameObservation(
  left: WindowsRuntimeWindowPlacementObservation,
  right: WindowsRuntimeWindowPlacementObservation
): boolean {
  return left.nativeHostId === right.nativeHostId &&
    left.nativeGeneration === right.nativeGeneration &&
    left.windowId === right.windowId &&
    left.windowGeneration === right.windowGeneration &&
    left.topologyRevision === right.topologyRevision &&
    left.displayId === right.displayId &&
    left.presentation === right.presentation &&
    sameBounds(left.normalBounds, right.normalBounds) &&
    sameBounds(left.savedWorkArea, right.savedWorkArea);
}

function canonicalTopology(topology: DisplayTopologySnapshotRecord): string {
  if (!Number.isSafeInteger(topology.revision) || topology.revision < 1 ||
      !Array.isArray(topology.displays) || topology.displays.length === 0) {
    throw placementError(
      "ELECTRON_WINDOWS_RUNTIME_DISPLAY_TOPOLOGY_INVALID",
      "The latest Electron display topology is missing an exact revision."
    );
  }
  return JSON.stringify({
    revision: topology.revision,
    primaryDisplayId: topology.primaryDisplayId,
    displays: topology.displays.map((display) => ({
      id: display.id,
      label: display.label,
      bounds: display.bounds,
      workArea: display.workArea,
      resolution: display.resolution,
      scaleFactor: display.scaleFactor,
      isPrimary: display.isPrimary,
      isInternal: display.isInternal
    }))
  });
}

function displayFor(
  topology: DisplayTopologySnapshotRecord,
  observation: WindowsRuntimeWindowPlacementObservation
): DisplayInfoRecord {
  canonicalTopology(topology);
  const display = topology.displays.find(
    (candidate) => candidate.id === observation.displayId
  );
  if (!display || !sameBounds(display.workArea, observation.savedWorkArea) ||
      display.label.trim().length === 0 || !validBounds(display.bounds) ||
      display.resolution.width < 1 || display.resolution.height < 1 ||
      !Number.isFinite(display.scaleFactor) || display.scaleFactor <= 0) {
    throw placementError(
      "ELECTRON_WINDOWS_RUNTIME_DISPLAY_FENCE_STALE",
      "The native window no longer matches the latest display topology."
    );
  }
  return display;
}

function eventFor(
  observation: WindowsRuntimeWindowPlacementObservation,
  display: DisplayInfoRecord,
  adapterSequence: number
): WindowsRuntimeWindowPlacementEventRecord {
  return Object.freeze({
    eventId: randomUUID(),
    adapterSequence,
    nativeHostId: observation.nativeHostId,
    nativeGeneration: observation.nativeGeneration,
    windowId: observation.windowId,
    windowGeneration: observation.windowGeneration,
    topologyRevision: observation.topologyRevision,
    targetDisplay: Object.freeze({
      id: display.id,
      fingerprint: Object.freeze({
        label: display.label,
        bounds: Object.freeze({ ...display.bounds }),
        resolution: Object.freeze({ ...display.resolution }),
        scaleFactor: display.scaleFactor,
        isPrimary: display.isPrimary,
        isInternal: display.isInternal
      })
    }),
    placement: Object.freeze({
      normalBounds: Object.freeze({ ...observation.normalBounds }),
      savedWorkArea: Object.freeze({ ...observation.savedWorkArea }),
      presentation: observation.presentation
    })
  });
}

function exactReceipt(
  event: WindowsRuntimeWindowPlacementEventRecord,
  receipt: WindowsRuntimeWindowPlacementReceiptRecord
): boolean {
  const identityMatches = receipt.eventId === event.eventId &&
    receipt.adapterSequence === event.adapterSequence &&
    receipt.nativeHostId === event.nativeHostId &&
    receipt.nativeGeneration === event.nativeGeneration &&
    receipt.windowId === event.windowId &&
    receipt.windowGeneration === event.windowGeneration &&
    receipt.sourceTopologyRevision === event.topologyRevision &&
    Number.isSafeInteger(receipt.topologyRevision) &&
    receipt.topologyRevision >= event.topologyRevision;
  if (!identityMatches) return false;
  if (receipt.status === "applied") {
    return (receipt.persistenceStatus === "applied" ||
      receipt.persistenceStatus === "notRequired") &&
      receipt.coreProjectionApplied &&
      receipt.topologyRevision > event.topologyRevision &&
      receipt.failureCode === undefined;
  }
  if (receipt.status === "superseded") {
    return receipt.persistenceStatus === "superseded";
  }
  return true;
}

function appliedKey(
  observation: WindowsRuntimeWindowPlacementObservation,
  topology: DisplayTopologySnapshotRecord
): string {
  return JSON.stringify({
    nativeHostId: observation.nativeHostId,
    nativeGeneration: observation.nativeGeneration,
    windowId: observation.windowId,
    windowGeneration: observation.windowGeneration,
    displayId: observation.displayId,
    normalBounds: observation.normalBounds,
    savedWorkArea: observation.savedWorkArea,
    presentation: observation.presentation,
    displayTopology: canonicalTopology(topology)
  });
}

/** Serializes native move/resize events into exact Core/durable receipts. */
export class WindowsRuntimeWindowPlacementController {
  readonly #input: WindowsRuntimeWindowPlacementControllerInput;
  readonly #receipts: WindowsRuntimeWindowPlacementInspection[] = [];
  readonly #lastAppliedByWindow = new Map<string, string>();
  #lane: Promise<void> = Promise.resolve();
  #adapterSequence = 0;

  constructor(input: WindowsRuntimeWindowPlacementControllerInput) {
    this.#input = input;
  }

  observe(host: ChromiumRuntimeHostPort): Promise<void> {
    const next = this.#lane.then(() => this.#observeNow(host)).catch((error) => {
      const failure = normalizeRionBridgeError(
        error,
        "ELECTRON_WINDOWS_RUNTIME_PLACEMENT_FAILED"
      );
      this.#push({ status: "failed", verified: false, failureCode: failure.code });
      try {
        this.#input.onError(failure);
      } catch {
        // Error reporting is observational and cannot break the native event lane.
      }
    });
    this.#lane = next;
    return next;
  }

  inspect(windowId?: string): readonly WindowsRuntimeWindowPlacementInspection[] {
    return Object.freeze(this.#receipts
      .filter((entry) => !windowId || entry.event?.windowId === windowId)
      .map((entry) => Object.freeze({ ...entry })));
  }

  drain(): Promise<void> {
    return this.#lane;
  }

  async #observeNow(host: ChromiumRuntimeHostPort): Promise<void> {
    if (!host.readRuntimeWindowPlacement || host.isDestroyed()) {
      throw placementError(
        "ELECTRON_WINDOWS_RUNTIME_PLACEMENT_HOST_STALE",
        "The native placement event lost its current BrowserWindow host."
      );
    }
    const observed = cloneObservation(host.readRuntimeWindowPlacement());
    const observedTopology = this.#input.readDisplayTopology();
    displayFor(observedTopology, observed);
    const before = cloneObservation(host.readRuntimeWindowPlacement());
    const beforeTopology = this.#input.readDisplayTopology();
    if (!sameObservation(observed, before) ||
        canonicalTopology(observedTopology) !== canonicalTopology(beforeTopology)) {
      this.#push({ status: "superseded", verified: false,
        failureCode: "ELECTRON_WINDOWS_RUNTIME_PLACEMENT_PRECONDITION_STALE" });
      return;
    }
    const display = displayFor(beforeTopology, before);
    const key = appliedKey(before, beforeTopology);
    if (this.#lastAppliedByWindow.get(before.windowId) === key) return;
    if (this.#adapterSequence >= Number.MAX_SAFE_INTEGER) {
      throw placementError(
        "ELECTRON_WINDOWS_RUNTIME_PLACEMENT_SEQUENCE_EXHAUSTED",
        "The Windows placement adapter sequence is exhausted."
      );
    }
    this.#adapterSequence += 1;
    const event = eventFor(before, display, this.#adapterSequence);
    let receipt: WindowsRuntimeWindowPlacementReceiptRecord;
    try {
      receipt = await this.#input.core.invoke({
        type: "browserWindowsRuntimeWindowPlacement",
        event
      });
    } catch (error) {
      const failure = normalizeRionBridgeError(
        error,
        "ELECTRON_WINDOWS_RUNTIME_PLACEMENT_CORE_FAILED"
      );
      this.#push({ event, status: "failed", verified: false,
        failureCode: failure.code });
      this.#report(failure);
      return;
    }
    if (!exactReceipt(event, receipt)) {
      const failure = normalizeRionBridgeError(placementError(
        "ELECTRON_WINDOWS_RUNTIME_PLACEMENT_RECEIPT_INVALID",
        "Core returned a mismatched Windows placement receipt."
      ));
      this.#push({ event, receipt, status: "failed", verified: false,
        failureCode: failure.code });
      this.#report(failure);
      return;
    }
    const after = cloneObservation(host.readRuntimeWindowPlacement());
    const afterTopology = this.#input.readDisplayTopology();
    displayFor(afterTopology, after);
    const identityStable = after.nativeHostId === event.nativeHostId &&
      after.nativeGeneration === event.nativeGeneration &&
      after.windowId === event.windowId &&
      after.windowGeneration === event.windowGeneration;
    const appliedVerified = receipt.status === "applied" && identityStable &&
      after.topologyRevision === receipt.topologyRevision &&
      after.displayId === event.targetDisplay.id &&
      after.presentation === event.placement.presentation &&
      sameBounds(after.normalBounds, event.placement.normalBounds) &&
      sameBounds(after.savedWorkArea, event.placement.savedWorkArea) &&
      canonicalTopology(beforeTopology) === canonicalTopology(afterTopology);
    if (receipt.status === "applied" && !appliedVerified) {
      const failure = normalizeRionBridgeError(placementError(
        "ELECTRON_WINDOWS_RUNTIME_PLACEMENT_POSTCONDITION_STALE",
        "The applied Core receipt lost its exact native or display postcondition."
      ));
      this.#push({ event, receipt, status: "indeterminate", verified: false,
        failureCode: failure.code });
      this.#report(failure);
      return;
    }
    if (appliedVerified) {
      try {
        this.#input.onApplied?.(event, receipt);
      } catch (error) {
        const failure = normalizeRionBridgeError(
          error,
          "ELECTRON_WINDOWS_RUNTIME_PLACEMENT_TARGET_FAILED"
        );
        this.#push({ event, receipt, status: "indeterminate", verified: false,
          failureCode: failure.code });
        this.#report(failure);
        return;
      }
    }
    this.#push({
      event,
      receipt,
      status: receipt.status,
      verified: appliedVerified,
      ...(receipt.failureCode ? { failureCode: receipt.failureCode } : {})
    });
    if (appliedVerified) {
      this.#lastAppliedByWindow.set(event.windowId, appliedKey(after, afterTopology));
    } else if (receipt.status !== "superseded") {
      this.#report({
        code: receipt.failureCode ?? "ELECTRON_WINDOWS_RUNTIME_PLACEMENT_NOT_APPLIED",
        message: "Core did not durably apply the native Windows placement."
      });
    }
  }

  #push(entry: WindowsRuntimeWindowPlacementInspection): void {
    this.#receipts.push(Object.freeze({ ...entry }));
    if (this.#receipts.length > MAX_RECEIPTS) this.#receipts.shift();
  }

  #report(error: CoreErrorPayload): void {
    try {
      this.#input.onError(error);
    } catch {
      // Error reporting is observational and cannot break the native event lane.
    }
  }
}
