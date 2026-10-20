import { describe, expect, it, vi } from "vitest";

import { RionBridgeError } from "../src/electron/ipc/errors";
import { RION_API_EVENT_METHODS } from "../src/electron/ipc/apiMethods";
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

    expect(exposeInMainWorld).toHaveBeenCalledWith(RION_STUDIO_GLOBAL, expect.any(Object));
    const exposed = exposeInMainWorld.mock.calls[0]![1] as Record<string, unknown>;
    expect(Object.isFrozen(exposed)).toBe(true);
    expect(Object.keys(exposed).sort()).toEqual(Object.keys(api).sort());
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

  it("keeps the error code when a page-facing call fails across contextBridge", async () => {
    const ipc = createIpcRenderer();
    ipc.invoke.mockResolvedValueOnce({
      ok: false,
      error: { code: "MACRO_ROLE_INPUT_RESTART_REQUIRED", message: "Restart the role." }
    });
    const exposeInMainWorld = vi.fn();
    installRionStudioPreloadBridge({ exposeInMainWorld }, ipc.port);
    const exposed = exposeInMainWorld.mock.calls[0]![1] as { getAppVersion: () => Promise<string> };

    const rejection = await exposed.getAppVersion().catch((error: unknown) => error);
    // contextBridge drops Error properties, so the page receives a plain object.
    expect(rejection).not.toBeInstanceOf(Error);
    expect(rejection).toEqual({
      name: "RionBridgeError",
      code: "MACRO_ROLE_INPUT_RESTART_REQUIRED",
      message: "Restart the role."
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

it("multiplexes every event method over one channel listener", () => {
  const ipc = createIpcRenderer();
  const api = createRionStudioPreloadApi(ipc.port);
  const methods = Object.keys(RION_API_EVENT_METHODS) as (keyof typeof RION_API_EVENT_METHODS)[];

  // All 26 event methods share one channel, so one listener per subscription
  // exceeded Node's default maxListeners of 10 and re-parsed every envelope
  // once per subscribed method.
  const unsubscribes = methods.map((method) =>
    (api[method] as (callback: () => void) => () => void)(() => undefined)
  );
  expect(methods.length).toBeGreaterThan(10);
  expect(ipc.listeners.size).toBe(1);

  unsubscribes.forEach((unsubscribe) => unsubscribe());
  expect(ipc.listeners.size).toBe(0);
});

it("delivers an event only to the callbacks subscribed to that method", () => {
  const ipc = createIpcRenderer();
  const api = createRionStudioPreloadApi(ipc.port);
  const rolesChanged = vi.fn();
  const gamesChanged = vi.fn();
  api.onRolesChanged(rolesChanged);
  api.onGamesChanged(gamesChanged);

  const [listener] = [...ipc.listeners];
  listener?.({}, { method: "onRolesChanged", payload: [] });

  expect(rolesChanged).toHaveBeenCalledOnce();
  expect(gamesChanged).not.toHaveBeenCalled();
});
