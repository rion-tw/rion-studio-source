import { existsSync } from "node:fs";
import { createRequire } from "node:module";

import type { BaseWindow } from "electron";

import type { PixelBounds } from "../../shared/types";
import type {
  WebSurfaceLifecycleEvent,
  WebSurfacePort
} from "./ports/WebSurfacePort";
import type {
  BrowserCookieTransferRecord,
  SystemSessionStorePort
} from "./ElectronProfileEffectAdapter";

const NATIVE_PROTOCOL_VERSION = 7;
const OPERATION_TIMEOUT_MS = 30_000;

export interface MacSystemWebViewNativeAddon {
  clearSystemWebViewData(surfaceId: number, requestId: string): void;
  createSystemWebView(
    windowHandle: Buffer,
    options: { dataStoreIdentifier: string },
    callback: (event: unknown) => void
  ): number;
  destroySystemWebView(surfaceId: number): void;
  evaluateSystemWebView(surfaceId: number, requestId: string, source: string): void;
  focusSystemWebView(surfaceId: number): void;
  getSystemWebViewCookies(surfaceId: number, requestId: string): void;
  loadSystemWebViewURL(surfaceId: number, url: string): void;
  protocolVersion: number;
  setSystemWebViewAudioMuted(surfaceId: number, muted: boolean): boolean;
  setSystemWebViewBounds(surfaceId: number, bounds: PixelBounds): void;
  setSystemWebViewCookies(surfaceId: number, requestId: string, cookiesJson: string): void;
  setSystemWebViewVisible(surfaceId: number, visible: boolean): void;
  setSystemWebViewZoom(surfaceId: number, factor: number): void;
}

export interface MacSystemWebViewCreateOptions {
  dataStoreIdentifier: string;
}

export type MacSystemWebViewSurfaceFactory = (
  window: BaseWindow,
  options: MacSystemWebViewCreateOptions
) => WebSurfacePort;

const sessionStores = new WeakMap<WebSurfacePort, SystemSessionStorePort>();

interface PendingOperation {
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

type NativeSurfaceEvent =
  | { type: "audioChanged"; audible: boolean }
  | { type: "crashed"; reason?: string }
  | { type: "cookiesRead"; requestId: string; cookiesJson: string }
  | { type: "cookiesWritten"; requestId: string; count?: number; error?: string }
  | { type: "evaluationCompleted"; requestId: string; valueJson?: string; error?: string }
  | { type: "navigationCompleted"; url: string }
  | { type: "navigationFailed"; url: string; errorCode?: string }
  | { type: "popupRequested"; url: string }
  | { type: "websiteDataCleared"; requestId: string };

export function createMacSystemWebViewSurfaceFactory(
  addon: MacSystemWebViewNativeAddon
): MacSystemWebViewSurfaceFactory {
  if (addon.protocolVersion !== NATIVE_PROTOCOL_VERSION) {
    throw new Error(
      `Unsupported macOS native runtime protocol ${addon.protocolVersion}; ` +
      `expected ${NATIVE_PROTOCOL_VERSION}.`
    );
  }
  return (window, options) => {
    const listeners = new Set<(event: WebSurfaceLifecycleEvent) => void>();
    const pending = new Map<string, PendingOperation>();
    let pendingNavigation:
      | { reject: (error: Error) => void; resolve: () => void }
      | undefined;
    let destroyed = false;
    let nextRequestId = 1;

    const settle = (
      requestId: string,
      error: string | undefined,
      value: unknown
    ): void => {
      const operation = pending.get(requestId);
      if (!operation) return;
      pending.delete(requestId);
      clearTimeout(operation.timer);
      if (error) {
        operation.reject(surfaceError("SYSTEM_WEBVIEW_OPERATION_FAILED", error));
      } else {
        operation.resolve(value);
      }
    };
    const invoke = <T>(
      start: (requestId: string) => void
    ): Promise<T> => {
      if (destroyed) {
        return Promise.reject(
          surfaceError("SYSTEM_WEBVIEW_DESTROYED", "The WKWebView surface is destroyed.")
        );
      }
      const requestId = `wk-${nextRequestId++}`;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(surfaceError(
            "SYSTEM_WEBVIEW_OPERATION_TIMEOUT",
            "The WKWebView operation timed out."
          ));
        }, OPERATION_TIMEOUT_MS);
        pending.set(requestId, {
          reject,
          resolve: (value) => resolve(value as T),
          timer
        });
        try {
          start(requestId);
        } catch (error) {
          clearTimeout(timer);
          pending.delete(requestId);
          reject(error);
        }
      });
    };
    const publish = (event: WebSurfaceLifecycleEvent): void => {
      listeners.forEach((listener) => listener(event));
    };
    const handleEvent = (value: unknown): void => {
      const event = parseNativeSurfaceEvent(value);
      if (!event || destroyed) return;
      switch (event.type) {
        case "cookiesRead": {
          try {
            const cookies = JSON.parse(event.cookiesJson) as unknown;
            if (!Array.isArray(cookies)) throw new Error("Cookie payload is not an array.");
            settle(event.requestId, undefined, cookies);
          } catch {
            settle(event.requestId, "WKWebView returned invalid cookie JSON.", undefined);
          }
          return;
        }
        case "cookiesWritten":
          settle(event.requestId, event.error, event.count ?? 0);
          return;
        case "evaluationCompleted": {
          let result: unknown;
          try {
            result = event.valueJson === undefined ? undefined : JSON.parse(event.valueJson);
          } catch {
            settle(event.requestId, "WKWebView returned invalid JSON.", undefined);
            return;
          }
          settle(event.requestId, event.error, result);
          return;
        }
        case "websiteDataCleared":
          settle(event.requestId, undefined, undefined);
          return;
        case "navigationCompleted":
          pendingNavigation?.resolve();
          pendingNavigation = undefined;
          publish(event);
          return;
        case "navigationFailed":
          pendingNavigation?.reject(surfaceError(
            "SYSTEM_WEBVIEW_NAVIGATION_FAILED",
            `WKWebView failed to load ${event.url}.`
          ));
          pendingNavigation = undefined;
          publish(event);
          return;
        default:
          publish(event);
      }
    };

    const surfaceId = addon.createSystemWebView(
      window.getNativeWindowHandle(),
      options,
      handleEvent
    );
    const surface: WebSurfacePort = {
      clearStorage: () => invoke<void>((requestId) => {
        addon.clearSystemWebViewData(surfaceId, requestId);
      }),
      destroy: async () => {
        if (destroyed) return;
        destroyed = true;
        pendingNavigation?.reject(surfaceError(
          "SYSTEM_WEBVIEW_DESTROYED",
          "The WKWebView surface was destroyed during navigation."
        ));
        pendingNavigation = undefined;
        for (const operation of pending.values()) {
          clearTimeout(operation.timer);
          operation.reject(surfaceError(
            "SYSTEM_WEBVIEW_DESTROYED",
            "The WKWebView surface was destroyed during an operation."
          ));
        }
        pending.clear();
        listeners.clear();
        addon.destroySystemWebView(surfaceId);
      },
      evaluate: <T>(source: string) => invoke<T>((requestId) => {
        addon.evaluateSystemWebView(surfaceId, requestId, source);
      }),
      focus: async () => {
        addon.focusSystemWebView(surfaceId);
      },
      loadUrl: (url: string) => {
        if (destroyed) {
          return Promise.reject(surfaceError(
            "SYSTEM_WEBVIEW_DESTROYED",
            "The WKWebView surface is destroyed."
          ));
        }
        pendingNavigation?.reject(surfaceError(
          "SYSTEM_WEBVIEW_NAVIGATION_SUPERSEDED",
          "WKWebView navigation was superseded."
        ));
        return new Promise<void>((resolve, reject) => {
          pendingNavigation = { reject, resolve };
          try {
            addon.loadSystemWebViewURL(surfaceId, url);
          } catch (error) {
            pendingNavigation = undefined;
            reject(error);
          }
        });
      },
      onLifecycleEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      setAudioMuted: async (muted) => {
        if (!addon.setSystemWebViewAudioMuted(surfaceId, muted)) {
          throw surfaceError(
            "SYSTEM_WEBVIEW_MUTE_UNSUPPORTED",
            "This macOS WebKit build does not expose the required mute capability."
          );
        }
      },
      setBounds: async (bounds) => {
        addon.setSystemWebViewBounds(surfaceId, bounds);
      },
      setVisible: async (visible) => {
        addon.setSystemWebViewVisible(surfaceId, visible);
      },
      setZoomFactor: async (factor) => {
        addon.setSystemWebViewZoom(surfaceId, factor);
      }
    };
    sessionStores.set(surface, {
      clearCookies: () => invoke<void>((requestId) => {
        addon.clearSystemWebViewData(surfaceId, requestId);
      }),
      getCookies: () => invoke<BrowserCookieTransferRecord[]>((requestId) => {
        addon.getSystemWebViewCookies(surfaceId, requestId);
      }),
      setCookies: (cookies) => invoke<number>((requestId) => {
        addon.setSystemWebViewCookies(surfaceId, requestId, JSON.stringify(cookies));
      })
    });
    return surface;
  };
}

export function getMacSystemWebViewSessionStore(
  surface: WebSurfacePort
): SystemSessionStorePort {
  const store = sessionStores.get(surface);
  if (!store) {
    throw surfaceError(
      "SYSTEM_SESSION_STORE_UNAVAILABLE",
      "The WKWebView surface has no session-store adapter."
    );
  }
  return store;
}

export function loadMacSystemWebViewSurfaceFactory(
  addonPath: string,
  logger: Pick<Console, "warn"> = console
): MacSystemWebViewSurfaceFactory | undefined {
  if (!existsSync(addonPath)) {
    logger.warn(`macOS native runtime addon was not found at ${addonPath}.`);
    return undefined;
  }
  try {
    const require = createRequire(import.meta.url);
    return createMacSystemWebViewSurfaceFactory(
      require(addonPath) as MacSystemWebViewNativeAddon
    );
  } catch (error) {
    logger.warn("Failed to load the macOS System WebView adapter.", error);
    return undefined;
  }
}

function parseNativeSurfaceEvent(value: unknown): NativeSurfaceEvent | undefined {
  if (!value || typeof value !== "object") return undefined;
  const event = value as Record<string, unknown>;
  switch (event.type) {
    case "audioChanged":
      return typeof event.audible === "boolean"
        ? { type: "audioChanged", audible: event.audible }
        : undefined;
    case "crashed":
      return typeof event.reason === "string"
        ? { type: "crashed", reason: event.reason }
        : { type: "crashed" };
    case "cookiesRead":
      return typeof event.requestId === "string" && typeof event.cookiesJson === "string"
        ? {
            type: "cookiesRead",
            requestId: event.requestId,
            cookiesJson: event.cookiesJson
          }
        : undefined;
    case "cookiesWritten":
      return typeof event.requestId === "string"
        ? {
            type: "cookiesWritten",
            requestId: event.requestId,
            ...(typeof event.count === "number" ? { count: event.count } : {}),
            ...(typeof event.error === "string" ? { error: event.error } : {})
          }
        : undefined;
    case "evaluationCompleted":
      return typeof event.requestId === "string"
        ? {
            type: "evaluationCompleted",
            requestId: event.requestId,
            ...(typeof event.valueJson === "string" ? { valueJson: event.valueJson } : {}),
            ...(typeof event.error === "string" ? { error: event.error } : {})
          }
        : undefined;
    case "navigationCompleted":
      return typeof event.url === "string"
        ? { type: "navigationCompleted", url: event.url }
        : undefined;
    case "navigationFailed":
      return typeof event.url === "string"
        ? {
            type: "navigationFailed",
            url: event.url,
            ...(typeof event.errorCode === "string" ? { errorCode: event.errorCode } : {})
          }
        : undefined;
    case "popupRequested":
      return typeof event.url === "string"
        ? { type: "popupRequested", url: event.url }
        : undefined;
    case "websiteDataCleared":
      return typeof event.requestId === "string"
        ? { type: "websiteDataCleared", requestId: event.requestId }
        : undefined;
    default:
      return undefined;
  }
}

function surfaceError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}
