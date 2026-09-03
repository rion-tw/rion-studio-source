import { release as operatingSystemRelease } from "node:os";

import { app, dialog, type BrowserWindow } from "electron";

import type { DisplayTopologySnapshotRecord } from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";
import {
  ElectronDiagnosticsExport,
  type ElectronDiagnosticsCorePort
} from "./electronDiagnosticsExport";
import {
  ElectronRuntimeDiagnosticsCollector,
  type ElectronRuntimeDiagnosticsCollectorInput
} from "./electronRuntimeDiagnosticsCollector";
import type { RendererIdentity } from "./rendererIdentity";

export interface ElectronDiagnosticsCompositionInput {
  readonly applicationName: string;
  readonly applicationLifecycle:
    ElectronRuntimeDiagnosticsCollectorInput["applicationLifecycle"];
  readonly captureDisplayTopology: () => DisplayTopologySnapshotRecord;
  readonly core: ElectronDiagnosticsCorePort;
  readonly projectCoherentSnapshot:
    ElectronRuntimeDiagnosticsCollectorInput["projectCoherentSnapshot"];
  readonly readCoreSnapshot:
    ElectronRuntimeDiagnosticsCollectorInput["readCoreSnapshot"];
  readonly readNativeSnapshot:
    ElectronRuntimeDiagnosticsCollectorInput["readNativeSnapshot"];
  readonly registration: ElectronRuntimeDiagnosticsCollectorInput["registration"];
  readonly resolveMainWindow: (identity: RendererIdentity) => BrowserWindow;
}

/**
 * Owns the Electron-native diagnostics adapters while Core remains responsible
 * for producing the archive and committing its terminal export result.
 */
export function createElectronDiagnosticsComposition(
  input: ElectronDiagnosticsCompositionInput
): ElectronDiagnosticsExport<BrowserWindow> {
  const runtimeDiagnostics = new ElectronRuntimeDiagnosticsCollector({
    applicationLifecycle: input.applicationLifecycle,
    projectCoherentSnapshot: input.projectCoherentSnapshot,
    readCoreSnapshot: input.readCoreSnapshot,
    readNativeSnapshot: input.readNativeSnapshot,
    registration: input.registration
  });

  return new ElectronDiagnosticsExport({
    core: input.core,
    resolveMainWindow: input.resolveMainWindow,
    showNativeSaveDialog: async (window, saveInput) => {
      const result = await dialog.showSaveDialog(window, {
        title: saveInput.title,
        defaultPath: saveInput.defaultName,
        filters: [{ name: "ZIP archive", extensions: [saveInput.extension] }]
      });
      if (result.canceled) return null;
      if (!result.filePath) {
        throw new RionBridgeError({
          code: "ELECTRON_DIALOG_RESULT_INVALID",
          message: "The diagnostics save dialog returned an invalid selection."
        });
      }
      return result.filePath;
    },
    captureApplication: () => ({
      applicationName: input.applicationName,
      applicationVersion: app.getVersion(),
      packaged: app.isPackaged,
      locale: app.getLocale(),
      systemVersion: operatingSystemRelease()
    }),
    captureRuntimeVersions: () => ({
      chromiumVersion: process.versions.chrome,
      electronVersion: process.versions.electron
    }),
    captureDisplayTopology: input.captureDisplayTopology,
    captureGpuFeatureStatus: () => app.getGPUFeatureStatus(),
    captureGpuInfo: () => app.getGPUInfo("complete"),
    captureNativeRuntime: () => runtimeDiagnostics.capture()
  });
}
