import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import type { BaseWindow } from "electron";

import type { MacSystemWebViewSurfaceFactory } from "./MacSystemWebViewSurface";
import type { NativeRoleSurfaceConfiguration } from "./SystemWebViewRuntimePool";
import type { WindowsWebView2SurfaceFactory } from "./WindowsWebView2Surface";
import type { WebSurfacePort } from "./ports/WebSurfacePort";

export interface SystemCompatibilitySurface {
  cleanup?: () => Promise<void>;
  surface: WebSurfacePort;
}

export type SystemCompatibilitySurfaceFactory = (
  window: BaseWindow,
  runId: string,
  configuration: NativeRoleSurfaceConfiguration
) => SystemCompatibilitySurface;

interface SystemCompatibilitySurfaceFactoryOptions {
  createMacSurface?: MacSystemWebViewSurfaceFactory;
  createWindowsSurface?: WindowsWebView2SurfaceFactory;
  platform: NodeJS.Platform;
  userDataDir: string;
}

/** Creates short-lived compatibility surfaces without reusing any role store. */
export function createSystemCompatibilitySurfaceFactory(
  options: SystemCompatibilitySurfaceFactoryOptions
): SystemCompatibilitySurfaceFactory {
  return (window, _runId, configuration) => {
    if (options.platform === "darwin" && options.createMacSurface) {
      return {
        surface: options.createMacSurface(window, {
          dataStoreIdentifier: randomUUID().toUpperCase(),
          ...(configuration.proxyServer
            ? { proxyServer: configuration.proxyServer }
            : {})
        })
      };
    }
    if (options.platform === "win32" && options.createWindowsSurface) {
      const compatibilityDirectory = join(
        options.userDataDir,
        "compatibility",
        randomUUID()
      );
      return {
        cleanup: () => rm(compatibilityDirectory, { force: true, recursive: true }),
        surface: options.createWindowsSurface(window, {
          userDataFolder: join(compatibilityDirectory, "webview2"),
          ...(configuration.additionalBrowserArguments
            ? { additionalBrowserArguments: configuration.additionalBrowserArguments }
            : {}),
          ...(configuration.proxyServer
            ? { proxyServer: configuration.proxyServer }
            : {})
        })
      };
    }
    throw Object.assign(
      new Error("The System WebView compatibility adapter is unavailable."),
      { code: "SYSTEM_RUNTIME_UNAVAILABLE" }
    );
  };
}
