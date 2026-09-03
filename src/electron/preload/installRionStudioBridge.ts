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

function eventSubscription(
  ipcRenderer: ElectronIpcRendererPort,
  method: RionApiEventMethod,
  callback: (...payload: unknown[]) => void
): () => void {
  const listener: IpcRendererListener = (_event, candidate) => {
    const envelope = parseEventEnvelope(candidate);
    if (envelope?.method === method) callback(...envelope.payload as unknown[]);
  };
  ipcRenderer.on(RION_IPC_CHANNELS.event, listener);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    ipcRenderer.removeListener(RION_IPC_CHANNELS.event, listener);
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
  for (const method of Object.keys(RION_API_EVENT_METHODS) as RionApiEventMethod[]) {
    api[method] = (callback: (...payload: unknown[]) => void) =>
      eventSubscription(ipcRenderer, method, callback);
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
