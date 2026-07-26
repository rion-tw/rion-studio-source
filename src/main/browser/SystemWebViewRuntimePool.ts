import type { BaseWindow } from "electron";

import type { ResolvedBrowserEngine, RolePathsRecord } from "../../shared/generated";
import type { PixelBounds } from "../../shared/types";
import type { MacSystemWebViewSurfaceFactory } from "./MacSystemWebViewSurface";
import type {
  WindowsWebView2SurfaceFactory,
  WindowsWebView2SurfacePort
} from "./WindowsWebView2Surface";
import type { AutomationTargetPort } from "./ports/AutomationTargetPort";
import type {
  WebSurfaceLifecycleEvent,
  WebSurfacePort
} from "./ports/WebSurfacePort";

export interface NativeRoleSurfaceHandle {
  engine: Extract<ResolvedBrowserEngine, "webview2" | "wkwebview">;
  hostWindow: BaseWindow;
  roleId: string;
  surface: WebSurfacePort;
  target?: AutomationTargetPort;
}

export interface NativeRoleSurfaceConfiguration {
  additionalBrowserArguments?: string;
  documentStartScript?: string;
  proxyServer?: string;
}

export interface SystemWebViewRuntimePoolOptions {
  createMacSurface?: MacSystemWebViewSurfaceFactory;
  createWindowsAutomationTarget?: (
    roleId: string,
    surface: WindowsWebView2SurfacePort
  ) => AutomationTargetPort;
  createWindowsSurface?: WindowsWebView2SurfaceFactory;
  onLifecycleEvent?: (
    roleId: string,
    engine: NativeRoleSurfaceHandle["engine"],
    event: WebSurfaceLifecycleEvent
  ) => void;
  platform: NodeJS.Platform;
}

/**
 * Owns native game surfaces without owning the Electron host window.
 *
 * A surface is always parented to the exact BaseWindow supplied by the runtime
 * host. Moving it to another OS window therefore requires an explicit destroy
 * and recreate transaction; callers must never silently reparent or share one
 * native surface between windows.
 */
export class SystemWebViewRuntimePool {
  private readonly handles = new Map<string, NativeRoleSurfaceHandle>();
  private readonly unsubscribe = new Map<string, () => void>();

  constructor(private readonly options: SystemWebViewRuntimePoolOptions) {}

  capability(): {
    available: boolean;
    engine: NativeRoleSurfaceHandle["engine"];
    reason?: string;
  } {
    if (this.options.platform === "darwin") {
      return this.options.createMacSurface
        ? { available: true, engine: "wkwebview" }
        : {
            available: false,
            engine: "wkwebview",
            reason: "The macOS WKWebView native adapter could not be loaded."
          };
    }
    return this.options.createWindowsSurface
      ? { available: true, engine: "webview2" }
      : {
          available: false,
          engine: "webview2",
          reason: "The Windows WebView2 native adapter could not be loaded."
        };
  }

  create(
    roleId: string,
    hostWindow: BaseWindow,
    paths: RolePathsRecord,
    configuration: NativeRoleSurfaceConfiguration = {}
  ): NativeRoleSurfaceHandle {
    if (this.handles.has(roleId)) {
      throw poolError(
        "SYSTEM_ROLE_SURFACE_DUPLICATE",
        `A native surface already exists for role ${roleId}.`
      );
    }
    let handle: NativeRoleSurfaceHandle;
    const proxyConfiguration = configuration.proxyServer
      ? { proxyServer: configuration.proxyServer }
      : {};
    if (this.options.platform === "darwin") {
      const factory = this.options.createMacSurface;
      if (!factory) {
        throw poolError(
          "SYSTEM_RUNTIME_UNAVAILABLE",
          "The macOS WKWebView native adapter is unavailable."
        );
      }
      handle = {
        engine: "wkwebview",
        hostWindow,
        roleId,
        surface: factory(hostWindow, {
          dataStoreIdentifier: paths.webkitDataStoreIdentifier,
          ...proxyConfiguration
        })
      };
    } else if (this.options.platform === "win32") {
      const factory = this.options.createWindowsSurface;
      if (!factory) {
        throw poolError(
          "SYSTEM_RUNTIME_UNAVAILABLE",
          "The Windows WebView2 native adapter is unavailable."
        );
      }
      const surface = factory(hostWindow, {
        ...(configuration.additionalBrowserArguments
          ? { additionalBrowserArguments: configuration.additionalBrowserArguments }
          : {}),
        userDataFolder: paths.webview2UserDataDir,
        ...proxyConfiguration
      });
      handle = {
        engine: "webview2",
        hostWindow,
        roleId,
        surface,
        ...(this.options.createWindowsAutomationTarget
          ? { target: this.options.createWindowsAutomationTarget(roleId, surface) }
          : {})
      };
    } else {
      throw poolError(
        "SYSTEM_RUNTIME_UNSUPPORTED_PLATFORM",
        `System WebView is unsupported on ${this.options.platform}.`
      );
    }
    const unsubscribe = handle.surface.onLifecycleEvent((event) => {
      this.options.onLifecycleEvent?.(roleId, handle.engine, event);
    });
    this.handles.set(roleId, handle);
    this.unsubscribe.set(roleId, unsubscribe);
    return handle;
  }

  get(roleId: string): NativeRoleSurfaceHandle | undefined {
    return this.handles.get(roleId);
  }

  require(roleId: string): NativeRoleSurfaceHandle {
    const handle = this.handles.get(roleId);
    if (!handle) {
      throw poolError(
        "SYSTEM_ROLE_SURFACE_NOT_FOUND",
        `No native surface exists for role ${roleId}.`
      );
    }
    return handle;
  }

  async load(
    roleId: string,
    url: string,
    bounds: PixelBounds,
    zoomFactor: number,
    visible: boolean
  ): Promise<void> {
    const { surface } = this.require(roleId);
    await surface.setBounds(bounds);
    await surface.setZoomFactor(zoomFactor);
    await surface.setVisible(visible);
    await surface.loadUrl(url);
  }

  async setPresentation(
    roleId: string,
    bounds: PixelBounds,
    visible: boolean,
    zoomFactor?: number
  ): Promise<void> {
    const { surface } = this.require(roleId);
    await surface.setBounds(bounds);
    if (zoomFactor !== undefined) await surface.setZoomFactor(zoomFactor);
    await surface.setVisible(visible);
  }

  async destroy(roleId: string): Promise<void> {
    const handle = this.handles.get(roleId);
    if (!handle) return;
    this.handles.delete(roleId);
    this.unsubscribe.get(roleId)?.();
    this.unsubscribe.delete(roleId);
    await handle.target?.dispose().catch(() => undefined);
    await handle.surface.destroy();
  }

  async destroyAll(): Promise<void> {
    await Promise.all([...this.handles.keys()].map((roleId) => this.destroy(roleId)));
  }
}

function poolError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
