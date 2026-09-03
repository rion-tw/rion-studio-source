import { AsyncLocalStorage } from "node:async_hooks";

import {
  type RionApiArgs,
  type RionApiDispatchMethod,
  type RionApiEventMethod,
  type RionApiEventPayload,
  type RionApiResult
} from "../ipc/apiMethods";
import { normalizeRionBridgeError, RionBridgeError } from "../ipc/errors";
import {
  parseInvokeRequest,
  parseNotifyRequest,
  RION_IPC_CHANNELS,
  type RionEventEnvelope,
  type RionInvokeResponse
} from "../ipc/protocol";
import type {
  ElectronIpcInvokeListener,
  ElectronIpcMainPort
} from "./electronPorts";
import type { RendererIdentity } from "./rendererIdentity";
import { RendererIdentityRegistry } from "./rendererIdentity";

export interface RionApiDispatcher {
  invoke: <Method extends RionApiDispatchMethod>(
    identity: RendererIdentity,
    method: Method,
    args: RionApiArgs<Method>
  ) => Promise<RionApiResult<Method>>;
}

export interface RionIpcBridgeRegistration {
  closeAndDrain: () => Promise<void>;
  dispose: () => void;
  publish: <Method extends RionApiEventMethod>(
    identity: RendererIdentity,
    method: Method,
    ...payload: RionApiEventPayload<Method>
  ) => boolean;
}

export interface RegisterRionIpcBridgeInput {
  ipcMain: ElectronIpcMainPort;
  identities: RendererIdentityRegistry;
  dispatcher: RionApiDispatcher;
  onNotificationError?: (error: ReturnType<typeof normalizeRionBridgeError>) => void;
}

interface InFlightInvocation {
  owner: boolean;
  ownerDeclared: Promise<void>;
  terminal: Promise<void>;
  markOwner: () => void;
  markTerminal: () => void;
}

function inFlightInvocation(): InFlightInvocation {
  let markOwner!: () => void;
  let markTerminal!: () => void;
  const record: InFlightInvocation = {
    owner: false,
    ownerDeclared: new Promise<void>((resolve) => { markOwner = resolve; }),
    terminal: new Promise<void>((resolve) => { markTerminal = resolve; }),
    markOwner: () => {
      if (record.owner) return;
      record.owner = true;
      markOwner();
    },
    markTerminal
  };
  return record;
}

function waitForTerminalOrOwnership(record: InFlightInvocation): Promise<void> {
  if (record.owner) return Promise.resolve();
  return new Promise<void>((resolve) => {
    void record.terminal.then(resolve);
    void record.ownerDeclared.then(resolve);
  });
}

export function registerRionIpcBridge(
  input: RegisterRionIpcBridgeInput
): RionIpcBridgeRegistration {
  const invocationContext = new AsyncLocalStorage<object>();
  const inFlight = new Map<object, InFlightInvocation>();
  let disposed = false;
  let drainPromise: Promise<void> | null = null;
  const admit = (token: object): InFlightInvocation => {
    const record = inFlightInvocation();
    inFlight.set(token, record);
    return record;
  };
  const track = <Value>(
    token: object,
    record: InFlightInvocation,
    work: Promise<Value>
  ): Promise<Value> => {
    const release = (): void => {
      record.markTerminal();
      if (inFlight.get(token) === record) inFlight.delete(token);
    };
    void work.then(release, release);
    return work;
  };
  const requireOpen = (): void => {
    if (!disposed) return;
    throw new RionBridgeError({
      code: "ELECTRON_IPC_DRAINING",
      message: "The renderer command bridge is closed for application shutdown."
    });
  };
  const invokeListener: ElectronIpcInvokeListener = (
    event,
    request
  ): Promise<RionInvokeResponse> => {
    let parsed: ReturnType<typeof parseInvokeRequest>;
    let identity: RendererIdentity;
    try {
      requireOpen();
      parsed = parseInvokeRequest(request);
      identity = input.identities.authorize(event.sender);
    } catch (error) {
      return Promise.resolve({ ok: false, error: normalizeRionBridgeError(error) });
    }
    const token = {};
    const record = admit(token);
    const work = invocationContext.run(token, async (): Promise<RionInvokeResponse> => {
      try {
        const value = await input.dispatcher.invoke(identity, parsed.method, parsed.args);
        return { ok: true, value };
      } catch (error) {
        return { ok: false, error: normalizeRionBridgeError(error) };
      }
    });
    return track(token, record, work);
  };

  const closeIngress = (): void => {
    if (disposed) return;
    disposed = true;
    input.ipcMain.removeHandler(RION_IPC_CHANNELS.invoke);
    input.ipcMain.removeListener(RION_IPC_CHANNELS.notify, notifyListener);
  };

  const notifyListener: Parameters<ElectronIpcMainPort["on"]>[1] = (event, request) => {
    if (disposed) return;
    try {
      const parsed = parseNotifyRequest(request);
      const identity = input.identities.authorize(event.sender);
      const token = {};
      const record = admit(token);
      const work = invocationContext.run(token, () =>
        input.dispatcher.invoke(identity, parsed.method, parsed.args)
          .catch((error) => input.onNotificationError?.(normalizeRionBridgeError(error))));
      void track(token, record, work);
    } catch (error) {
      input.onNotificationError?.(normalizeRionBridgeError(error));
    }
  };

  input.ipcMain.handle(RION_IPC_CHANNELS.invoke, invokeListener);
  input.ipcMain.on(RION_IPC_CHANNELS.notify, notifyListener);

  return {
    closeAndDrain: () => {
      const owner = invocationContext.getStore();
      if (owner) inFlight.get(owner)?.markOwner();
      closeIngress();
      if (drainPromise) return drainPromise;
      drainPromise = (async () => {
        let cohort = [...inFlight.values()].filter((record) => !record.owner);
        while (cohort.length > 0) {
          await Promise.all(cohort.map(waitForTerminalOrOwnership));
          cohort = [...inFlight.values()].filter((record) => !record.owner);
        }
      })();
      return drainPromise;
    },
    dispose: closeIngress,
    publish: (identity, method, ...payload) => {
      if (disposed) return false;
      const contents = input.identities.contentsFor(identity);
      if (!contents) return false;
      const envelope: RionEventEnvelope<typeof method> = { method, payload };
      contents.send(RION_IPC_CHANNELS.event, envelope);
      return true;
    }
  };
}
