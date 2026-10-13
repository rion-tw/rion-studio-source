import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ BrowserWindow: { fromWebContents: () => null }, webContents: {} }));
import { ExtensionStore } from "../third_party/electron-chrome-extensions/src/browser/store";
import { TabsAPI } from "../third_party/electron-chrome-extensions/src/browser/api/tabs";

describe.each(["darwin", "win32"])("extension tab parent continuity (%s)", () => {
  function fixture() {
    const store = new ExtensionStore({});
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const broadcastEvent = vi.fn();
    new TabsAPI({ store, router: { broadcastEvent,
      apiHandler: () => (name: string, callback: (...args: unknown[]) => unknown) => handlers.set(name, callback)
    } } as never);
    const tab = Object.assign(new EventEmitter(), {
      id: 11, isDestroyed: () => false, isCurrentlyAudible: () => false,
      getTitle: () => "Game", getURL: () => "https://game.test", getType: () => "window",
      isLoading: () => false, audioMuted: false
    });
    const previous = { id: 21, isDestroyed: () => false, getSize: () => [640, 480] };
    const next = { id: 22, isDestroyed: () => false, getSize: () => [800, 600] };
    store.addTab(tab as never, previous as never);
    broadcastEvent.mockClear();
    return { store, tab, previous, next, handlers, broadcastEvent };
  }

  it("moves cached tab queries and active ownership without recreating listeners or the tab", () => {
    const f = fixture();
    const listenerCount = f.tab.listenerCount("did-start-loading");
    f.store.moveTab(f.tab as never, f.previous as never, f.next as never);
    expect(f.handlers.get("tabs.get")!({}, 11)).toMatchObject({ id: 11, windowId: 22, active: true, width: 800 });
    expect(f.handlers.get("tabs.getAllInWindow")!({}, 21)).toEqual([]);
    expect(f.handlers.get("tabs.getAllInWindow")!({}, 22)).toHaveLength(1);
    expect(f.store.getActiveTabFromWindow(f.previous as never)).toBeUndefined();
    expect(f.store.getActiveTabFromWindow(f.next as never)).toBe(f.tab);
    expect(f.tab.listenerCount("did-start-loading")).toBe(listenerCount);
    expect(f.broadcastEvent.mock.calls).toEqual([
      ["tabs.onDetached", 11, { oldWindowId: 21, oldPosition: -1 }],
      ["tabs.onAttached", 11, { newWindowId: 22, newPosition: -1 }]
    ]);
    f.store.moveTab(f.tab as never, f.next as never, f.previous as never);
    expect(f.handlers.get("tabs.get")!({}, 11)).toMatchObject({ windowId: 21, width: 640 });
    expect([...f.store.windows]).toEqual([f.previous]);
    expect(f.store.lastFocusedWindowId).toBe(21);
  });

  it("fences the previous parent, preserves another source tab and rejects destroyed destinations", () => {
    const f = fixture();
    const other = Object.assign(new EventEmitter(), {
      id: 12, isDestroyed: () => false, isCurrentlyAudible: () => false,
      getTitle: () => "Other", getURL: () => "https://game.test/other", getType: () => "window",
      isLoading: () => false, audioMuted: false
    });
    f.store.addTab(other as never, f.previous as never);
    expect(() => f.store.moveTab(f.tab as never, {} as never, f.next as never)).toThrow("PARENT_MISMATCH");
    expect(() => f.store.moveTab(f.tab as never, f.previous as never,
      { ...f.next, isDestroyed: () => true } as never)).toThrow("PARENT_MISMATCH");
    expect(f.handlers.get("tabs.get")!({}, 11)).toMatchObject({ windowId: 21 });
    f.store.moveTab(f.tab as never, f.previous as never, f.next as never);
    expect(f.store.getWindowById(21)).toBe(f.previous);
    expect(f.handlers.get("tabs.getAllInWindow")!({}, 21)).toEqual([expect.objectContaining({ id: 12 })]);
  });

  it("releases the closed parent before the same Session registers a reopened Role", () => {
    const f = fixture();
    f.store.moveTab(f.tab as never, f.previous as never, f.next as never);
    f.store.removeTab(f.tab as never);
    expect(f.store.getActiveTabFromWindow(f.next as never)).toBeUndefined();
    expect(f.store.getCurrentWindow()).toBeNull();
    const reopened = Object.assign(new EventEmitter(), {
      id: 15, isDestroyed: () => false, isCurrentlyAudible: () => false,
      getTitle: () => "Reopened", getURL: () => "https://game.test", getType: () => "window",
      isLoading: () => false, audioMuted: false
    });
    f.store.addTab(reopened as never, f.previous as never);
    expect(f.store.getCurrentWindow()).toBe(f.previous);
    expect(f.handlers.get("tabs.getAllInWindow")!({})).toEqual([expect.objectContaining({ id: 15, windowId: 21 })]);
  });
});
