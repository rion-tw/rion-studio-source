import type { DisplayTopologySnapshotRecord } from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";
import {
  projectElectronDisplayTopology,
  type ElectronDisplayDescriptor
} from "./appSnapshotProjection";

export interface ElectronDisplayInventorySnapshot {
  readonly displays: readonly ElectronDisplayDescriptor[];
  readonly primaryDisplayId: number;
}

export interface ElectronDisplayTopologyControllerInput {
  readonly capture: () => ElectronDisplayInventorySnapshot;
  readonly now?: () => string;
  readonly onListenerError?: (error: unknown) => void;
}

export type ElectronDisplayTopologyListener = (
  snapshot: DisplayTopologySnapshotRecord
) => void;

interface CachedDisplayTopology {
  readonly fingerprint: string;
  readonly snapshot: DisplayTopologySnapshotRecord;
}

const MAX_DISPLAYS = 64;
const MAX_LISTENERS = 64;

function topologyError(message: string): RionBridgeError {
  return new RionBridgeError({
    code: "ELECTRON_DISPLAY_TOPOLOGY_REVISION_INVALID",
    message
  });
}

function cloneDisplayInventory(
  inventory: ElectronDisplayInventorySnapshot
): ElectronDisplayInventorySnapshot {
  if (
    !Array.isArray(inventory.displays) ||
    inventory.displays.length === 0 ||
    inventory.displays.length > MAX_DISPLAYS
  ) {
    throw topologyError("The Electron display inventory is unbounded or empty.");
  }
  const displays = inventory.displays.map((display) => Object.freeze({
    id: display.id,
    label: display.label,
    bounds: Object.freeze({ ...display.bounds }),
    workArea: Object.freeze({ ...display.workArea }),
    size: Object.freeze({ ...display.size }),
    scaleFactor: display.scaleFactor,
    internal: display.internal
  }));
  return Object.freeze({
    primaryDisplayId: inventory.primaryDisplayId,
    displays: Object.freeze(displays)
  });
}

function canonicalProjectedTopology(
  topology: DisplayTopologySnapshotRecord
): string {
  return JSON.stringify({
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

function freezeTopology(
  topology: DisplayTopologySnapshotRecord
): DisplayTopologySnapshotRecord {
  for (const display of topology.displays) {
    Object.freeze(display.bounds);
    Object.freeze(display.workArea);
    Object.freeze(display.resolution);
    Object.freeze(display);
  }
  Object.freeze(topology.displays);
  return Object.freeze(topology);
}

/**
 * Owns the semantic Electron screen-topology revision.
 *
 * Getters replay the same immutable projection. Screen events call `refresh`,
 * but a revision advances only when the canonical native inventory changes.
 */
export class ElectronDisplayTopologyController {
  readonly #input: ElectronDisplayTopologyControllerInput;
  readonly #listeners = new Set<ElectronDisplayTopologyListener>();
  #cache: CachedDisplayTopology | null = null;
  #revision = 0;
  #disposed = false;

  constructor(input: ElectronDisplayTopologyControllerInput) {
    this.#input = input;
  }

  snapshot(): DisplayTopologySnapshotRecord {
    this.#requireActive();
    return this.#cache?.snapshot ?? this.refresh("electron-initial");
  }

  onChanged(listener: ElectronDisplayTopologyListener): () => void {
    this.#requireActive();
    if (this.#listeners.size >= MAX_LISTENERS) {
      throw topologyError("The Electron display-topology listener capacity is full.");
    }
    this.#listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.#listeners.delete(listener);
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#listeners.clear();
  }

  refresh(cause: string): DisplayTopologySnapshotRecord {
    this.#requireActive();
    if (
      cause.length === 0 ||
      cause !== cause.trim() ||
      cause.length > 64 ||
      [...cause].some((character) => character.codePointAt(0)! <= 0x1f)
    ) {
      throw topologyError("The Electron display-topology cause is invalid.");
    }
    const inventory = cloneDisplayInventory(this.#input.capture());
    if (!Number.isSafeInteger(this.#revision + 1)) {
      throw topologyError("The Electron display-topology revision is exhausted.");
    }
    const candidate = projectElectronDisplayTopology({
      displays: inventory.displays,
      primaryDisplayId: inventory.primaryDisplayId,
      revision: this.#revision + 1,
      capturedAt: (this.#input.now ?? (() => new Date().toISOString()))(),
      cause
    });
    const fingerprint = canonicalProjectedTopology(candidate);
    if (this.#cache?.fingerprint === fingerprint) return this.#cache.snapshot;
    const snapshot = freezeTopology(candidate);
    this.#revision = snapshot.revision;
    this.#cache = { fingerprint, snapshot };
    for (const listener of [...this.#listeners]) {
      try {
        listener(snapshot);
      } catch (error) {
        try {
          this.#input.onListenerError?.(error);
        } catch {
          // Listener error reporting is observational and cannot abort publication.
        }
      }
    }
    return snapshot;
  }

  #requireActive(): void {
    if (this.#disposed) {
      throw topologyError("The Electron display-topology controller was disposed.");
    }
  }
}
