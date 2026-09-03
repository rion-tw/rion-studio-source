import { describe, expect, it, vi } from "vitest";

import {
  ElectronApplicationShortcutController,
  type ElectronShortcutMainWindowPort
} from "../src/electron/main/electronApplicationShortcutController";
import type { RendererIdentity } from "../src/electron/main/rendererIdentity";

const identity: RendererIdentity = {
  kind: "main-renderer",
  windowId: 41,
  webContentsId: 73,
  generation: 5
};

type WindowEvent = "closed" | "enter-full-screen" | "leave-full-screen";

class FakeMainWindow implements ElectronShortcutMainWindowPort {
  readonly id = identity.windowId;
  destroyed = false;
  fullscreen = false;
  zoomFactor = 1.25;
  readonly fullscreenRequests: boolean[] = [];
  readonly listeners = new Map<WindowEvent, Set<() => void>>();
  readonly webContents = {
    id: identity.webContentsId,
    isDestroyed: () => this.destroyed,
    getZoomFactor: () => this.zoomFactor,
    setZoomFactor: (factor: number) => {
      this.zoomFactor = factor;
    }
  };

  isDestroyed(): boolean {
    return this.destroyed;
  }

  isFullScreen(): boolean {
    return this.fullscreen;
  }

  on(event: WindowEvent, listener: () => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  removeListener(event: WindowEvent, listener: () => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  setFullScreen(fullscreen: boolean): void {
    this.fullscreenRequests.push(fullscreen);
    this.fullscreen = fullscreen;
  }

  emit(event: WindowEvent): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener();
  }
}

function harness() {
  const window = new FakeMainWindow();
  const resolveMainWindow = vi.fn(() => window);
  const createNewGameWindow = vi.fn(async () => undefined);
  const requestApplicationQuit = vi.fn(async () => undefined);
  const controller = new ElectronApplicationShortcutController({
    resolveMainWindow,
    createNewGameWindow,
    requestApplicationQuit
  });
  return {
    controller,
    createNewGameWindow,
    requestApplicationQuit,
    resolveMainWindow,
    window
  };
}

describe("Electron application shortcut controller", () => {
  it("routes new-window and quit through exact authenticated lifecycle actions", async () => {
    const state = harness();

    await state.controller.execute(identity, "newGameWindow");
    await state.controller.execute(identity, "quitApplication");

    expect(state.createNewGameWindow).toHaveBeenCalledWith(identity, state.window);
    expect(state.requestApplicationQuit).toHaveBeenCalledWith(identity, state.window);
    expect(state.resolveMainWindow).toHaveBeenCalledWith(identity);
  });

  it("applies reset, in, and out to the exact main Chromium WebContents", async () => {
    const state = harness();

    await state.controller.execute(identity, "zoomIn");
    expect(state.window.zoomFactor).toBe(1.35);
    await state.controller.execute(identity, "zoomOut");
    expect(state.window.zoomFactor).toBe(1.25);
    await state.controller.execute(identity, "zoomReset");
    expect(state.window.zoomFactor).toBe(1);
  });

  it("waits for the exact native fullscreen event and serializes overlapping toggles", async () => {
    const state = harness();
    let firstSettled = false;
    const first = state.controller.execute(identity, "toggleFullscreen")
      .then(() => { firstSettled = true; });
    const second = state.controller.execute(identity, "toggleFullscreen");
    await Promise.resolve();
    await Promise.resolve();

    expect(state.window.fullscreenRequests).toEqual([true]);
    expect(firstSettled).toBe(false);
    state.window.emit("enter-full-screen");
    await first;
    await Promise.resolve();
    expect(state.window.fullscreenRequests).toEqual([true, false]);

    state.window.emit("leave-full-screen");
    await second;
    expect(state.window.listeners.get("closed")?.size ?? 0).toBe(0);
  });

  it("fails a pending fullscreen transition when the exact window retires", async () => {
    const state = harness();
    const operation = state.controller.execute(identity, "toggleFullscreen");
    await Promise.resolve();
    await Promise.resolve();
    expect(state.window.fullscreenRequests).toEqual([true]);
    state.window.destroyed = true;
    state.window.emit("closed");

    await expect(operation).rejects.toMatchObject({
      code: "ELECTRON_MAIN_WINDOW_RETIRED"
    });
  });

  it("cancels a pending fullscreen transition so quit cannot be trapped behind it", async () => {
    const state = harness();
    const fullscreen = state.controller.execute(identity, "toggleFullscreen");
    const queuedZoom = state.controller.execute(identity, "zoomIn");
    await Promise.resolve();
    await Promise.resolve();

    await state.controller.execute(identity, "quitApplication");

    await expect(fullscreen).rejects.toMatchObject({
      code: "ELECTRON_MAIN_WINDOW_FULLSCREEN_CANCELLED"
    });
    await expect(queuedZoom).rejects.toMatchObject({
      code: "ELECTRON_APPLICATION_SHORTCUT_SUPERSEDED"
    });
    expect(state.requestApplicationQuit).toHaveBeenCalledTimes(1);
    expect(state.window.zoomFactor).toBe(1.25);
    expect(state.window.listeners.get("closed")?.size ?? 0).toBe(0);
  });

  it("does not let an unauthenticated quit cancel a live fullscreen transition", async () => {
    const state = harness();
    const fullscreen = state.controller.execute(identity, "toggleFullscreen");
    await Promise.resolve();
    await Promise.resolve();
    state.window.destroyed = true;

    await expect(state.controller.execute(identity, "quitApplication"))
      .rejects.toMatchObject({ code: "ELECTRON_IPC_UNAUTHORIZED_SENDER" });
    expect(state.requestApplicationQuit).not.toHaveBeenCalled();

    state.window.destroyed = false;
    state.window.emit("enter-full-screen");
    await fullscreen;
  });

  it("authenticates before every effect and keeps imperative drag fail-closed", async () => {
    const state = harness();
    state.window.destroyed = true;
    await expect(state.controller.execute(identity, "newGameWindow"))
      .rejects.toMatchObject({ code: "ELECTRON_IPC_UNAUTHORIZED_SENDER" });
    expect(state.createNewGameWindow).not.toHaveBeenCalled();

    state.window.destroyed = false;
    expect(() => state.controller.startCurrentWindowDrag(identity)).toThrowError(
      expect.objectContaining({
        code: "ELECTRON_NATIVE_WINDOW_DRAG_REGION_REQUIRED"
      })
    );
  });

  it("rejects invalid zoom readback and unsupported runtime command values", async () => {
    const state = harness();
    state.window.webContents.setZoomFactor = () => undefined;
    await expect(state.controller.execute(identity, "zoomIn"))
      .rejects.toMatchObject({ code: "ELECTRON_MAIN_WINDOW_ZOOM_NOT_APPLIED" });

    await expect(state.controller.execute(identity, "unsupported" as never))
      .rejects.toMatchObject({ code: "ELECTRON_APPLICATION_SHORTCUT_INVALID" });
  });
});
