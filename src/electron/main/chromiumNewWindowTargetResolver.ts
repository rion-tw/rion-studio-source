import type {
  DisplayInfoRecord,
  DisplayTopologySnapshotRecord,
  RuntimeWindowProvisionTargetRecord
} from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";
import type { ChromiumNewWindowTargetResolverPort } from
  "./chromiumNewWindowMoveController";

const MINIMUM_WINDOW_WIDTH = 640;
const MINIMUM_WINDOW_HEIGHT = 480;
const DETACHED_WINDOW_OFFSET = 32;

export interface ChromiumNewWindowTargetResolverInput {
  readonly readDisplayTopology: () => DisplayTopologySnapshotRecord;
}

function targetError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function exactDisplay(
  topology: DisplayTopologySnapshotRecord,
  sourceDisplayId: number
): DisplayInfoRecord {
  const display = topology.displays.find(
    (candidate) => candidate.id === sourceDisplayId
  ) ?? topology.displays.find((candidate) => candidate.isPrimary);
  if (
    !display ||
    !Number.isSafeInteger(display.id) ||
    !Number.isFinite(display.scaleFactor) ||
    display.scaleFactor <= 0 ||
    ![display.workArea.x, display.workArea.y, display.workArea.width,
      display.workArea.height].every(Number.isSafeInteger)
  ) {
    throw targetError(
      "ELECTRON_CHROMIUM_NEW_WINDOW_DISPLAY_STALE",
      "The detached Game Window has no exact live display projection."
    );
  }
  if (
    display.workArea.width < MINIMUM_WINDOW_WIDTH ||
    display.workArea.height < MINIMUM_WINDOW_HEIGHT
  ) {
    throw targetError(
      "ELECTRON_CHROMIUM_NEW_WINDOW_WORK_AREA_TOO_SMALL",
      "The target display cannot contain the minimum Game Window bounds."
    );
  }
  return display;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

/**
 * Resolves only display placement. Core allocates the logical window identity
 * and all ownership fences in the subsequent provision transaction.
 */
export class ChromiumNewWindowTargetResolver
implements ChromiumNewWindowTargetResolverPort {
  readonly #input: ChromiumNewWindowTargetResolverInput;

  constructor(input: ChromiumNewWindowTargetResolverInput) {
    this.#input = input;
  }

  async resolve(
    input: Parameters<ChromiumNewWindowTargetResolverPort["resolve"]>[0]
  ): Promise<RuntimeWindowProvisionTargetRecord> {
    const topology = this.#input.readDisplayTopology();
    const display = exactDisplay(topology, input.sourceNative.displayId);
    const width = Math.min(
      Math.max(input.sourceNative.bounds.width, MINIMUM_WINDOW_WIDTH),
      display.workArea.width
    );
    const height = Math.min(
      Math.max(input.sourceNative.bounds.height, MINIMUM_WINDOW_HEIGHT),
      display.workArea.height
    );
    const maximumX = display.workArea.x + display.workArea.width - width;
    const maximumY = display.workArea.y + display.workArea.height - height;
    const x = clamp(
      input.sourceNative.bounds.x + DETACHED_WINDOW_OFFSET,
      display.workArea.x,
      maximumX
    );
    const y = clamp(
      input.sourceNative.bounds.y + DETACHED_WINDOW_OFFSET,
      display.workArea.y,
      maximumY
    );
    return Object.freeze({
      displayId: display.id,
      scaleFactor: display.scaleFactor,
      workArea: Object.freeze({ ...display.workArea }),
      bounds: Object.freeze({ x, y, width, height }),
      presentation: "normal"
    });
  }
}
