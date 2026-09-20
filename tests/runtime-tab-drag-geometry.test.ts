import { describe, expect, it, vi } from "vitest";
import { WindowsRuntimeTabDragGeometry } from "../src/electron/main/windowsRuntimeTabDragGeometry";
import { createRuntimeTabDragHost } from "../src/electron/main/runtimeTabDragHost";
import type { RuntimeTabDragGeometry } from "../src/shared/runtimeTabDrag";

const geometry: RuntimeTabDragGeometry = { type: "tabDragGeometry", windowId: "window", projectionRevision: 2,
  row: { x: 0, y: 0, width: 400, height: 40 },
  tabs: [{ tabId: "tab", bounds: { x: 100, y: 5, width: 120, height: 30 } }] };
describe("native drag geometry and interaction leases", () => {
  it("invalidates old paint, resolves only a matching tab, and cancels without waiting for another paint", async () => {
    const g = new WindowsRuntimeTabDragGeometry(() => ({ x: -500, y: 100, width: 800, height: 600 }));
    g.apply(geometry);
    expect(g.contains({ x: -350, y: 120 })).toBe(true);
    expect(g.anchor("tab", { x: 0.5, y: 0.5 })).toEqual({ x: 160, y: 20 });
    g.invalidate();
    expect(g.contains({ x: -350, y: 120 })).toBe(false);
    const abort = new AbortController();
    const done = vi.fn();
    const waiting = g.ready("new", abort.signal).then(done);
    g.apply(geometry); await Promise.resolve(); expect(done).not.toHaveBeenCalled();
    abort.abort(); await waiting; expect(done).toHaveBeenCalledOnce();
    const removed = g.ready("missing", new AbortController().signal);
    g.dispose(); await expect(removed).rejects.toThrow("stream closed");
  });
  it("releases only the matching session and restores interaction after a failed native placement", () => {
    const native = { getNormalBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
      isDestroyed: () => false, showInactive: vi.fn(), setIgnoreMouseEvents: vi.fn(),
      setBounds: vi.fn(() => { throw new Error("native placement failed"); }) };
    const host = createRuntimeTabDragHost({ native, contains: () => false, anchor: () => ({ x: 100, y: 20 }) });
    expect(() => host.position("current", native.getNormalBounds(), true)).toThrow("placement failed");
    host.release("old"); expect(native.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true);
    host.release("current"); expect(native.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
  });
});
