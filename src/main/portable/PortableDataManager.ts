import { readFile, writeFile } from "node:fs/promises";

import type { AppCoreClient } from "../core/nativeCore";
import type {
  PortableDataSelection,
  PortableExportInput,
  PortableExportResult,
  PortableImportInput,
  PortableImportPreview,
  PortableImportResult,
  RionPortableDataV6
} from "../../shared/types";

interface PortableSaveDialogOptions {
  defaultPath: string;
  filters: Array<{ extensions: string[]; name: string }>;
  title: string;
}

interface PortableOpenDialogOptions {
  filters: Array<{ extensions: string[]; name: string }>;
  properties: Array<"openFile">;
  title: string;
}

interface PortableSaveDialogResult {
  canceled: boolean;
  filePath?: string;
}

interface PortableOpenDialogResult {
  canceled: boolean;
  filePaths: string[];
}

export interface PortableDataManagerOptions {
  core: Pick<AppCoreClient, "invoke">;
  now?: () => Date;
  readTextFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
  showOpenDialog: (options: PortableOpenDialogOptions) => Promise<PortableOpenDialogResult>;
  showSaveDialog: (options: PortableSaveDialogOptions) => Promise<PortableSaveDialogResult>;
  writeTextFile?: (path: string, data: string, encoding: BufferEncoding) => Promise<void>;
}

const ALL_PORTABLE_DATA: PortableDataSelection = {
  games: true,
  roles: true,
  launchWorkspaces: true,
  macros: true,
  preferences: true
};

/**
 * Electron-only portable adapter. Parsing, normalization, planning, pending
 * sessions, conflict handling, and the SQLite transaction are owned by Rust.
 */
export class PortableDataManager {
  private readonly now: () => Date;
  private readonly readTextFile: (path: string, encoding: BufferEncoding) => Promise<string>;
  private readonly writeTextFile: (path: string, data: string, encoding: BufferEncoding) => Promise<void>;

  constructor(private readonly options: PortableDataManagerOptions) {
    this.now = options.now ?? (() => new Date());
    this.readTextFile = options.readTextFile ?? readFile;
    this.writeTextFile = options.writeTextFile ?? writeFile;
  }

  async exportData(input: PortableExportInput = {}): Promise<PortableExportResult | null> {
    const selection = input.selection ?? ALL_PORTABLE_DATA;
    const data = await this.options.core.invoke<RionPortableDataV6>({
      type: "portableExport",
      ...(input.preferences ? { preferences: input.preferences } : {}),
      selection
    });
    const dialogResult = await this.options.showSaveDialog({
      defaultPath: `rion-studio-${formatDate(this.now())}.json`,
      filters: [{ name: "Rion Studio JSON", extensions: ["json"] }],
      title: "Export Rion Studio JSON"
    });
    if (dialogResult.canceled || !dialogResult.filePath) return null;

    await this.writeTextFile(dialogResult.filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    return {
      filePath: dialogResult.filePath,
      gameCount: data.games.length,
      roleCount: data.roles.length,
      workspaceCount: data.launchWorkspaces.length,
      macroCount: data.macros.length,
      preferencesIncluded: Boolean(data.preferences),
      selection: effectiveSelection(data)
    };
  }

  async previewImport(): Promise<PortableImportPreview | null> {
    const dialogResult = await this.options.showOpenDialog({
      filters: [{ name: "Rion Studio JSON", extensions: ["json"] }],
      properties: ["openFile"],
      title: "Import Rion Studio JSON"
    });
    if (dialogResult.canceled || dialogResult.filePaths.length === 0) return null;

    const filePath = dialogResult.filePaths[0];
    const rawJson = await this.readTextFile(filePath, "utf8");
    return this.options.core.invoke<PortableImportPreview>({
      type: "portablePreview",
      rawJson,
      filePath
    });
  }

  applyImport(input: PortableImportInput): Promise<PortableImportResult> {
    return this.options.core.invoke<PortableImportResult>({
      type: "portableApply",
      importId: input.importId,
      selection: input.selection,
      resolutions: input.resolutions ?? []
    });
  }

  async discardImport(importId: string): Promise<void> {
    await this.options.core.invoke({ type: "portableDiscard", importId });
  }
}

function effectiveSelection(data: RionPortableDataV6): PortableDataSelection {
  return {
    games: data.games.length > 0,
    roles: data.roles.length > 0,
    launchWorkspaces: data.launchWorkspaces.length > 0,
    macros: data.macros.length > 0,
    preferences: Boolean(data.preferences)
  };
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}
