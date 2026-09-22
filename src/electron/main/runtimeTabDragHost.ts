import type { LayoutBounds } from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";

export type DragPoint = Readonly<{ x: number; y: number }>;
export interface RuntimeTabDragHostPort {
  park?: () => void;
  withoutOcclusion?: <T>(query: () => T) => T;
  frameBounds?: () => LayoutBounds;
  ready?: (tabId: string, signal: AbortSignal) => Promise<void>;
  contains: (point: DragPoint) => boolean;
  anchor: (tabId: string, ratio: DragPoint) => DragPoint;
  before: (point: DragPoint, tabId: string, tabIds: readonly string[]) => string | undefined;
  position: (sessionId: string, bounds: LayoutBounds, held: boolean) => void | Promise<void>;
  release: (sessionId: string) => void;
}

export function createRuntimeTabDragHost(input: Readonly<{
  native: {
    getNormalBounds: () => LayoutBounds;
    setBounds?: (bounds: LayoutBounds) => void;
    setIgnoreMouseEvents?: (ignore: boolean) => void;
    showInactive: () => void;
    hide?: () => void;
    isDestroyed: () => boolean;
  };
  contains: RuntimeTabDragHostPort["contains"];
  anchor: RuntimeTabDragHostPort["anchor"];
  before?: RuntimeTabDragHostPort["before"];
  ready?: RuntimeTabDragHostPort["ready"];
  onPositioned?: () => Promise<void>;
}>): RuntimeTabDragHostPort {
  let lease: string | null = null;
  return {
    park: () => { if (!input.native.isDestroyed()) input.native.hide?.(); },
    withoutOcclusion: query => {
      if (!input.native.setIgnoreMouseEvents || input.native.isDestroyed()) return query();
      input.native.setIgnoreMouseEvents(true);
      try { return query(); }
      finally { if (!input.native.isDestroyed()) input.native.setIgnoreMouseEvents(lease !== null); }
    },
    frameBounds: () => input.native.getNormalBounds(),
    ready: input.ready,
    contains: input.contains,
    anchor: input.anchor,
    before: input.before ?? ((point, tabId, ids) => {
      const bounds = input.native.getNormalBounds();
      return ids.filter(id => id !== tabId).find(id =>
        point.x < bounds.x + input.anchor(id, { x: 0.5, y: 0.5 }).x);
    }),
    position: (sessionId, bounds, held) => {
      if (!input.native.setBounds || !input.native.setIgnoreMouseEvents || input.native.isDestroyed()) {
        throw new RionBridgeError({ code: "RUNTIME_TAB_DRAG_HOST_UNAVAILABLE",
          message: "The exact native drag host is unavailable." });
      }
      lease = held ? sessionId : null;
      input.native.setIgnoreMouseEvents(held);
      input.native.setBounds(bounds);
      input.native.showInactive();
      return input.onPositioned?.();
    },
    release: sessionId => {
      if (lease !== sessionId) return;
      lease = null;
      if (!input.native.isDestroyed()) input.native.setIgnoreMouseEvents?.(false);
    }
  };
}
