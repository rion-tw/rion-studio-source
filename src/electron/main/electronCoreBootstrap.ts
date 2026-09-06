import { createRequire } from "node:module";
import { join } from "node:path";

import {
  CoreAddonClient,
  type CoreAddonClientObserver,
  type RawNodeApiCoreFactory
} from "../core/coreAddonClient";
import type {
  RawWindowsChromiumTrustedInputAddon
} from "./windowsChromiumInputSurfaceAttachmentCoordinator";
import type {
  WindowsRuntimeForegroundProbePort,
  WindowsRuntimeShortcutOwnerDiagnosticPort,
  WindowsRuntimeShortcutOwnerPort
} from "./chromiumRuntimeHostFactory";
import { withElectronChromiumRuntimeContract } from "./chromiumRuntimeBootstrap";
import type { RawAppKitRuntimeAddon } from "./macosAppKitRuntimeHostFactory";
import type { RawChromiumUpdaterFactory } from "./electronChromiumUpdater";

interface NativeAppCoreOptions {
  userDataDir: string;
  platform: "darwin" | "win32";
  appVersion: string;
  buildCommit?: string;
  packaged?: boolean;
  runtimeContractVersion?: number;
  startupBackupLabel?: string;
}

export interface LoadedRionNodeAddon
  extends RawNodeApiCoreFactory<NativeAppCoreOptions>, RawAppKitRuntimeAddon,
    RawChromiumUpdaterFactory, RawWindowsChromiumTrustedInputAddon,
    WindowsRuntimeForegroundProbePort, WindowsRuntimeShortcutOwnerPort,
    WindowsRuntimeShortcutOwnerDiagnosticPort {}

interface ElectronCoreBootstrapOptions {
  readonly appVersion: string;
  readonly packaged: boolean;
  readonly platform: "darwin" | "win32";
  readonly resourcesPath: string;
  readonly userDataDir: string;
  readonly onEventBridgeError: NonNullable<
    CoreAddonClientObserver["onEventBridgeError"]
  >;
}

const requireNativeModule = createRequire(import.meta.url);

export function loadElectronNativeAddon(
  packaged: boolean,
  resourcesPath: string
): LoadedRionNodeAddon {
  const path = packaged
    ? join(resourcesPath, "native/rion-core.node")
    : join(
        import.meta.dirname,
        `../../build/native/${process.platform}-${process.arch}/rion-core.node`
      );
  return requireNativeModule(path) as LoadedRionNodeAddon;
}

export async function createElectronCore(
  options: ElectronCoreBootstrapOptions
): Promise<{ addon: LoadedRionNodeAddon; core: CoreAddonClient }> {
  const addon = loadElectronNativeAddon(options.packaged, options.resourcesPath);
  const core = await CoreAddonClient.create(addon, withElectronChromiumRuntimeContract({
    userDataDir: options.userDataDir,
    platform: options.platform,
    appVersion: options.appVersion,
    packaged: options.packaged,
    startupBackupLabel: "electron-chromium-foundation"
  }), {
    onEventBridgeError: options.onEventBridgeError
  }, options.packaged
    ? {}
    : { helperApplicationPath: join(import.meta.dirname, "index.js") });
  return { addon, core };
}
