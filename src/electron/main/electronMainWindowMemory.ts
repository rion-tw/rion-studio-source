import type { MainWindowMemoryRecord } from "../../shared/generated";
import type { ElectronCoreCommandPort } from "./coreApiDispatcher";

interface Rectangle { x: number; y: number; width: number; height: number }

export interface ElectronMainWindowMemoryWindowPort {
  getNormalBounds: () => Rectangle;
  isDestroyed: () => boolean;
  isFullScreen: () => boolean;
  isMaximized: () => boolean;
  isMinimized: () => boolean;
  maximize: () => void;
  on: (event: "moved", listener: () => void) => unknown;
  once: (event: "show", listener: () => void) => unknown;
}

const MINIMUM_VISIBLE = 120;

/** Remembered bounds that are still reachable on a current display, else null. */
export function fitMainWindowMemory(
  memory: MainWindowMemoryRecord | undefined,
  workAreas: readonly Rectangle[],
  minimum: Readonly<{ width: number; height: number }>
): Rectangle | null {
  if (!memory) return null;
  const { bounds } = memory;
  const area = workAreas.find(candidate =>
    Math.min(bounds.x + bounds.width, candidate.x + candidate.width) - Math.max(bounds.x, candidate.x) >= MINIMUM_VISIBLE &&
    Math.min(bounds.y + bounds.height, candidate.y + candidate.height) - Math.max(bounds.y, candidate.y) >= MINIMUM_VISIBLE);
  if (!area) return null;
  const width = Math.min(Math.max(bounds.width, minimum.width), area.width);
  const height = Math.min(Math.max(bounds.height, minimum.height), area.height);
  return {
    x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - height),
    width,
    height
  };
}

export async function readMainWindowMemory(
  core: ElectronCoreCommandPort
): Promise<MainWindowMemoryRecord | undefined> {
  try {
    return (await core.invoke({ type: "windowMemoryGet" })).mainWindow;
  } catch {
    return undefined;
  }
}

/**
 * Native move/resize/maximize completion events are the only writers. Full
 * screen and minimized states keep the last normal frame.
 */
export function trackMainWindowMemory(
  window: ElectronMainWindowMemoryWindowPort,
  core: ElectronCoreCommandPort,
  remembered: MainWindowMemoryRecord | undefined
): void {
  if (remembered?.maximized) window.once("show", () => { if (!window.isDestroyed()) window.maximize(); });
  let last = remembered ? JSON.stringify(remembered) : "";
  const record = () => {
    if (window.isDestroyed() || window.isFullScreen() || window.isMinimized()) return;
    const bounds = window.getNormalBounds();
    const next: MainWindowMemoryRecord = {
      bounds: {
        x: Math.round(bounds.x), y: Math.round(bounds.y),
        width: Math.round(bounds.width), height: Math.round(bounds.height)
      },
      maximized: window.isMaximized()
    };
    const serialized = JSON.stringify(next);
    if (serialized === last) return;
    last = serialized;
    void core.invoke({ type: "mainWindowMemoryReplace", record: next }).catch(() => undefined);
  };
  for (const event of ["moved", "resized", "maximize", "unmaximize"] as const) {
    // Each is a native completion event with the same no-argument shape.
    window.on(event as "moved", record);
  }
}
