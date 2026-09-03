import { isAbsolute, normalize, parse, resolve } from "node:path";

import type { BrowserWindowConstructorOptions } from "electron";

import type { EmbeddedLaunchTargetRecord } from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";

export type WindowsRuntimeHostMaterial = "mica" | "opaque";

function optionsError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

export function canonicalRuntimeHostPreloadPath(value: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value.includes("\0") ||
    !isAbsolute(value) || normalize(value) !== value ||
    parse(value).base !== "runtimeWindowsHost.cjs"
  ) {
    throw optionsError(
      "ELECTRON_RUNTIME_HOST_PRELOAD_INVALID",
      "A canonical packaged Windows runtime-host preload is required."
    );
  }
  return value;
}

function runtimeHostWebPreferences(preloadPath: string): NonNullable<
  BrowserWindowConstructorOptions["webPreferences"]
> {
  return Object.freeze({
    sandbox: true,
    preload: preloadPath,
    partition: "rion-runtime-shell",
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webviewTag: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    navigateOnDragDrop: false,
    safeDialogs: true,
    devTools: false,
    spellcheck: false,
    javascript: true
  });
}

export function buildWindowsRuntimeHostWindowOptions(
  target: EmbeddedLaunchTargetRecord,
  preloadPath = resolve("/rion-runtime-shell/runtimeWindowsHost.cjs"),
  material: WindowsRuntimeHostMaterial = "mica"
): BrowserWindowConstructorOptions {
  return {
    title: target.persistedName ?? "Rion Studio",
    x: target.bounds.x,
    y: target.bounds.y,
    width: target.bounds.width,
    height: target.bounds.height,
    minWidth: 640,
    minHeight: 480,
    useContentSize: true,
    show: false,
    focusable: true,
    frame: false,
    transparent: material === "mica",
    backgroundColor: material === "mica" ? "#00000000" : "#111318",
    backgroundMaterial: material === "mica" ? "mica" : "none",
    autoHideMenuBar: true,
    webPreferences: runtimeHostWebPreferences(
      canonicalRuntimeHostPreloadPath(preloadPath)
    )
  };
}
