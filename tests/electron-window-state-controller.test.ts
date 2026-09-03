import { describe, expect, it, vi } from "vitest";

import {
  ElectronWindowStateController,
  type ElectronWindowStateEvent,
  type ElectronWindowStatePort
} from "../src/electron/main/windowStateController";

function harness() {
  const listeners = new Map<ElectronWindowStateEvent, Set<() => void>>();
  const semantic = {
    visible: false,
    minimized: false,
    maximized: false,
    fullscreen: false,
    focused: false
  };
  const window: ElectronWindowStatePort = {
    isVisible: () => semantic.visible,
    isMinimized: () => semantic.minimized,
    isMaximized: () => semantic.maximized,
    isFullScreen: () => semantic.fullscreen,
    isFocused: () => semantic.focused,
    on: (event, listener) => {
      const registered = listeners.get(event) ?? new Set();
      registered.add(listener);
      listeners.set(event, registered);
    },
    removeListener: (event, listener) => listeners.get(event)?.delete(listener)
  };
  const publish = vi.fn();
  let lifecycleEpoch = 4;
  const controller = new ElectronWindowStateController({
    window,
    windowGeneration: 3,
    lifecycleEpoch: () => lifecycleEpoch,
    publish,
    now: () => "2026-08-30T00:00:00.000Z"
  });
  return {
    controller,
    emit: (event: ElectronWindowStateEvent) => {
      for (const listener of listeners.get(event) ?? []) listener();
    },
    listeners,
    publish,
    semantic,
    setLifecycleEpoch: (value: number) => {
      lifecycleEpoch = value;
    }
  };
}

describe("Electron main-window state controller", () => {
  it("captures the stable main-window identity and only revises semantic changes", () => {
    const test = harness();
    expect(test.controller.start()).toEqual({
      revision: 1,
      capturedAt: "2026-08-30T00:00:00.000Z",
      windowId: "main",
      windowGeneration: 3,
      lifecycleEpoch: 4,
      visible: false,
      minimized: false,
      maximized: false,
      fullscreen: false,
      focused: false
    });

    test.emit("show");
    expect(test.publish).not.toHaveBeenCalled();

    test.semantic.visible = true;
    test.semantic.focused = true;
    test.emit("show");
    expect(test.publish).toHaveBeenCalledWith(expect.objectContaining({
      revision: 2,
      visible: true,
      focused: true
    }));
    expect(test.controller.snapshot().revision).toBe(2);
  });

  it("revises a lifecycle epoch change even when native flags stay stable", () => {
    const test = harness();
    test.controller.start();
    test.setLifecycleEpoch(5);

    expect(test.controller.snapshot()).toMatchObject({
      revision: 2,
      lifecycleEpoch: 5
    });
  });

  it("installs and removes each authoritative native listener exactly once", () => {
    const test = harness();
    test.controller.start();
    test.controller.start();
    expect([...test.listeners.values()].every((listeners) => listeners.size === 1)).toBe(true);

    test.controller.dispose();
    test.controller.dispose();
    expect([...test.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
  });
});
