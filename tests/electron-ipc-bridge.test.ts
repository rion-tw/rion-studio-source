import { describe, expect, it, vi } from "vitest";

import { RION_IPC_CHANNELS } from "../src/electron/ipc/protocol";
import type {
  ElectronIpcInvokeListener,
  ElectronIpcNotifyListener,
  ElectronWebContentsPort,
  ElectronWindowPort
} from "../src/electron/main/electronPorts";
import {
  registerRionIpcBridge,
  type RionApiDispatcher,
  type RionIpcBridgeRegistration
} from "../src/electron/main/registerIpcBridge";
import { RendererIdentityRegistry } from "../src/electron/main/rendererIdentity";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createWindow(windowId = 1, webContentsId = 101): {
  window: ElectronWindowPort;
  contents: ElectronWebContentsPort;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn();
  const contents: ElectronWebContentsPort = {
    id: webContentsId,
    isDestroyed: () => false,
    send
  };
  return {
    contents,
    send,
    window: {
      id: windowId,
      isDestroyed: () => false,
      webContents: contents
    }
  };
}

function createIpcMain() {
  const invokeListeners = new Map<string, ElectronIpcInvokeListener>();
  const notifyListeners = new Map<string, ElectronIpcNotifyListener>();
  return {
    invokeListeners,
    notifyListeners,
    port: {
      handle: vi.fn((channel: string, listener: ElectronIpcInvokeListener) => {
        invokeListeners.set(channel, listener);
      }),
      removeHandler: vi.fn((channel: string) => invokeListeners.delete(channel)),
      on: vi.fn((channel: string, listener: ElectronIpcNotifyListener) => {
        notifyListeners.set(channel, listener);
      }),
      removeListener: vi.fn((channel: string, listener: ElectronIpcNotifyListener) => {
        if (notifyListeners.get(channel) === listener) notifyListeners.delete(channel);
      })
    }
  };
}

describe("Electron main IPC bridge", () => {
  it("registers only the fixed invoke and notification channels", () => {
    const ipc = createIpcMain();
    const identities = new RendererIdentityRegistry(() => null);
    const dispatcher = { invoke: vi.fn() } as unknown as RionApiDispatcher;

    const registration = registerRionIpcBridge({
      ipcMain: ipc.port,
      identities,
      dispatcher
    });

    expect([...ipc.invokeListeners.keys()]).toEqual([RION_IPC_CHANNELS.invoke]);
    expect([...ipc.notifyListeners.keys()]).toEqual([RION_IPC_CHANNELS.notify]);
    expect(ipc.invokeListeners.has("getAppVersion")).toBe(false);

    registration.dispose();
    registration.dispose();
    expect(ipc.invokeListeners).toHaveLength(0);
    expect(ipc.notifyListeners).toHaveLength(0);
    expect(ipc.port.removeHandler).toHaveBeenCalledOnce();
    expect(ipc.port.removeListener).toHaveBeenCalledOnce();
  });

  it("checks the exact sender and owner window before dispatching", async () => {
    const ipc = createIpcMain();
    const renderer = createWindow();
    let owner: ElectronWindowPort | null = renderer.window;
    const identities = new RendererIdentityRegistry((contents) =>
      contents === renderer.contents ? owner : null
    );
    const identity = identities.registerMainWindow(renderer.window, 4);
    const invoke = vi.fn(async () => "1.2.3");
    registerRionIpcBridge({
      ipcMain: ipc.port,
      identities,
      dispatcher: { invoke } as unknown as RionApiDispatcher
    });
    const handler = ipc.invokeListeners.get(RION_IPC_CHANNELS.invoke);
    expect(handler).toBeDefined();

    await expect(handler?.(
      { sender: renderer.contents },
      { method: "getAppVersion", args: [] }
    )).resolves.toEqual({ ok: true, value: "1.2.3" });
    expect(invoke).toHaveBeenCalledWith(identity, "getAppVersion", []);

    const spoofedContents = { ...renderer.contents };
    await expect(handler?.(
      { sender: spoofedContents },
      { method: "getAppVersion", args: [] }
    )).resolves.toMatchObject({
      ok: false,
      error: { code: "ELECTRON_IPC_UNAUTHORIZED_SENDER" }
    });

    owner = null;
    await expect(handler?.(
      { sender: renderer.contents },
      { method: "getAppVersion", args: [] }
    )).resolves.toMatchObject({
      ok: false,
      error: { code: "ELECTRON_IPC_UNAUTHORIZED_SENDER" }
    });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("rejects methods outside the API allowlist and publishes only to a live identity", async () => {
    const ipc = createIpcMain();
    const renderer = createWindow();
    const identities = new RendererIdentityRegistry(() => renderer.window);
    const identity = identities.registerMainWindow(renderer.window, 1);
    const invoke = vi.fn();
    const registration = registerRionIpcBridge({
      ipcMain: ipc.port,
      identities,
      dispatcher: { invoke } as unknown as RionApiDispatcher
    });
    const handler = ipc.invokeListeners.get(RION_IPC_CHANNELS.invoke);

    await expect(handler?.(
      { sender: renderer.contents },
      { method: "executeArbitraryJavaScript", args: [] }
    )).resolves.toMatchObject({
      ok: false,
      error: { code: "ELECTRON_IPC_METHOD_NOT_ALLOWED" }
    });
    expect(invoke).not.toHaveBeenCalled();

    expect(registration.publish(identity, "onApplicationQuitRequested")).toBe(true);
    expect(renderer.send).toHaveBeenCalledWith(RION_IPC_CHANNELS.event, {
      method: "onApplicationQuitRequested",
      payload: []
    });

    identities.release(identity);
    expect(registration.publish(identity, "onApplicationQuitRequested")).toBe(false);
    expect(renderer.send).toHaveBeenCalledOnce();
  });

  it("closes renderer admission synchronously and drains an admitted destructive command", async () => {
    const ipc = createIpcMain();
    const renderer = createWindow();
    const identities = new RendererIdentityRegistry(() => renderer.window);
    identities.registerMainWindow(renderer.window, 1);
    const command = deferred<undefined>();
    const invoke = vi.fn(() => command.promise);
    const registration = registerRionIpcBridge({
      ipcMain: ipc.port,
      identities,
      dispatcher: { invoke } as unknown as RionApiDispatcher
    });
    const handler = ipc.invokeListeners.get(RION_IPC_CHANNELS.invoke)!;
    const request = {
      method: "clearRoleBrowserData",
      args: ["11111111-1111-4111-8111-111111111111"]
    } as const;

    const admitted = handler({ sender: renderer.contents }, request);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
    const drain = registration.closeAndDrain();
    let drained = false;
    void drain.then(() => { drained = true; });
    expect(ipc.invokeListeners).toHaveLength(0);
    expect(ipc.notifyListeners).toHaveLength(0);
    await expect(handler({ sender: renderer.contents }, request)).resolves.toMatchObject({
      ok: false,
      error: { code: "ELECTRON_IPC_DRAINING" }
    });
    expect(invoke).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(drained).toBe(false);

    command.resolve(undefined);
    await expect(admitted).resolves.toEqual({ ok: true, value: undefined });
    await expect(drain).resolves.toBeUndefined();
    await expect(registration.closeAndDrain()).resolves.toBeUndefined();
  });

  it.each([
    ["quitApplication", []],
    ["confirmApplicationQuit", []],
    ["executeApplicationShortcut", ["quitApplication"]],
    ["installDownloadedUpdate", []]
  ] as const)("lets the %s IPC owner enter its own shutdown drain", async (method, args) => {
    const ipc = createIpcMain();
    const renderer = createWindow();
    const identities = new RendererIdentityRegistry(() => renderer.window);
    identities.registerMainWindow(renderer.window, 1);
    const invoke = vi.fn(async () => { await registration.closeAndDrain(); });
    const registration: RionIpcBridgeRegistration = registerRionIpcBridge({
      ipcMain: ipc.port,
      identities,
      dispatcher: { invoke } as unknown as RionApiDispatcher
    });
    const handler = ipc.invokeListeners.get(RION_IPC_CHANNELS.invoke)!;

    await expect(handler({ sender: renderer.contents }, { method, args }))
      .resolves.toEqual({ ok: true, value: undefined });
    expect(invoke).toHaveBeenCalledOnce();
    await expect(registration.closeAndDrain()).resolves.toBeUndefined();
  });

  it("releases concurrent drain owners while still waiting for ordinary work", async () => {
    const ipc = createIpcMain();
    const renderer = createWindow();
    const identities = new RendererIdentityRegistry(() => renderer.window);
    identities.registerMainWindow(renderer.window, 1);
    const ordinary = deferred<undefined>();
    const beginOwners = deferred<undefined>();
    const drains: Promise<void>[] = [];
    const invoke = vi.fn(async (_identity, method) => {
      if (method === "clearRoleBrowserData") return ordinary.promise;
      await beginOwners.promise;
      const drain = registration.closeAndDrain();
      drains.push(drain);
      await drain;
    });
    const registration = registerRionIpcBridge({
      ipcMain: ipc.port,
      identities,
      dispatcher: { invoke } as unknown as RionApiDispatcher
    });
    const handler = ipc.invokeListeners.get(RION_IPC_CHANNELS.invoke)!;
    const ordinaryWork = handler({ sender: renderer.contents }, {
      method: "clearRoleBrowserData",
      args: ["11111111-1111-4111-8111-111111111111"]
    });
    const firstOwner = handler({ sender: renderer.contents }, {
      method: "confirmApplicationQuit", args: []
    });
    const secondOwner = handler({ sender: renderer.contents }, {
      method: "installDownloadedUpdate", args: []
    });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(3));
    beginOwners.resolve(undefined);
    await vi.waitFor(() => expect(drains).toHaveLength(2));
    expect(drains[1]).toBe(drains[0]);

    ordinary.resolve(undefined);
    await expect(ordinaryWork).resolves.toEqual({ ok: true, value: undefined });
    await expect(firstOwner).resolves.toEqual({ ok: true, value: undefined });
    await expect(secondOwner).resolves.toEqual({ ok: true, value: undefined });
  });
});
