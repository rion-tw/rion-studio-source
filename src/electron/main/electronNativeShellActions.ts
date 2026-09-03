import { isAbsolute } from "node:path";

import type {
  ChromeProfileImportPreview,
  LogStorageStatus,
  PortableExportInput,
  PortableExportResult,
  PortableImportPreview
} from "../../shared/types";
import type { CoreCommand, CoreCommandResult } from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";

const DEFAULT_PORTABLE_SELECTION = Object.freeze({
  games: true,
  roles: true,
  launchWorkspaces: true,
  gameWindows: true,
  macros: true,
  preferences: true
});

export interface ElectronNativeShellCorePort {
  invoke: <Command extends CoreCommand>(
    command: Command
  ) => Promise<CoreCommandResult<Command>>;
}

export interface ElectronNativeShellActionsInput {
  readonly core: ElectronNativeShellCorePort;
  readonly chooseDirectory: (input: Readonly<{
    title: string;
    defaultPath?: string;
  }>) => Promise<string | null>;
  readonly chooseFile: (input: Readonly<{
    title: string;
    extension: string;
  }>) => Promise<string | null>;
  readonly saveFile: (input: Readonly<{
    title: string;
    defaultName: string;
    extension: string;
  }>) => Promise<string | null>;
  readonly openPath: (path: string) => Promise<string>;
  readonly openExternal: (url: string) => Promise<void>;
}

function shellError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function requireAbsolutePath(path: string, field: string): string {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.trim() !== path ||
    path.includes("\0") ||
    !isAbsolute(path)
  ) {
    throw shellError(
      "ELECTRON_NATIVE_PATH_INVALID",
      `The ${field} path is not an absolute native path.`
    );
  }
  return path;
}

export class ElectronNativeShellActions {
  readonly #input: ElectronNativeShellActionsInput;

  constructor(input: ElectronNativeShellActionsInput) {
    this.#input = input;
  }

  async exportPortableData(
    input?: PortableExportInput
  ): Promise<PortableExportResult | null> {
    const path = await this.#input.saveFile({
      title: "Export Rion Studio JSON",
      defaultName: "rion-studio-export.json",
      extension: "json"
    });
    if (path === null) return null;
    return this.#input.core.invoke({
      type: "portableExportTo",
      path: requireAbsolutePath(path, "portable export"),
      selection: input?.selection ?? DEFAULT_PORTABLE_SELECTION,
      ...(input?.preferences === undefined
        ? {}
        : { preferences: input.preferences })
    });
  }

  async previewPortableImport(): Promise<PortableImportPreview | null> {
    const path = await this.#input.chooseFile({
      title: "Import Rion Studio JSON",
      extension: "json"
    });
    if (path === null) return null;
    return this.#input.core.invoke({
      type: "portablePreviewFile",
      path: requireAbsolutePath(path, "portable import")
    });
  }

  async previewChromeProfileImport(): Promise<ChromeProfileImportPreview | null> {
    const defaultPath = await this.#input.core.invoke({
      type: "chromeProfileDefaultPath"
    });
    const path = await this.#input.chooseDirectory({
      title: "Choose Chrome User Data",
      ...(defaultPath === null
        ? {}
        : { defaultPath: requireAbsolutePath(defaultPath, "default Chrome profile") })
    });
    if (path === null) return null;
    return this.#input.core.invoke({
      type: "chromeProfilePreview",
      sourceUserDataDir: requireAbsolutePath(path, "Chrome profile")
    });
  }

  async revealLogs(): Promise<void> {
    const status: LogStorageStatus = await this.#input.core.invoke({
      type: "logsStatus"
    });
    const path = requireAbsolutePath(status.directory, "log directory");
    const error = await this.#input.openPath(path);
    if (error.length !== 0) {
      throw shellError(
        "ELECTRON_REVEAL_LOGS_FAILED",
        "The operating system could not reveal the log directory."
      );
    }
  }

  async openUpdateDownload(): Promise<void> {
    await this.#input.openExternal(
      "https://github.com/rion-tw/rion-studio/releases/latest"
    );
  }
}
