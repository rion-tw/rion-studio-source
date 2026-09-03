import { randomUUID } from "node:crypto";

import type {
  DisplayTopologySnapshotRecord,
  EmbeddedLaunchTargetRecord,
  StateGameWindowRecord,
  StatePixelBoundsRecord
} from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";

interface NativeDisplayFence {
  readonly id: number;
  readonly scaleFactor: number;
  readonly workArea: StatePixelBoundsRecord;
}

export interface ElectronNewGameWindowTargetInput {
  readonly createWindowId?: () => string;
  readonly gameWindows: readonly StateGameWindowRecord[];
  readonly nativeDisplay: NativeDisplayFence;
  readonly topology: DisplayTopologySnapshotRecord;
}

function targetError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function sameBounds(
  left: StatePixelBoundsRecord,
  right: StatePixelBoundsRecord
): boolean {
  return left.x === right.x && left.y === right.y &&
    left.width === right.width && left.height === right.height;
}

function windowExtent(
  available: number,
  hardMinimum: number
): number {
  // Keep the retained 80-percent placement margin even on compact displays.
  // AppKit and Win32 add native frame chrome outside the requested content
  // size; consuming nearly the entire work area lets the OS constrain the
  // authoritative bounds immediately after the window becomes visible.
  return Math.min(
    available,
    Math.max(hardMinimum, Math.round(available * 0.8))
  );
}

/** Mirrors the retained v22 New Game Window placement using a fenced display. */
export function resolveElectronNewGameWindowTarget(
  input: ElectronNewGameWindowTargetInput
): EmbeddedLaunchTargetRecord {
  const displays = input.topology.displays.filter(
    (display) => display.id === input.nativeDisplay.id
  );
  const display = displays[0];
  if (
    displays.length !== 1 || !display ||
    display.scaleFactor !== input.nativeDisplay.scaleFactor ||
    !sameBounds(display.workArea, input.nativeDisplay.workArea) ||
    display.workArea.width < 1 || display.workArea.height < 1
  ) {
    throw targetError(
      "ELECTRON_APPLICATION_SHORTCUT_DISPLAY_STALE",
      "The New Game Window shortcut lost its exact display topology fence."
    );
  }
  const windowId = (input.createWindowId ?? randomUUID)();
  if (
    windowId.length === 0 || windowId !== windowId.trim() ||
    [...windowId].some((character) => character.codePointAt(0)! <= 0x1f)
  ) {
    throw targetError(
      "ELECTRON_APPLICATION_SHORTCUT_WINDOW_ID_INVALID",
      "The New Game Window shortcut produced an invalid logical identity."
    );
  }
  const existingOnDisplay = input.gameWindows.filter(
    (window) => window.targetDisplay.id === display.id
  ).length;
  const width = windowExtent(display.workArea.width, 640);
  const height = windowExtent(display.workArea.height, 480);
  const cascade = Math.min(existingOnDisplay * 24, 240);
  const maximumX = display.workArea.x + Math.max(display.workArea.width - width, 0);
  const maximumY = display.workArea.y + Math.max(display.workArea.height - height, 0);
  const x = Math.min(
    display.workArea.x + Math.trunc((display.workArea.width - width) / 2) + cascade,
    maximumX
  );
  const y = Math.min(
    display.workArea.y + Math.trunc((display.workArea.height - height) / 2) + cascade,
    maximumY
  );
  return {
    windowId,
    displayId: display.id,
    scaleFactor: display.scaleFactor,
    workArea: { ...display.workArea },
    bounds: { x, y, width, height },
    presentation: "normal"
  };
}
