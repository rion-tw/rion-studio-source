import type { BrowserWindow } from "electron";
import { describe, expect, it, vi } from "vitest";

import {
  bindAppWindowStateBroadcast,
  getAppWindowState
} from "../src/main/window/appWindowState";
import { IPC_CHANNELS } from "../src/shared/ipc";

describe("app window state", () => {
  it("reads the current native fullscreen state", () => {
    expect(getAppWindowState({ isFullScreen: () => true })).toEqual({ fullscreen: true });
    expect(getAppWindowState({ isFullScreen: () => false })).toEqual({ fullscreen: false });
  });

  it("broadcasts only native fullscreen transitions from the bound window", () => {
    const harness = createWindowHarness();
    const cleanup = bindAppWindowStateBroadcast(harness.window);

    harness.fullscreen = true;
    harness.emit("enter-full-screen");
    expect(harness.send).toHaveBeenLastCalledWith(
      IPC_CHANNELS.appWindowStateChanged,
      { fullscreen: true }
    );

    harness.fullscreen = false;
    harness.emit("leave-full-screen");
    expect(harness.send).toHaveBeenLastCalledWith(
      IPC_CHANNELS.appWindowStateChanged,
      { fullscreen: false }
    );
    expect(harness.send).toHaveBeenCalledTimes(2);

    cleanup();
    harness.fullscreen = true;
    harness.emit("enter-full-screen");
    expect(harness.send).toHaveBeenCalledTimes(2);
  });

  it("does not send after the window or its web contents is destroyed", () => {
    const harness = createWindowHarness();
    bindAppWindowStateBroadcast(harness.window);

    harness.windowDestroyed = true;
    harness.emit("enter-full-screen");
    harness.windowDestroyed = false;
    harness.webContentsDestroyed = true;
    harness.emit("leave-full-screen");

    expect(harness.send).not.toHaveBeenCalled();
  });
});

function createWindowHarness() {
  const listeners = new Map<string, Set<() => void>>();
  const send = vi.fn();
  const harness = {
    fullscreen: false,
    send,
    webContentsDestroyed: false,
    windowDestroyed: false,
    emit(event: string): void {
      for (const listener of [...(listeners.get(event) ?? [])]) listener();
    },
    window: undefined as unknown as BrowserWindow
  };
  const window = {
    isDestroyed: () => harness.windowDestroyed,
    isFullScreen: () => harness.fullscreen,
    off(event: string, listener: () => void) {
      listeners.get(event)?.delete(listener);
      return this;
    },
    on(event: string, listener: () => void) {
      const eventListeners = listeners.get(event) ?? new Set();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
      return this;
    },
    once(event: string, listener: () => void) {
      const onceListener = (): void => {
        listeners.get(event)?.delete(onceListener);
        listener();
      };
      return this.on(event, onceListener);
    },
    webContents: {
      isDestroyed: () => harness.webContentsDestroyed,
      send
    }
  };
  harness.window = window as unknown as BrowserWindow;
  return harness;
}
