import { EventEmitter } from "node:events";
import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import { createWindowsWorkspaceResizeIndicators } from "../src/electron/main/windowsWorkspaceResizeIndicators";

function harness() {
  const parent = Object.assign(new EventEmitter(), {
    isDestroyed: () => false, isVisible: () => true, isMinimized: () => false,
    getContentBounds: () => ({ x: 20, y: 40, width: 960, height: 640 })
  });
  const writes: { resolve: () => void; reject: (error: unknown) => void }[] = [];
  const webContents = Object.assign(new EventEmitter(), {
    setWindowOpenHandler: vi.fn(),
    executeJavaScript: vi.fn(() => new Promise<void>((resolve, reject) => writes.push({resolve,reject})))
  });
  const overlay = Object.assign(new EventEmitter(), {
    webContents, isDestroyed: () => false, setBounds: vi.fn(), hide: vi.fn(),
    showInactive: vi.fn(), destroy: vi.fn(), setIgnoreMouseEvents: vi.fn(),
    loadURL: vi.fn(async () => undefined)
  });
  const create = vi.fn((_options: BrowserWindowConstructorOptions) => overlay as unknown as BrowserWindow);
  const errors = vi.fn();
  const port = createWindowsWorkspaceResizeIndicators(parent as unknown as BrowserWindow, create, errors);
  const indicators = [{ surfaceId: "slot-a", label: "33.3% × 50%", bounds: {x:0,y:40,width:320,height:320} }];
  return { parent, overlay, webContents, create, port, indicators, writes, errors };
}

describe("Windows native resize indicator presentation", () => {
  it("does not create a host for empty hints and cannot revive hints after a late document load", () => {
    const h = harness();
    h.port.update([]); expect(h.create).not.toHaveBeenCalled();
    h.port.update(h.indicators); h.port.update([]);
    h.webContents.emit("did-finish-load");
    expect(h.webContents.executeJavaScript).not.toHaveBeenCalled();
    expect(h.overlay.showInactive).not.toHaveBeenCalled();
    expect(h.overlay.setIgnoreMouseEvents).toHaveBeenCalledWith(true);
    expect(h.create.mock.calls[0]![0]).toMatchObject({ focusable:false, parent:h.parent, show:false });
  });
  it("fences in-flight painting across cancellation and the next gesture", async () => {
    const h = harness();
    h.port.update(h.indicators); h.webContents.emit("did-finish-load");
    expect(h.webContents.executeJavaScript.mock.calls[0]).toBeDefined();
    h.port.update([]); h.writes[0]!.resolve(); await Promise.resolve();
    expect(h.overlay.showInactive).not.toHaveBeenCalled();
    h.port.update(h.indicators); h.writes[1]!.resolve(); await Promise.resolve();
    expect(h.overlay.showInactive).toHaveBeenCalledOnce();
    h.parent.emit("hide"); expect(h.overlay.hide).toHaveBeenCalled();
    h.parent.emit("closed"); expect(h.overlay.destroy).toHaveBeenCalledOnce();
  });
  it("reports a failed native paint without displaying a partial hint", async () => {
    const h = harness();
    h.port.update(h.indicators); h.webContents.emit("did-finish-load");
    const failure = new Error("native paint failed"); h.writes[0]!.reject(failure); await Promise.resolve();
    expect(h.errors).toHaveBeenCalledWith(failure);
    expect(h.overlay.showInactive).not.toHaveBeenCalled();
  });
});
