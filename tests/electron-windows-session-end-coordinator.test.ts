import { describe, expect, it, vi } from "vitest";

import {
  ElectronWindowsSessionEndCoordinator,
  type ElectronWindowsSessionEndEventPort,
  type ElectronWindowsSessionEndWindowPort
} from "../src/electron/main/windowsSessionEndCoordinator";

function createWindow() {
  let listener: ((event: ElectronWindowsSessionEndEventPort) => void) | undefined;
  const window: ElectronWindowsSessionEndWindowPort = {
    on: vi.fn((_event, nextListener) => {
      listener = nextListener;
    }),
    removeListener: vi.fn((_event, currentListener) => {
      if (listener === currentListener) listener = undefined;
    })
  };
  return {
    emit: (event: ElectronWindowsSessionEndEventPort) => listener?.(event),
    hasListener: () => listener !== undefined,
    window
  };
}

describe("Electron Windows session-end coordinator", () => {
  it("fences repeated native session-end queries behind one terminal Core drain", async () => {
    const nativeWindow = createWindow();
    let finishQuit: (() => void) | undefined;
    const confirmQuit = vi.fn(() => new Promise<void>((resolve) => {
      finishQuit = resolve;
    }));
    const coordinator = new ElectronWindowsSessionEndCoordinator({
      platform: "win32",
      window: nativeWindow.window,
      confirmQuit,
      onError: vi.fn()
    });
    coordinator.start();
    coordinator.start();

    const firstPreventDefault = vi.fn();
    const secondPreventDefault = vi.fn();
    nativeWindow.emit({ preventDefault: firstPreventDefault });
    nativeWindow.emit({ preventDefault: secondPreventDefault });

    expect(firstPreventDefault).toHaveBeenCalledOnce();
    expect(secondPreventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(confirmQuit).toHaveBeenCalledOnce());
    const terminal = coordinator.terminalResult();
    expect(terminal).not.toBeNull();
    finishQuit?.();
    await expect(terminal).resolves.toBeUndefined();
    expect(nativeWindow.window.on).toHaveBeenCalledOnce();
  });

  it("reports and replays the exact failed terminal result", async () => {
    const nativeWindow = createWindow();
    const failure = new Error("Core drain failed");
    const confirmQuit = vi.fn(async () => {
      throw failure;
    });
    const onError = vi.fn();
    const coordinator = new ElectronWindowsSessionEndCoordinator({
      platform: "win32",
      window: nativeWindow.window,
      confirmQuit,
      onError
    });
    coordinator.start();

    nativeWindow.emit({ preventDefault: vi.fn() });
    const terminal = coordinator.terminalResult();
    expect(terminal).not.toBeNull();
    await expect(terminal).rejects.toBe(failure);
    nativeWindow.emit({ preventDefault: vi.fn() });
    await expect(coordinator.terminalResult()).rejects.toBe(failure);
    expect(confirmQuit).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      code: "ELECTRON_WINDOWS_SESSION_END_FAILED"
    }));
  });

  it("preserves the exact drain failure when observational reporting throws", async () => {
    const nativeWindow = createWindow();
    const failure = new Error("Core drain failed");
    const coordinator = new ElectronWindowsSessionEndCoordinator({
      platform: "win32",
      window: nativeWindow.window,
      confirmQuit: vi.fn(async () => { throw failure; }),
      onError: vi.fn(() => { throw new Error("reporter failed"); })
    });
    coordinator.start();

    nativeWindow.emit({ preventDefault: vi.fn() });
    await expect(coordinator.terminalResult()).rejects.toBe(failure);
  });

  it("does not bind a Windows-only native event on macOS", () => {
    const nativeWindow = createWindow();
    const coordinator = new ElectronWindowsSessionEndCoordinator({
      platform: "darwin",
      window: nativeWindow.window,
      confirmQuit: vi.fn(async () => undefined),
      onError: vi.fn()
    });
    coordinator.start();

    expect(nativeWindow.hasListener()).toBe(false);
    expect(nativeWindow.window.on).not.toHaveBeenCalled();
  });

  it("detaches its native listener without cancelling an admitted drain", async () => {
    const nativeWindow = createWindow();
    const confirmQuit = vi.fn(async () => undefined);
    const coordinator = new ElectronWindowsSessionEndCoordinator({
      platform: "win32",
      window: nativeWindow.window,
      confirmQuit,
      onError: vi.fn()
    });
    coordinator.start();
    nativeWindow.emit({ preventDefault: vi.fn() });
    coordinator.dispose();

    expect(nativeWindow.hasListener()).toBe(false);
    expect(nativeWindow.window.removeListener).toHaveBeenCalledOnce();
    await expect(coordinator.terminalResult()).resolves.toBeUndefined();
    expect(confirmQuit).toHaveBeenCalledOnce();
  });
});
