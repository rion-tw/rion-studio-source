import { existsSync } from "node:fs";
import { createRequire } from "node:module";

import type { BaseWindow } from "electron";

import type { PixelBounds } from "../../shared/types";
import type {
  BrowserCookieTransferRecord,
  SystemSessionStorePort
} from "./ElectronProfileEffectAdapter";
import type {
  WebSurfaceLifecycleEvent,
  WebSurfacePort
} from "./ports/WebSurfacePort";

const NATIVE_PROTOCOL_VERSION = 1;
const OPERATION_TIMEOUT_MS = 30_000;

export interface WindowsWebView2NativeAddon {
  callWebView2DevToolsMethod(
    surfaceId: number,
    requestId: string,
    method: string,
    parametersJson: string
  ): void;
  clearWebView2Data(surfaceId: number, requestId: string): void;
  createWebView2Surface(
    windowHandle: Buffer,
    options: { userDataFolder: string },
    callback: (event: unknown) => void
  ): number;
  destroyWebView2Surface(surfaceId: number): void;
  evaluateWebView2(surfaceId: number, requestId: string, source: string): void;
  focusWebView2(surfaceId: number): void;
  getWebView2Cookies(surfaceId: number, requestId: string): void;
  loadWebView2URL(surfaceId: number, url: string): void;
  protocolVersion: number;
  setWebView2AudioMuted(surfaceId: number, muted: boolean): boolean;
  setWebView2Bounds(surfaceId: number, bounds: PixelBounds): void;
  setWebView2Cookies(
    surfaceId: number,
    requestId: string,
    cookies: readonly BrowserCookieTransferRecord[]
  ): void;
  setWebView2Visible(surfaceId: number, visible: boolean): void;
  setWebView2Zoom(surfaceId: number, factor: number): void;
}

export interface WindowsWebView2SurfacePort extends WebSurfacePort {
  callDevToolsProtocolMethod<T = unknown>(
    method: string,
    parameters?: Record<string, unknown>
  ): Promise<T>;
}

export type WindowsWebView2SurfaceFactory = (
  window: BaseWindow,
  options: { userDataFolder: string }
) => WindowsWebView2SurfacePort;

type NativeSurfaceEvent =
  | { type: "audioChanged"; audible: boolean }
  | { type: "crashed"; reason?: string }
  | { type: "cookiesRead"; requestId: string; cookiesJson: string; error?: string }
  | { type: "cookiesWritten"; requestId: string; count?: number; error?: string }
  | { type: "devToolsCompleted"; requestId: string; valueJson?: string; error?: string }
  | { type: "evaluationCompleted"; requestId: string; valueJson?: string; error?: string }
  | { type: "navigationCompleted"; url: string }
  | { type: "navigationFailed"; url: string; errorCode?: string }
  | { type: "popupRequested"; url: string }
  | { type: "websiteDataCleared"; requestId: string; error?: string };

interface PendingOperation {
  reject: (error: Error) => void;
  resolve: (value: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

const sessionStores = new WeakMap<WindowsWebView2SurfacePort, SystemSessionStorePort>();

export function createWindowsWebView2SurfaceFactory(
  addon: WindowsWebView2NativeAddon
): WindowsWebView2SurfaceFactory {
  if (addon.protocolVersion !== NATIVE_PROTOCOL_VERSION) {
    throw new Error(
      `Unsupported Windows WebView2 protocol ${addon.protocolVersion}; ` +
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
        operation.reject(surfaceError("WEBVIEW2_OPERATION_FAILED", error));
      } else {
        operation.resolve(value);
      }
    };
    const invoke = <T>(start: (requestId: string) => void): Promise<T> => {
      if (destroyed) {
        return Promise.reject(
          surfaceError("WEBVIEW2_DESTROYED", "The WebView2 surface is destroyed.")
        );
      }
      const requestId = `wv2-${nextRequestId++}`;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(surfaceError("WEBVIEW2_OPERATION_TIMEOUT", "The WebView2 operation timed out."));
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
        case "cookiesRead":
          if (event.error) {
            settle(event.requestId, event.error, undefined);
            return;
          }
          try {
            const cookies = JSON.parse(event.cookiesJson) as unknown;
            if (!Array.isArray(cookies)) throw new Error("Cookie payload is not an array.");
            settle(event.requestId, undefined, cookies);
          } catch {
            settle(event.requestId, "WebView2 returned invalid cookie JSON.", undefined);
          }
          return;
        case "cookiesWritten":
          settle(event.requestId, event.error, event.count ?? 0);
          return;
        case "devToolsCompleted":
        case "evaluationCompleted":
          try {
            settle(
              event.requestId,
              event.error,
              event.valueJson === undefined ? undefined : JSON.parse(event.valueJson)
            );
          } catch {
            settle(event.requestId, "WebView2 returned invalid JSON.", undefined);
          }
          return;
        case "websiteDataCleared":
          settle(event.requestId, event.error, undefined);
          return;
        case "navigationCompleted":
          pendingNavigation?.resolve();
          pendingNavigation = undefined;
          publish(event);
          return;
        case "navigationFailed":
          pendingNavigation?.reject(surfaceError(
            "WEBVIEW2_NAVIGATION_FAILED",
            `WebView2 failed to load ${event.url}.`
          ));
          pendingNavigation = undefined;
          publish(event);
          return;
        default:
          publish(event);
      }
    };

    const surfaceId = addon.createWebView2Surface(
      window.getNativeWindowHandle(),
      options,
      handleEvent
    );
    const surface: WindowsWebView2SurfacePort = {
      callDevToolsProtocolMethod: <T>(
        method: string,
        parameters: Record<string, unknown> = {}
      ) => invoke<T>((requestId) => {
        addon.callWebView2DevToolsMethod(
          surfaceId,
          requestId,
          method,
          JSON.stringify(parameters)
        );
      }),
      clearStorage: () => invoke<void>((requestId) => {
        addon.clearWebView2Data(surfaceId, requestId);
      }),
      destroy: async () => {
        if (destroyed) return;
        destroyed = true;
        pendingNavigation?.reject(
          surfaceError("WEBVIEW2_DESTROYED", "The WebView2 surface was destroyed.")
        );
        pendingNavigation = undefined;
        for (const operation of pending.values()) {
          clearTimeout(operation.timer);
          operation.reject(
            surfaceError("WEBVIEW2_DESTROYED", "The WebView2 surface was destroyed.")
          );
        }
        pending.clear();
        listeners.clear();
        addon.destroyWebView2Surface(surfaceId);
      },
      evaluate: <T>(source: string) => invoke<T>((requestId) => {
        addon.evaluateWebView2(surfaceId, requestId, source);
      }),
      focus: async () => {
        addon.focusWebView2(surfaceId);
      },
      loadUrl: (url) => {
        if (destroyed) {
          return Promise.reject(
            surfaceError("WEBVIEW2_DESTROYED", "The WebView2 surface is destroyed.")
          );
        }
        pendingNavigation?.reject(
          surfaceError("WEBVIEW2_NAVIGATION_SUPERSEDED", "WebView2 navigation was superseded.")
        );
        return new Promise<void>((resolve, reject) => {
          pendingNavigation = { reject, resolve };
          try {
            addon.loadWebView2URL(surfaceId, url);
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
        if (!addon.setWebView2AudioMuted(surfaceId, muted)) {
          throw surfaceError(
            "WEBVIEW2_MUTE_UNSUPPORTED",
            "This WebView2 Runtime does not expose the required mute capability."
          );
        }
      },
      setBounds: async (bounds) => {
        addon.setWebView2Bounds(surfaceId, bounds);
      },
      setVisible: async (visible) => {
        addon.setWebView2Visible(surfaceId, visible);
      },
      setZoomFactor: async (factor) => {
        addon.setWebView2Zoom(surfaceId, factor);
      }
    };
    sessionStores.set(surface, {
      clearCookies: () => invoke<void>((requestId) => {
        addon.clearWebView2Data(surfaceId, requestId);
      }),
      getCookies: () => invoke<BrowserCookieTransferRecord[]>((requestId) => {
        addon.getWebView2Cookies(surfaceId, requestId);
      }),
      setCookies: (cookies) => invoke<number>((requestId) => {
        addon.setWebView2Cookies(surfaceId, requestId, cookies);
      })
    });
    return surface;
  };
}

export function getWindowsWebView2SessionStore(
  surface: WindowsWebView2SurfacePort
): SystemSessionStorePort {
  const store = sessionStores.get(surface);
  if (!store) {
    throw surfaceError(
      "SYSTEM_SESSION_STORE_UNAVAILABLE",
      "The WebView2 surface has no session-store adapter."
    );
  }
  return store;
}

export function loadWindowsWebView2SurfaceFactory(
  addonPath: string,
  logger: Pick<Console, "warn"> = console
): WindowsWebView2SurfaceFactory | undefined {
  if (!existsSync(addonPath)) {
    logger.warn(`Windows WebView2 native addon was not found at ${addonPath}.`);
    return undefined;
  }
  try {
    const require = createRequire(import.meta.url);
    return createWindowsWebView2SurfaceFactory(
      require(addonPath) as WindowsWebView2NativeAddon
    );
  } catch (error) {
    logger.warn("Windows WebView2 native addon could not be loaded.", error);
    return undefined;
  }
}

function parseNativeSurfaceEvent(value: unknown): NativeSurfaceEvent | undefined {
  if (!value || typeof value !== "object") return undefined;
  const event = value as Record<string, unknown>;
  if (typeof event.type !== "string") return undefined;
  return event as NativeSurfaceEvent;
}

function surfaceError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
