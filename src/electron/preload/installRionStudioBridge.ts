import type { RionStudioApi } from "../../shared/api";
import {
  RION_API_EVENT_METHODS,
  RION_API_INVOKE_METHODS,
  RION_API_NOTIFY_METHODS,
  type RionApiEventMethod
} from "../ipc/apiMethods";
import { bridgeErrorFromPayload } from "../ipc/errors";
import {
  parseEventEnvelope,
  parseInvokeResponse,
  RION_IPC_CHANNELS
} from "../ipc/protocol";

export const RION_STUDIO_GLOBAL = "rionStudio";

type IpcRendererListener = (event: unknown, envelope: unknown) => void;

export interface ElectronIpcRendererPort {
  invoke: (channel: string, request: unknown) => Promise<unknown>;
  send: (channel: string, request: unknown) => void;
  on: (channel: string, listener: IpcRendererListener) => void;
  removeListener: (channel: string, listener: IpcRendererListener) => void;
}

export interface ElectronContextBridgePort {
  exposeInMainWorld: (apiKey: string, api: unknown) => void;
}

type EventCallback = (...payload: unknown[]) => void;

/**
 * Multiplexes every event method over one channel listener.
 *
 * All 26 event methods share `RION_IPC_CHANNELS.event`, so one listener per
 * subscription exceeded Node's default `maxListeners` of 10 -- emitting a
 * warning in every session that would mask a genuine listener leak -- and made
 * each delivered event parse its envelope once per subscribed method.
 */
function createEventRouter(ipcRenderer: ElectronIpcRendererPort) {
  const callbacksByMethod = new Map<RionApiEventMethod, Set<EventCallback>>();
  let attached = false;
  const listener: IpcRendererListener = (_event, candidate) => {
    const envelope = parseEventEnvelope(candidate);
    if (!envelope) return;
    const callbacks = callbacksByMethod.get(envelope.method as RionApiEventMethod);
    if (!callbacks) return;
    for (const callback of [...callbacks]) {
      callback(...envelope.payload as unknown[]);
    }
  };
  return (method: RionApiEventMethod, callback: EventCallback): (() => void) => {
    let callbacks = callbacksByMethod.get(method);
    if (!callbacks) {
      callbacks = new Set();
      callbacksByMethod.set(method, callbacks);
    }
    callbacks.add(callback);
    if (!attached) {
      attached = true;
      ipcRenderer.on(RION_IPC_CHANNELS.event, listener);
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = callbacksByMethod.get(method);
      if (!current) return;
      current.delete(callback);
      if (current.size === 0) callbacksByMethod.delete(method);
      if (callbacksByMethod.size === 0 && attached) {
        attached = false;
        ipcRenderer.removeListener(RION_IPC_CHANNELS.event, listener);
      }
    };
  };
}

export function createRionStudioPreloadApi(
  ipcRenderer: ElectronIpcRendererPort
): Readonly<RionStudioApi> {
  const api: Record<string, unknown> = {};
  for (const method of Object.keys(RION_API_INVOKE_METHODS)) {
    api[method] = async (...args: unknown[]) => {
      const response = parseInvokeResponse(await ipcRenderer.invoke(
        RION_IPC_CHANNELS.invoke,
        { method, args }
      ));
      if (!response.ok) throw bridgeErrorFromPayload(response.error);
      return response.value;
    };
  }
  for (const method of Object.keys(RION_API_NOTIFY_METHODS)) {
    api[method] = (...args: unknown[]) => {
      ipcRenderer.send(RION_IPC_CHANNELS.notify, { method, args });
    };
  }
  const subscribe = createEventRouter(ipcRenderer);
  for (const method of Object.keys(RION_API_EVENT_METHODS) as RionApiEventMethod[]) {
    api[method] = (callback: EventCallback) => subscribe(method, callback);
  }
  return Object.freeze(api) as unknown as Readonly<RionStudioApi>;
}

export function installRionStudioPreloadBridge(
  contextBridge: ElectronContextBridgePort,
  ipcRenderer: ElectronIpcRendererPort
): Readonly<RionStudioApi> {
  const api = createRionStudioPreloadApi(ipcRenderer);
  contextBridge.exposeInMainWorld(RION_STUDIO_GLOBAL, api);
  return api;
}
