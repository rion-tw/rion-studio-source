import type {
  ChromeProfileImportInput,
  ChromeProfileImportProgress,
  ChromeProfileImportPreview,
  ChromeProfileImportResult,
  Role
} from "../../shared/types";
import type {
  ChromeProfileImportCommitRecord,
  ChromeProfileImportPrepareRecord
} from "../../shared/generated";
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
  core: Pick<AppCoreClient, "invoke">;
  prepareImportedSession?: (role: Role, browserUserDataDir: string) => Promise<void>;
  showOpenDialog: (options: OpenDirectoryDialogOptions) => Promise<OpenDirectoryDialogResult>;
  stopRoles?: (roleIds: string[]) => Promise<void>;
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
  constructor(private readonly options: ChromeProfileImportManagerOptions) {}

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
    const prepared = await this.options.core.invoke<ChromeProfileImportPrepareRecord>({
      type: "chromeProfilePrepare",
      importId: input.importId,
      profileIds: input.profileIds,
      gameId: input.gameId,
      consentAccepted: input.consentAccepted
    });
    let completedProfileCount = 0;
    reportProgress(onProgress, {
      completedProfileCount,
      importId: input.importId,
      phase: "preparing",
      totalProfileCount: prepared.profiles.length
    });
    await this.options.stopRoles?.(prepared.overwrittenRoleIds);

    let committed = false;
    try {
      const result = await this.options.core.invoke<ChromeProfileImportCommitRecord>({
        type: "chromeProfileCommit",
        importId: input.importId
      });
      committed = true;
      for (const session of result.sessions) {
        await this.options.prepareImportedSession?.(
          session.role as Role,
          session.browserUserDataDir
        );
        completedProfileCount += 1;
        reportProgress(onProgress, {
          completedProfileCount,
          currentProfileId: session.profileId,
          currentProfileName: session.profileName,
          importId: input.importId,
          phase: "importing",
          totalProfileCount: prepared.profiles.length
        });
      }
      await this.options.core.invoke({
        type: "chromeProfileFinalize",
        importId: input.importId
      });
      reportProgress(onProgress, {
        completedProfileCount,
        importId: input.importId,
        phase: "completed",
        totalProfileCount: prepared.profiles.length
      });
      return { roles: result.roles as Role[] };
    } catch (error) {
      if (committed) {
        try {
          await this.options.core.invoke({
            type: "chromeProfileRollback",
            importId: input.importId
          });
        } catch {
          // Rust retains its durable journal so startup recovery can retry.
        }
      }
      throw error;
    }
  }

  async discardImport(importId: string): Promise<void> {
    await this.options.core.invoke({ type: "chromeProfileDiscard", importId });
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
