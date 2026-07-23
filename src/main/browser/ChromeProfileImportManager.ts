import type {
  ChromeProfileImportInput,
  ChromeProfileImportProgress,
  ChromeProfileImportPreview,
  ChromeProfileImportResult
} from "../../shared/types";
import type { CoreEvent } from "../../shared/generated";
import type { AppCoreClient } from "../core/nativeCore";

interface OpenDirectoryDialogOptions {
  properties: Array<"openDirectory">;
  title: string;
  defaultPath?: string;
}

interface OpenDirectoryDialogResult {
  canceled: boolean;
  filePaths: string[];
}

export interface ChromeProfileImportManagerOptions {
  closeChrome?: () => Promise<void>;
  core: Pick<AppCoreClient, "invoke" | "subscribe">;
  showOpenDialog: (options: OpenDirectoryDialogOptions) => Promise<OpenDirectoryDialogResult>;
}

export class ChromeProfileImportError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ChromeProfileImportError";
  }
}

/**
 * Electron effect adapter for Chrome profile imports. Rust owns discovery,
 * pending previews, safe-copy, the file journal, role transactions, rollback,
 * and startup recovery. This class only coordinates UI-visible effects.
 */
export class ChromeProfileImportManager {
  private progressListener?: {
    importId: string;
    listener: (progress: ChromeProfileImportProgress) => void;
  };

  constructor(private readonly options: ChromeProfileImportManagerOptions) {
    options.core.subscribe((events) => this.handleCoreEvents(events));
  }

  async closeChrome(): Promise<void> {
    if (!this.options.closeChrome) {
      throw new ChromeProfileImportError(
        "CHROME_CLOSE_UNAVAILABLE",
        "Chrome profile import is not available."
      );
    }
    try {
      await this.options.closeChrome();
    } catch (error) {
      if (error instanceof ChromeProfileImportError) throw error;
      throw new ChromeProfileImportError(
        "CHROME_CLOSE_FAILED",
        "Unable to ask Google Chrome to close. Close Chrome manually and try again."
      );
    }
  }

  async previewImport(): Promise<ChromeProfileImportPreview | null> {
    const { path: defaultPath } = await this.options.core.invoke<{ path?: string }>({
      type: "chromeProfileDefaultPath"
    });
    const result = await this.options.showOpenDialog({
      ...(defaultPath ? { defaultPath } : {}),
      properties: ["openDirectory"],
      title: "Choose Chrome User Data folder"
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return this.options.core.invoke<ChromeProfileImportPreview>({
      type: "chromeProfilePreview",
      sourceUserDataDir: result.filePaths[0]
    });
  }

  async applyImport(
    input: ChromeProfileImportInput,
    onProgress?: (progress: ChromeProfileImportProgress) => void
  ): Promise<ChromeProfileImportResult> {
    this.progressListener = onProgress
      ? { importId: input.importId, listener: onProgress }
      : undefined;
    try {
      return await this.options.core.invoke<ChromeProfileImportResult>({
        type: "chromeProfileApply",
        ...input
      });
    } finally {
      if (this.progressListener?.importId === input.importId) {
        this.progressListener = undefined;
      }
    }
  }

  async discardImport(importId: string): Promise<void> {
    await this.options.core.invoke({ type: "chromeProfileDiscard", importId });
  }

  private handleCoreEvents(events: CoreEvent[]): void {
    for (const event of events) {
      if (event.type !== "chromeProfileImportProgress") continue;
      const listener = this.progressListener?.importId === event.progress.importId
        ? this.progressListener.listener
        : undefined;
      reportProgress(
        listener,
        event.progress
      );
    }
  }
}

function reportProgress(
  listener: ((progress: ChromeProfileImportProgress) => void) | undefined,
  progress: ChromeProfileImportProgress
): void {
  try {
    listener?.(progress);
  } catch {
    // Renderer progress reporting must never affect the Rust transaction.
  }
}
