import { isAbsolute } from "node:path";

import type {
  ApplicationDiagnosticsSnapshotRecord,
  CoreCommand,
  CoreCommandResult,
  DiagnosticDisplayRecord,
  DiagnosticExportResultRecord,
  DisplayTopologySnapshotRecord,
  SystemRuntimeDiagnosticsRecord
} from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";
import type { RendererIdentity } from "./rendererIdentity";

type MaybePromise<Value> = Value | Promise<Value>;

export interface ElectronDiagnosticsMainWindowPort {
  readonly id: number;
  readonly webContents: Readonly<{
    id: number;
    isDestroyed: () => boolean;
  }>;
  isDestroyed: () => boolean;
}

export interface ElectronDiagnosticsCorePort {
  invoke: <Command extends CoreCommand>(
    command: Command
  ) => Promise<CoreCommandResult<Command>>;
}

export interface ElectronDiagnosticsApplicationSnapshot {
  readonly applicationName: string;
  readonly applicationVersion: string;
  readonly buildCommit?: string;
  readonly packaged: boolean;
  readonly locale: string;
  readonly systemVersion: string;
}

export interface ElectronDiagnosticsRuntimeVersions {
  readonly chromiumVersion: string;
  readonly electronVersion: string;
}

export interface ElectronDiagnosticsSaveDialogInput {
  readonly title: string;
  readonly defaultName: string;
  readonly extension: string;
}

export interface ElectronDiagnosticsExportInput<
  Window extends ElectronDiagnosticsMainWindowPort = ElectronDiagnosticsMainWindowPort
> {
  readonly core: ElectronDiagnosticsCorePort;
  /** Must resolve through RendererIdentityRegistry/currentWindow. */
  readonly resolveMainWindow: (identity: RendererIdentity) => Window;
  readonly showNativeSaveDialog: (
    window: Window,
    input: ElectronDiagnosticsSaveDialogInput
  ) => Promise<string | null>;
  readonly captureApplication: () => ElectronDiagnosticsApplicationSnapshot;
  readonly captureRuntimeVersions: () => ElectronDiagnosticsRuntimeVersions;
  readonly captureDisplayTopology: () => DisplayTopologySnapshotRecord;
  readonly captureGpuFeatureStatus: () => unknown;
  readonly captureGpuInfo: () => Promise<unknown>;
  readonly captureNativeRuntime: () => MaybePromise<SystemRuntimeDiagnosticsRecord>;

}

function diagnosticsError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function requiredString(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    [...value].some((character) => character.codePointAt(0)! <= 0x1f)
  ) {
    throw diagnosticsError(
      "ELECTRON_DIAGNOSTICS_SNAPSHOT_INVALID",
      `The Electron diagnostics ${field} is invalid.`
    );
  }
  return value;
}

function optionalString(value: string | undefined, field: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, field);
}

function rawJson(value: unknown, field: string): string {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("not JSON serializable");
    return encoded;
  } catch {
    throw diagnosticsError(
      "ELECTRON_DIAGNOSTICS_GPU_SNAPSHOT_INVALID",
      `The Electron diagnostics ${field} is not JSON serializable.`
    );
  }
}

function selectedPath(path: string): string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path !== path.trim() ||
    path.includes("\0") ||
    !isAbsolute(path)
  ) {
    throw diagnosticsError(
      "ELECTRON_DIAGNOSTICS_PATH_INVALID",
      "The diagnostics export path is not an absolute native path."
    );
  }
  return path;
}

function diagnosticDisplays(
  topology: DisplayTopologySnapshotRecord
): DiagnosticDisplayRecord[] {
  if (!Array.isArray(topology.displays) || topology.displays.length === 0) {
    throw diagnosticsError(
      "ELECTRON_DIAGNOSTICS_DISPLAY_SNAPSHOT_INVALID",
      "The diagnostics display snapshot is empty."
    );
  }
  return topology.displays.map((display) => {
    const values = [
      display.bounds.x,
      display.bounds.y,
      display.bounds.width,
      display.bounds.height,
      display.resolution.width,
      display.resolution.height,
      display.scaleFactor
    ];
    if (
      values.some((value) => !Number.isFinite(value)) ||
      display.bounds.width <= 0 ||
      display.bounds.height <= 0 ||
      display.resolution.width <= 0 ||
      display.resolution.height <= 0 ||
      display.scaleFactor <= 0
    ) {
      throw diagnosticsError(
        "ELECTRON_DIAGNOSTICS_DISPLAY_SNAPSHOT_INVALID",
        "The diagnostics display snapshot contains invalid native geometry."
      );
    }
    return {
      bounds: { ...display.bounds },
      resolution: { ...display.resolution },
      scaleFactor: display.scaleFactor
    };
  });
}

export class ElectronDiagnosticsExport<
  Window extends ElectronDiagnosticsMainWindowPort = ElectronDiagnosticsMainWindowPort
> {
  readonly #input: ElectronDiagnosticsExportInput<Window>;

  constructor(input: ElectronDiagnosticsExportInput<Window>) {
    this.#input = input;
  }

  async export(
    identity: RendererIdentity
  ): Promise<DiagnosticExportResultRecord | null> {
    const window = this.#resolveExactMainWindow(identity);
    const path = await this.#input.showNativeSaveDialog(window, {
      title: "Export Rion Studio Diagnostics",
      defaultName: "Rion-Studio-Diagnostics.zip",
      extension: "zip"
    });
    if (path === null) return null;
    const exactPath = selectedPath(path);
    this.#resolveExactMainWindow(identity, window);

    const application = this.#input.captureApplication();
    const versions = this.#input.captureRuntimeVersions();
    const displays = diagnosticDisplays(this.#input.captureDisplayTopology());
    const gpuFeatureStatusRawJson = rawJson(
      this.#input.captureGpuFeatureStatus(),
      "GPU feature-status snapshot"
    );
    const [gpuInfo, nativeRuntime] = await Promise.all([
      this.#input.captureGpuInfo(),
      this.#input.captureNativeRuntime(),
    ]);
    this.#resolveExactMainWindow(identity, window);

    const snapshot: ApplicationDiagnosticsSnapshotRecord = {
      applicationName: requiredString(application.applicationName, "application name"),
      applicationVersion: requiredString(
        application.applicationVersion,
        "application version"
      ),
      ...(optionalString(application.buildCommit, "build commit") === undefined
        ? {}
        : { buildCommit: application.buildCommit }),
      packaged: application.packaged,
      engine: "chromium",
      engineVersion: requiredString(versions.chromiumVersion, "Chromium version"),
      shell: "electron",
      shellVersion: requiredString(versions.electronVersion, "Electron version"),
      locale: requiredString(application.locale, "locale"),
      systemVersion: requiredString(application.systemVersion, "system version"),
      displays,
      gpuFeatureStatusRawJson,
      gpuInfoRawJson: rawJson(gpuInfo, "GPU information snapshot"),
      nativeRuntime
    };
    return this.#input.core.invoke({
      type: "diagnosticsExport",
      path: exactPath,
      snapshot
    });
  }

  #resolveExactMainWindow(
    identity: RendererIdentity,
    expectedWindow?: Window
  ): Window {
    const window = this.#input.resolveMainWindow(identity);
    if (
      window.isDestroyed() ||
      window.webContents.isDestroyed() ||
      window.id !== identity.windowId ||
      window.webContents.id !== identity.webContentsId ||
      (expectedWindow !== undefined && window !== expectedWindow)
    ) {
      throw diagnosticsError(
        "ELECTRON_IPC_UNAUTHORIZED_SENDER",
        "The diagnostics request did not come from the exact active Rion Studio window."
      );
    }
    return window;
  }
}
