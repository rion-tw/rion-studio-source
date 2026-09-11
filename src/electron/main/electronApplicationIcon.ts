import { existsSync } from "node:fs";
import { join, posix, resolve, win32 } from "node:path";

import type { NativeImage } from "electron";

import { RionBridgeError } from "../ipc/errors";

export type ElectronApplicationIconPlatform = "darwin" | "win32";

interface ElectronApplicationIconPathInput {
  readonly appPath: string;
  readonly isPackaged: boolean;
  readonly platform: ElectronApplicationIconPlatform;
  readonly resourcesPath: string;
}

interface ElectronNativeImagePort {
  createFromPath: (path: string) => NativeImage;
}

interface ElectronApplicationIdentityPort {
  readonly dock?: Readonly<{
    setIcon: (image: NativeImage) => void;
  }>;
  setAppUserModelId?: (id: string) => void;
}

interface ElectronApplicationIconRuntimePort
extends ElectronApplicationIdentityPort {
  readonly isPackaged: boolean;
  getAppPath: () => string;
}

export const RION_APPLICATION_ID = "com.rionstudio.launcher";

export function resolveElectronApplicationIconPath(
  input: ElectronApplicationIconPathInput
): string {
  const pathApi = input.platform === "darwin" ? posix : win32;
  const fileName = input.platform === "darwin"
    ? "rion-studio.png"
    : "rion-studio.ico";
  const path = input.isPackaged
    ? pathApi.join(input.resourcesPath, "icons", fileName)
    : pathApi.join(
        input.appPath,
        "build",
        input.platform === "darwin" ? "icon.png" : "icon.ico"
      );
  if (!pathApi.isAbsolute(path) || pathApi.normalize(path) !== path ||
      path.includes("\0")) {
    throw new RionBridgeError({
      code: "ELECTRON_APPLICATION_ICON_PATH_INVALID",
      message: "Rion Studio could not resolve a canonical application icon path."
    });
  }
  return path;
}

export function loadElectronApplicationIcon(
  nativeImage: ElectronNativeImagePort,
  path: string
): NativeImage {
  const image = nativeImage.createFromPath(path);
  if (image.isEmpty()) {
    throw new RionBridgeError({
      code: "ELECTRON_APPLICATION_ICON_INVALID",
      message: `Rion Studio could not load its application icon from ${path}.`
    });
  }
  return image;
}

export function applyElectronApplicationIdentity(
  app: ElectronApplicationIdentityPort,
  platform: ElectronApplicationIconPlatform,
  image: NativeImage
): void {
  if (platform === "darwin") {
    if (!app.dock) {
      throw new RionBridgeError({
        code: "ELECTRON_DOCK_UNAVAILABLE",
        message: "Electron did not expose the macOS Dock application boundary."
      });
    }
    app.dock.setIcon(image);
    return;
  }
  app.setAppUserModelId?.(RION_APPLICATION_ID);
}

export function initializeElectronApplicationIcon(
  app: ElectronApplicationIconRuntimePort,
  nativeImage: ElectronNativeImagePort,
  platform: ElectronApplicationIconPlatform,
  resourcesPath: string
): Readonly<{ image: NativeImage; path: string }> {
  const appPath = app.getAppPath();
  const developmentAppPath = app.isPackaged || existsSync(join(appPath, "build"))
    ? appPath
    : resolve(import.meta.dirname, "../..");
  const path = resolveElectronApplicationIconPath({
    appPath: developmentAppPath,
    isPackaged: app.isPackaged,
    platform,
    resourcesPath
  });
  const image = loadElectronApplicationIcon(nativeImage, path);
  applyElectronApplicationIdentity(app, platform, image);
  return Object.freeze({ image, path });
}
