import type { CoreErrorPayload } from "../../shared/generated";
import {
  isRionApiEventMethod,
  isRionApiInvokeMethod,
  isRionApiNotifyMethod,
  type RionApiArgs,
  type RionApiEventMethod,
  type RionApiEventPayload,
  type RionApiInvokeMethod,
  type RionApiNotifyMethod
} from "./apiMethods";
import { RionBridgeError } from "./errors";

export const RION_IPC_CHANNELS = Object.freeze({
  invoke: "rion:api:invoke",
  notify: "rion:api:notify",
  event: "rion:api:event"
} as const);

export interface RionInvokeRequest<Method extends RionApiInvokeMethod = RionApiInvokeMethod> {
  method: Method;
  args: RionApiArgs<Method>;
}

export interface RionNotifyRequest<Method extends RionApiNotifyMethod = RionApiNotifyMethod> {
  method: Method;
  args: RionApiArgs<Method>;
}

export interface RionEventEnvelope<Method extends RionApiEventMethod = RionApiEventMethod> {
  method: Method;
  payload: RionApiEventPayload<Method>;
}

export type RionInvokeResponse<Value = unknown> =
  | { ok: true; value: Value }
  | { ok: false; error: CoreErrorPayload };

function recordFrom(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RionBridgeError({
      code: "ELECTRON_IPC_INVALID_REQUEST",
      message: "The desktop request envelope is invalid."
    });
  }
  return value as Record<string, unknown>;
}

export function parseInvokeRequest(value: unknown): RionInvokeRequest {
  const request = recordFrom(value);
  if (!isRionApiInvokeMethod(request.method)) {
    throw new RionBridgeError({
      code: "ELECTRON_IPC_METHOD_NOT_ALLOWED",
      message: "The requested desktop method is not allowed."
    });
  }
  if (!Array.isArray(request.args)) {
    throw new RionBridgeError({
      code: "ELECTRON_IPC_INVALID_REQUEST",
      message: "The desktop request arguments are invalid."
    });
  }
  return { method: request.method, args: request.args as never };
}

export function parseNotifyRequest(value: unknown): RionNotifyRequest {
  const request = recordFrom(value);
  if (!isRionApiNotifyMethod(request.method)) {
    throw new RionBridgeError({
      code: "ELECTRON_IPC_METHOD_NOT_ALLOWED",
      message: "The requested desktop notification is not allowed."
    });
  }
  if (!Array.isArray(request.args)) {
    throw new RionBridgeError({
      code: "ELECTRON_IPC_INVALID_REQUEST",
      message: "The desktop notification arguments are invalid."
    });
  }
  return { method: request.method, args: request.args as never };
}

export function parseEventEnvelope(value: unknown): RionEventEnvelope | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const envelope = value as Record<string, unknown>;
  if (!isRionApiEventMethod(envelope.method) || !Array.isArray(envelope.payload)) return null;
  return { method: envelope.method, payload: envelope.payload as never };
}

export function parseInvokeResponse(value: unknown): RionInvokeResponse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RionBridgeError({
      code: "ELECTRON_IPC_INVALID_RESPONSE",
      message: "The desktop response envelope is invalid."
    });
  }
  const response = value as Record<string, unknown>;
  if (response.ok === true && Object.hasOwn(response, "value")) {
    return { ok: true, value: response.value };
  }
  if (response.ok === false) {
    const error = response.error;
    if (typeof error === "object" && error !== null) {
      const payload = error as Record<string, unknown>;
      if (typeof payload.code === "string" && typeof payload.message === "string") {
        return { ok: false, error: { code: payload.code, message: payload.message } };
      }
    }
  }
  throw new RionBridgeError({
    code: "ELECTRON_IPC_INVALID_RESPONSE",
    message: "The desktop response envelope is invalid."
  });
}
