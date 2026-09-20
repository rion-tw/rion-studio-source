import type { RuntimeTabDragGeometry } from "../../shared/runtimeTabDrag";
import type { DragPoint, RuntimeTabDragHostPort } from "./runtimeTabDragHost";
import type { LayoutBounds } from "../../shared/generated";

/** Geometry is supplied only by the authenticated bundled host document. */
export class WindowsRuntimeTabDragGeometry {
  readonly #waiters = new Map<string, Array<{ resolve: () => void; reject: (error: Error) => void }>>();
  #geometry: RuntimeTabDragGeometry | null = null;
  readonly #contentBounds: () => LayoutBounds;
  constructor(contentBounds: () => LayoutBounds) { this.#contentBounds = contentBounds; }
  apply(value: RuntimeTabDragGeometry): void {
    this.#geometry = value;
    for (const tab of value.tabs) {
      for (const waiter of this.#waiters.get(tab.tabId) ?? []) waiter.resolve();
      this.#waiters.delete(tab.tabId);
    }
  }
  ready = (tabId: string, signal: AbortSignal): Promise<void> => {
    if (signal.aborted || this.#geometry?.tabs.some(t => t.tabId === tabId)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiters = this.#waiters.get(tabId) ?? [];
      const remove = () => {
        signal.removeEventListener("abort", abort);
        const current = this.#waiters.get(tabId)?.filter(value => value !== waiter) ?? [];
        if (current.length) this.#waiters.set(tabId, current); else this.#waiters.delete(tabId);
      };
      const waiter = { resolve: () => { remove(); resolve(); }, reject: (error: Error) => { remove(); reject(error); } };
      const abort = () => waiter.resolve();
      signal.addEventListener("abort", abort, { once: true });
      waiters.push(waiter); this.#waiters.set(tabId, waiters);
    });
  };
  dispose(): void {
    this.#geometry = null;
    for (const waiters of this.#waiters.values()) for (const waiter of waiters) waiter.reject(new Error("The drag geometry stream closed."));
    this.#waiters.clear();
  }
  invalidate(): void { this.#geometry = null; }
  contains = (point: DragPoint): boolean => {
    const geometry = this.#geometry;
    if (!geometry) return false;
    const origin = this.#contentBounds();
    const { row } = geometry;
    return point.x >= origin.x + row.x && point.x < origin.x + row.x + row.width &&
      point.y >= origin.y + row.y && point.y < origin.y + row.y + row.height;
  };
  anchor = (tabId: string, ratio: DragPoint): DragPoint => {
    const tab = this.#geometry?.tabs.find(t => t.tabId === tabId);
    if (!tab) throw new Error("The drag tab has no current native-host geometry.");
    return { x: tab.bounds.x + tab.bounds.width * ratio.x, y: tab.bounds.y + tab.bounds.height * ratio.y };
  };
  before: RuntimeTabDragHostPort["before"] = (point, tabId) => {
    const origin = this.#contentBounds();
    return this.#geometry?.tabs.filter(t => t.tabId !== tabId)
      .find(t => point.x < origin.x + t.bounds.x + t.bounds.width / 2)?.tabId;
  };
}
