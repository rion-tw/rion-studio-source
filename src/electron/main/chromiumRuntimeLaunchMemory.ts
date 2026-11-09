import { randomUUID } from "node:crypto";

import type {
  DisplayTopologySnapshotRecord,
  EmbeddedLaunchTargetRecord,
  SourceWindowMemoryRecord,
  WindowMemoryRecord
} from "../../shared/generated";
import type { ElectronCoreCommandPort } from "./coreApiDispatcher";
import { displayById, validBounds } from "./chromiumRuntimeLaunchGeometry";
import { displayFingerprintMatches } from "./chromiumSavedWindowDisplay";

const CASCADE_STEP = 24;

export type LaunchMemoryKey = `role:${string}` | `workspace:${string}` | `window:${string}`;

export function launchMemoryEntry(
  memory: WindowMemoryRecord | undefined,
  key: LaunchMemoryKey
): SourceWindowMemoryRecord | undefined {
  return memory?.sources.find(entry => entry.key === key);
}

/**
 * The remembered placement of a launch source, fitted to the same display's
 * current work area. A display that disappeared or changed identity yields
 * nothing, so the caller keeps its default geometry.
 */
export function rememberedLaunchGeometry(
  entry: SourceWindowMemoryRecord | undefined,
  topology: DisplayTopologySnapshotRecord,
  occupied: readonly EmbeddedLaunchTargetRecord["bounds"][]
): Pick<EmbeddedLaunchTargetRecord, "displayId" | "scaleFactor" | "workArea" | "bounds" | "presentation"> | null {
  const placement = entry?.placement;
  const targetDisplay = entry?.targetDisplay;
  if (!placement || !targetDisplay) return null;
  const display = displayById(topology, targetDisplay.id);
  if (!display || (targetDisplay.fingerprint &&
      !displayFingerprintMatches(targetDisplay.fingerprint, display))) return null;
  const workArea = display.workArea;
  if (!validBounds(placement.normalBounds, 1, 1) || !validBounds(workArea, 640, 480)) return null;
  const width = Math.min(Math.max(placement.normalBounds.width, 640), workArea.width);
  const height = Math.min(Math.max(placement.normalBounds.height, 480), workArea.height);
  const fit = (x: number, y: number) => ({
    x: Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - width),
    y: Math.min(Math.max(y, workArea.y), workArea.y + workArea.height - height),
    width,
    height
  });
  let bounds = fit(placement.normalBounds.x, placement.normalBounds.y);
  // Two windows of one source never stack exactly on top of each other.
  for (let step = 1; step <= 10 && occupied.some(other =>
    other.x === bounds.x && other.y === bounds.y); step += 1) {
    bounds = fit(placement.normalBounds.x + step * CASCADE_STEP, placement.normalBounds.y + step * CASCADE_STEP);
  }
  return {
    displayId: display.id,
    scaleFactor: display.scaleFactor,
    workArea: { ...workArea },
    bounds,
    presentation: placement.presentation === "maximized" || placement.presentation === "fullscreen"
      ? placement.presentation
      : "normal"
  };
}

/**
 * Re-applies a remembered window zoom through Core's ordinary transactional
 * zoom lane once the launch admitted its window. A concurrent topology change
 * supersedes it; the user's own zoom always wins.
 */
export async function restoreRememberedWindowZoom(
  core: ElectronCoreCommandPort,
  windowId: string,
  zoomFactor: number
): Promise<void> {
  if (!Number.isFinite(zoomFactor) || zoomFactor < 0.25 || zoomFactor > 5 || zoomFactor === 1) return;
  const snapshot = await core.invoke({ type: "appSnapshot" });
  const window = snapshot.logicalWindows.find(candidate => candidate.windowId === windowId);
  if (!window || window.windowZoomFactor === zoomFactor) return;
  await core.invoke({
    type: "browserRuntimeWindowZoom",
    operationId: randomUUID(),
    windowId,
    windowGeneration: window.windowGeneration,
    topologyRevision: window.revision,
    action: "restore",
    zoomFactor
  });
}

const MAX_TRACKED_LAUNCHES = 64;

/**
 * Restores a remembered window zoom after the exact launch that opened the
 * window completed natively, so every role surface already exists and joins
 * the transactional zoom fanout. Completion events are the only trigger.
 */
export class RememberedWindowZoomRestorer {
  readonly #core: ElectronCoreCommandPort;
  readonly #pending = new Map<string, Readonly<{ windowId: string; zoomFactor: number }>>();
  /** Completed launch outcomes, including failures that arrive before `schedule`. */
  readonly #completed = new Map<string, boolean>();

  constructor(core: ElectronCoreCommandPort & {
    subscribeCoreEvents: (listener: (event: import("../../shared/generated").CoreEvent) => void) => () => void;
  }) {
    this.#core = core;
    core.subscribeCoreEvents((event) => {
      if (event.type !== "browserLaunchCompleted") return;
      const pending = this.#pending.get(event.operationId);
      if (pending) {
        this.#pending.delete(event.operationId);
        if (event.ok) this.#restore(pending.windowId, pending.zoomFactor);
        return;
      }
      // A failed launch is recorded too: dropping it would park a later
      // `schedule` forever and, after enough of them, block every restore.
      this.#completed.set(event.operationId, event.ok);
      if (this.#completed.size > MAX_TRACKED_LAUNCHES) {
        this.#completed.delete(this.#completed.keys().next().value!);
      }
    });
  }

  schedule(operationId: string, completedAtAdmission: boolean, windowId: string, zoomFactor: number): void {
    if (zoomFactor === 1) return;
    const completed = this.#completed.get(operationId);
    if (completed === false) return;
    if (completedAtAdmission || completed === true) {
      this.#restore(windowId, zoomFactor);
      return;
    }
    if (this.#pending.size >= MAX_TRACKED_LAUNCHES) return;
    this.#pending.set(operationId, Object.freeze({ windowId, zoomFactor }));
  }

  #restore(windowId: string, zoomFactor: number): void {
    void restoreRememberedWindowZoom(this.#core, windowId, zoomFactor).catch(() => undefined);
  }
}
