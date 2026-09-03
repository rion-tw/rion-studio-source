import { describe, expect, it, vi } from "vitest";

import { RionBridgeError } from "../src/electron/ipc/errors";
import { RION_IPC_CHANNELS } from "../src/electron/ipc/protocol";
import {
  createRionStudioPreloadApi,
  installRionStudioPreloadBridge,
  RION_STUDIO_GLOBAL,
  type ElectronIpcRendererPort
} from "../src/electron/preload/installRionStudioBridge";

function createIpcRenderer() {
  const listeners = new Set<(event: unknown, envelope: unknown) => void>();
  const invoke = vi.fn(async (): Promise<unknown> => ({ ok: true, value: "1.2.3" }));
  const send = vi.fn();
  const port: ElectronIpcRendererPort = {
    invoke,
    send,
    on: vi.fn((_channel, listener) => listeners.add(listener)),
    removeListener: vi.fn((_channel, listener) => listeners.delete(listener))
  };
  return { invoke, listeners, port, send };
}

describe("Electron sandbox preload bridge", () => {
  it("exposes a frozen window.rionStudio-compatible API over fixed channels", async () => {
    const ipc = createIpcRenderer();
    const exposeInMainWorld = vi.fn();
    const api = installRionStudioPreloadBridge({ exposeInMainWorld }, ipc.port);

    expect(exposeInMainWorld).toHaveBeenCalledWith(RION_STUDIO_GLOBAL, api);
    expect(Object.isFrozen(api)).toBe(true);
    await expect(api.getAppVersion()).resolves.toBe("1.2.3");
    expect(ipc.invoke).toHaveBeenCalledWith(RION_IPC_CHANNELS.invoke, {
      method: "getAppVersion",
      args: []
    });

    expect(api.reportRendererLog({
      event: "renderer_error",
      message: "failed"
    })).toBeUndefined();
    expect(ipc.send).toHaveBeenCalledWith(RION_IPC_CHANNELS.notify, {
      method: "reportRendererLog",
      args: [{ event: "renderer_error", message: "failed" }]
    });
  });

  it("reconstructs a stable coded error without Electron serialization noise", async () => {
    const ipc = createIpcRenderer();
    ipc.invoke.mockResolvedValueOnce({
      ok: false,
      error: { code: "ROLE_NOT_FOUND", message: "Role not found." }
    });
    const api = createRionStudioPreloadApi(ipc.port);

    const rejection = api.getAppVersion().catch((error: unknown) => error);
    await expect(rejection).resolves.toBeInstanceOf(RionBridgeError);
    await expect(rejection).resolves.toMatchObject({
      code: "ROLE_NOT_FOUND",
      message: "Role not found."
    });
  });

  it("removes the exact event listener once when a subscription is cancelled", () => {
    const ipc = createIpcRenderer();
    const api = createRionStudioPreloadApi(ipc.port);
    const callback = vi.fn();
    const unsubscribe = api.onRolesChanged(callback);
    expect(ipc.listeners).toHaveLength(1);

    const listener = [...ipc.listeners][0];
    listener({}, { method: "onGamesChanged", payload: [[{ id: "game" }]] });
    listener({}, { method: "onRolesChanged", payload: [[{ id: "role" }]] });
    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith([{ id: "role" }]);

    unsubscribe();
    unsubscribe();
    expect(ipc.listeners).toHaveLength(0);
    expect(ipc.port.removeListener).toHaveBeenCalledOnce();
    listener({}, { method: "not-allowlisted", payload: [[]] });
    expect(callback).toHaveBeenCalledOnce();
  });
});
