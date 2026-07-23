import type { AppCoreClient } from "../core/nativeCore";
import type {
  PortableDataSelection,
  PortableExportInput,
  PortableExportResult,
  PortableImportInput,
  PortableImportPreview,
  PortableImportResult
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
  showOpenDialog: (options: PortableOpenDialogOptions) => Promise<PortableOpenDialogResult>;
  showSaveDialog: (options: PortableSaveDialogOptions) => Promise<PortableSaveDialogResult>;
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

  constructor(private readonly options: PortableDataManagerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async exportData(input: PortableExportInput = {}): Promise<PortableExportResult | null> {
    const selection = input.selection ?? ALL_PORTABLE_DATA;
    const dialogResult = await this.options.showSaveDialog({
      defaultPath: `rion-studio-${formatDate(this.now())}.json`,
      filters: [{ name: "Rion Studio JSON", extensions: ["json"] }],
      title: "Export Rion Studio JSON"
    });
    if (dialogResult.canceled || !dialogResult.filePath) return null;

    return this.options.core.invoke<PortableExportResult>({
      type: "portableExportTo",
      path: dialogResult.filePath,
      ...(input.preferences ? { preferences: input.preferences } : {}),
      selection
    });
  }

  async previewImport(): Promise<PortableImportPreview | null> {
    const dialogResult = await this.options.showOpenDialog({
      filters: [{ name: "Rion Studio JSON", extensions: ["json"] }],
      properties: ["openFile"],
      title: "Import Rion Studio JSON"
    });
    if (dialogResult.canceled || dialogResult.filePaths.length === 0) return null;

    const filePath = dialogResult.filePaths[0];
    return this.options.core.invoke<PortableImportPreview>({
      type: "portablePreviewFile",
      path: filePath
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

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}
