import { describe, expect, it, vi } from "vitest";

import {
  ElectronMainRendererQuitHandshake,
  type ElectronMainRendererQuitWindowPort
} from "../src/electron/main/mainRendererQuitHandshake";
import type { RendererIdentity } from "../src/electron/main/rendererIdentity";

function identity(generation: number): RendererIdentity {
  return {
    kind: "main-renderer",
    windowId: generation,
    webContentsId: generation + 100,
    generation
  };
}

function windowPort(options: {
  destroyed?: boolean;
  minimized?: boolean;
} = {}): ElectronMainRendererQuitWindowPort {
  return {
    focus: vi.fn(),
    isDestroyed: () => options.destroyed ?? false,
    isMinimized: () => options.minimized ?? false,
    restore: vi.fn(),
    show: vi.fn()
  };
}

describe("Electron main-renderer quit handshake", () => {
  it("publishes only after the exact renderer document announces readiness", () => {
    const publishQuitRequested = vi.fn(() => true);
    const handshake = new ElectronMainRendererQuitHandshake({ publishQuitRequested });
    const currentIdentity = identity(1);
    const window = windowPort({ minimized: true });
    handshake.bind(currentIdentity, window);

    expect(handshake.requestConfirmation()).toBe(false);
    expect(publishQuitRequested).not.toHaveBeenCalled();

    handshake.markReady(currentIdentity);
    expect(handshake.requestConfirmation()).toBe(true);
    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
    expect(publishQuitRequested).toHaveBeenCalledWith(currentIdentity);
  });

  it("requires fresh readiness after main-frame replacement or renderer-process loss", () => {
    const publishQuitRequested = vi.fn(() => true);
    const handshake = new ElectronMainRendererQuitHandshake({ publishQuitRequested });
    const currentIdentity = identity(2);
    handshake.bind(currentIdentity, windowPort());
    handshake.markReady(currentIdentity);

    handshake.markUnavailable(currentIdentity);
    expect(handshake.requestConfirmation()).toBe(false);
    handshake.markReady(currentIdentity);
    expect(handshake.requestConfirmation()).toBe(true);

    handshake.markUnavailable(currentIdentity);
    expect(handshake.requestConfirmation()).toBe(false);
    expect(publishQuitRequested).toHaveBeenCalledOnce();
  });

  it("ignores stale window events without clearing the current binding", () => {
    const publishQuitRequested = vi.fn(() => true);
    const handshake = new ElectronMainRendererQuitHandshake({ publishQuitRequested });
    const staleIdentity = identity(3);
    const currentIdentity = identity(4);
    handshake.bind(staleIdentity, windowPort());
    handshake.bind(currentIdentity, windowPort());
    handshake.markReady(currentIdentity);

    handshake.markUnavailable(staleIdentity);
    handshake.release(staleIdentity);

    expect(handshake.requestConfirmation()).toBe(true);
    expect(publishQuitRequested).toHaveBeenCalledWith(currentIdentity);
  });

  it("falls through when the exact native window is destroyed or publishing is rejected", () => {
    const publishQuitRequested = vi.fn(() => false);
    const handshake = new ElectronMainRendererQuitHandshake({ publishQuitRequested });
    const currentIdentity = identity(5);
    handshake.bind(currentIdentity, windowPort({ destroyed: true }));
    handshake.markReady(currentIdentity);

    expect(handshake.requestConfirmation()).toBe(false);
    expect(publishQuitRequested).not.toHaveBeenCalled();

    const replacementIdentity = identity(6);
    handshake.bind(replacementIdentity, windowPort());
    handshake.markReady(replacementIdentity);
    expect(handshake.requestConfirmation()).toBe(false);
    expect(publishQuitRequested).toHaveBeenCalledWith(replacementIdentity);
  });
});
