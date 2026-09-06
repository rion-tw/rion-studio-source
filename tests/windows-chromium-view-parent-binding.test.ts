import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { windowsChromiumViewParentBinding } from "../src/electron/main/windowsChromiumViewParentBinding";
import type { WindowsChromiumInputRuntimeParentBinding } from "../src/electron/main/windowsChromiumInputSurfaceAttachmentCoordinator";
import type { ChromiumRoleWebContentsViewPort } from "../src/electron/main/chromiumRoleSurfacePorts";

describe("Windows public View parent binding", () => {
  function fixture() {
    const events = new EventEmitter();
    const handle = Buffer.from([1]);
    const children: unknown[] = [];
    const window = { contentView: { children }, getNativeWindowHandle: () => handle,
      isFocused: vi.fn(() => true), isVisible: vi.fn(() => true),
      on: events.on.bind(events), removeListener: events.removeListener.bind(events) };
    const native = { parentIdentity: "a".repeat(64), focusIdentity: "b".repeat(64),
      parentWasForeground: true, parentVisible: true, parentMinimized: false };
    const readWindowsRuntimeForeground = vi.fn(() => native);
    const binding = windowsChromiumViewParentBinding({ window,
      identity: { nativeGeneration: 2, ownerRevision: "3" } } as unknown as WindowsChromiumInputRuntimeParentBinding,
    { readWindowsRuntimeForeground }, () => 12);
    return { events, handle, children, window, native, readWindowsRuntimeForeground, binding };
  }
  it("requires both native foreground proof and Electron parent state", () => {
    const f = fixture();
    expect(f.binding.read()).toMatchObject({ parentForeground: true, focusedWebContentsId: 12 });
    expect(f.readWindowsRuntimeForeground).toHaveBeenCalledWith(f.handle);
    f.window.isFocused.mockReturnValue(false);
    expect(f.binding.read().parentForeground).toBe(false);
    f.window.isFocused.mockReturnValue(true);
    f.native.parentWasForeground = false;
    expect(f.binding.read().parentForeground).toBe(false);
    f.window.isVisible.mockReturnValue(false);
    expect(f.binding.read().parentVisible).toBe(false);
    expect(f.binding.parent).toBe(f.window);
    expect(f.binding.children()).toBe(f.children);
  });
  it("reads exact WebContents focus without fabricating readiness for absent APIs", () => {
    const f = fixture();
    expect(f.binding.contentsFocused({ webContents: {} } as ChromiumRoleWebContentsViewPort)).toBe(false);
    expect(f.binding.contentsFocused({ webContents: { isFocused: () => true } } as ChromiumRoleWebContentsViewPort)).toBe(true);
  });
  it("observes native parent events and detaches every listener", () => {
    const f = fixture();
    const listener = vi.fn();
    const unsubscribe = f.binding.subscribe(listener);
    f.events.emit("focus");
    f.events.emit("closed");
    expect(listener.mock.calls).toEqual([["changed"], ["closed"]]);
    unsubscribe();
    expect(f.events.eventNames()).toEqual([]);
  });
  it("removes prior listeners when parent subscription fails", () => {
    const f = fixture();
    f.window.on = ((event: string, listener: () => void) => {
      if (event === "show") throw new Error("native stream failed");
      return f.events.on(event, listener);
    }) as typeof f.window.on;
    expect(() => f.binding.subscribe(vi.fn())).toThrow("native stream failed");
    expect(f.events.eventNames()).toEqual([]);
  });
});
