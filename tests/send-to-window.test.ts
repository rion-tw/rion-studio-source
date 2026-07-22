import { describe, expect, it, vi } from "vitest";

import { sendToWindowIfAvailable } from "../src/main/window/sendToWindow";

function createWindow(options: {
  destroyed?: boolean;
  sendError?: Error;
  webContentsDestroyed?: boolean;
} = {}) {
  return {
    isDestroyed: vi.fn(() => options.destroyed ?? false),
    webContents: {
      isDestroyed: vi.fn(() => options.webContentsDestroyed ?? false),
      send: vi.fn(() => {
        if (options.sendError) throw options.sendError;
      })
    }
  };
}

describe("sendToWindowIfAvailable", () => {
  it("sends to a live renderer", () => {
    const window = createWindow();

    expect(sendToWindowIfAvailable(window as never, "logs:entry-added", { id: "entry-1" })).toBe(true);
    expect(window.webContents.send).toHaveBeenCalledWith("logs:entry-added", { id: "entry-1" });
  });

  it("skips a window whose web contents was destroyed during shutdown", () => {
    const window = createWindow({ webContentsDestroyed: true });

    expect(sendToWindowIfAvailable(window as never, "logs:entry-added", {})).toBe(false);
    expect(window.webContents.send).not.toHaveBeenCalled();
  });

  it("absorbs the Electron destruction race but preserves unrelated send failures", () => {
    const destroyed = createWindow({ sendError: new TypeError("Object has been destroyed") });
    const unrelated = createWindow({ sendError: new Error("IPC serialization failed") });

    expect(sendToWindowIfAvailable(destroyed as never, "logs:entry-added", {})).toBe(false);
    expect(() => sendToWindowIfAvailable(unrelated as never, "logs:entry-added", {})).toThrow(
      "IPC serialization failed"
    );
  });
});
