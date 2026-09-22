import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { navigateStoreHistory, type StoreHistoryAction } from "../src/electron/main/extensionStoreHistoryNavigation";

function fixture(action: StoreHistoryAction = "back") {
  const contents = new EventEmitter();
  const entries = ["https://store.test/search?q=fixture", "https://store.test/detail?id=fixture"];
  let index = action === "forward" ? 0 : 1;
  let current = true;
  const controller = new AbortController();
  const native = Object.assign(contents, {
    isDestroyed: () => false, getURL: () => entries[index], reload: vi.fn(),
    navigationHistory: {
      canGoBack: () => index > 0, canGoForward: () => index < entries.length - 1,
      getActiveIndex: () => index,
      getEntryAtIndex: (at: number) => entries[at] ? { url: entries[at] } : null,
      goBack: vi.fn(), goForward: vi.fn()
    }
  });
  const target = action === "back" ? 0 : 1;
  const url = entries[target];
  const start = (same = false, next = url, main = true) =>
    contents.emit("did-start-navigation", { isMainFrame: main, isSameDocument: same, url: next }, next, same, main);
  const inPage = () => { index = target; start(true); contents.emit("did-navigate-in-page", {}, url, true); };
  const complete = () => {
    index = target;
    start();
    contents.emit("did-navigate", {}, url);
    contents.emit("did-finish-load");
  };
  const run = () => navigateStoreHistory(native as unknown as WebContents, action, controller.signal, () => current);
  return { native, entries, controller, start, inPage, complete, run, url,
    retire: () => { current = false; }, move: (at: number) => { index = at; } };
}
const unwind = () => new Promise<void>(resolve => setImmediate(resolve));

describe("store history document restoration", () => {
  it("does not dispatch unavailable or already cancelled history work", async () => {
    const f = fixture();
    f.move(0);
    expect(await f.run()).toMatchObject({ phase: "cancelled", code: "HISTORY_UNAVAILABLE" });
    f.move(1);
    f.controller.abort();
    expect(await f.run()).toMatchObject({ phase: "cancelled", code: "HISTORY_RETIRED" });
    expect(f.native.navigationHistory.goBack).not.toHaveBeenCalled();
    expect(f.native.eventNames()).toEqual([]);
  });

  it.each(["back", "forward"] as const)("reloads a same-document %s exactly once without changing history", async action => {
    const f = fixture(action);
    const original = [...f.entries];
    const done = vi.fn();
    const result = f.run().then(done);
    f.inPage();
    f.inPage();
    expect(f.native.reload).not.toHaveBeenCalled();
    f.native.emit("did-finish-load"); // An old document's completion is not the target load.
    await unwind();
    expect(done).not.toHaveBeenCalled();
    expect(f.native.reload).toHaveBeenCalledOnce();
    f.complete();
    await result;
    expect(done).toHaveBeenCalledWith({ phase: "completed", code: "HISTORY_DOCUMENT_COMPLETED" });
    expect(f.entries).toEqual(original);
    expect(f.native.eventNames()).toEqual([]);
  });

  it.each(["back", "forward"] as const)("does not reload a full-document %s", async action => {
    const f = fixture(action);
    const result = f.run();
    f.complete();
    expect(await result).toMatchObject({ phase: "completed" });
    await unwind();
    expect(f.native.reload).not.toHaveBeenCalled();
  });

  it("waits for a committed main document on explicit Reload", async () => {
    const f = fixture("reload");
    const done = vi.fn();
    const result = f.run().then(done);
    expect(f.native.reload).toHaveBeenCalledOnce();
    f.native.emit("did-finish-load");
    f.start(false, "https://frame.test", false);
    await unwind();
    expect(done).not.toHaveBeenCalled();
    f.complete();
    await result;
    expect(done).toHaveBeenCalledOnce();
  });

  it.each(["abort", "retire", "move", "navigate", "destroy"])("cancels a deferred reload after %s", async reason => {
    const f = fixture();
    const result = f.run();
    f.inPage();
    if (reason === "abort") f.controller.abort();
    if (reason === "retire") f.retire();
    if (reason === "move") f.move(1);
    if (reason === "navigate") f.start(false, "https://store.test/new");
    if (reason === "destroy") f.native.emit("destroyed");
    await unwind();
    expect(await result).toMatchObject({ phase: "cancelled" });
    expect(f.native.reload).not.toHaveBeenCalled();
    expect(f.native.eventNames()).toEqual([]);
  });

  it.each(["load", "renderer", "throw", "aborted-load"])("terminalizes %s failure and removes all listeners", async reason => {
    const f = fixture("reload");
    if (reason === "throw") f.native.reload.mockImplementation(() => { throw new Error("gone"); });
    const result = f.run();
    if (reason === "load" || reason === "aborted-load") {
      f.native.emit("did-fail-load", {}, reason === "load" ? -2 : -3, "failed", f.url, true);
    }
    if (reason === "renderer") f.native.emit("render-process-gone");
    expect(await result).toMatchObject({ phase: reason === "aborted-load" ? "cancelled" : "failed" });
    expect(f.native.eventNames()).toEqual([]);
    f.native.reload.mockReset();
    const next = f.run();
    f.complete();
    expect(await next).toMatchObject({ phase: "completed" });
  });

  it("ignores failures from a different document or subframe", async () => {
    const f = fixture("reload");
    const result = f.run();
    f.native.emit("did-fail-load", {}, -2, "frame", f.url, false);
    f.native.emit("did-fail-load", {}, -3, "previous", "https://store.test/previous", true);
    f.complete();
    expect(await result).toMatchObject({ phase: "completed" });
  });
});
