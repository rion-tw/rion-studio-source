import { stat } from "node:fs/promises";
import { posix, win32 } from "node:path";

import type {
  WorkspaceCompanionApplicationTarget,
  WorkspaceCompanionOpenResult,
  WorkspaceCompanionTarget
} from "../../shared/types";

interface CompanionOpenDialogOptions {
  filters: Array<{ extensions: string[]; name: string }>;
  properties: Array<"openFile">;
  title: string;
}

interface CompanionOpenDialogResult {
  canceled: boolean;
  filePaths: string[];
}

interface FileStats {
  isDirectory: () => boolean;
  isFile: () => boolean;
}

export interface WorkspaceCompanionServiceOptions {
  openExternal: (url: string) => Promise<void>;
  openPath: (path: string) => Promise<string>;
  platform?: NodeJS.Platform;
  showOpenDialog: (options: CompanionOpenDialogOptions) => Promise<CompanionOpenDialogResult>;
  statPath?: (path: string) => Promise<FileStats>;
}

export class WorkspaceCompanionService {
  private readonly platform: NodeJS.Platform;
  private readonly statPath: (path: string) => Promise<FileStats>;

  constructor(private readonly options: WorkspaceCompanionServiceOptions) {
    this.platform = options.platform ?? process.platform;
    this.statPath = options.statPath ?? stat;
  }

  async pickApplication(): Promise<WorkspaceCompanionApplicationTarget | null> {
    const platform = this.getSupportedPlatform();
    const extensions = platform === "darwin" ? ["app"] : ["exe", "lnk"];
    const result = await this.options.showOpenDialog({
      filters: [{ name: "Applications", extensions }],
      properties: ["openFile"],
      title: "Choose Companion Application"
    });

    if (result.canceled || !result.filePaths[0]) {
      return null;
    }

    const path = result.filePaths[0];
    await this.assertSupportedApplicationPath(path, platform);
    const pathApi = platform === "darwin" ? posix : win32;
    const extension = pathApi.extname(path);
    return {
      kind: "application",
      label: pathApi.basename(path, extension),
      path,
      platform
    };
  }

  async open(target: WorkspaceCompanionTarget | undefined): Promise<WorkspaceCompanionOpenResult> {
    if (!target) {
      return failed(
        "not_configured",
        "Workspace companion shortcut is not configured."
      );
    }

    if (target.kind === "url") {
      try {
        await this.options.openExternal(target.url);
        return { kind: "opened" };
      } catch {
        return failed("open_failed", "Unable to open workspace companion shortcut.");
      }
    }

    if (target.platform !== this.platform) {
      return failed(
        "platform_mismatch",
        "This companion application is not available on this operating system."
      );
    }

    try {
      await this.assertSupportedApplicationPath(target.path, target.platform);
    } catch {
      return failed(
        "target_missing",
        "Workspace companion application could not be found."
      );
    }

    try {
      const errorMessage = await this.options.openPath(target.path);
      return errorMessage
        ? failed("open_failed", "Unable to open workspace companion shortcut.")
        : { kind: "opened" };
    } catch {
      return failed("open_failed", "Unable to open workspace companion shortcut.");
    }
  }

  private getSupportedPlatform(): WorkspaceCompanionApplicationTarget["platform"] {
    if (this.platform !== "darwin" && this.platform !== "win32") {
      throw new Error("Companion applications are only supported on macOS and Windows.");
    }
    return this.platform;
  }

  private async assertSupportedApplicationPath(
    path: string,
    platform: WorkspaceCompanionApplicationTarget["platform"]
  ): Promise<void> {
    const pathApi = platform === "darwin" ? posix : win32;
    if (!pathApi.isAbsolute(path)) {
      throw new Error("Companion application path must be absolute.");
    }

    const extension = pathApi.extname(path).toLocaleLowerCase();
    const stats = await this.statPath(path);
    if (platform === "darwin") {
      if (extension !== ".app" || !stats.isDirectory()) {
        throw new Error("Choose a macOS application bundle.");
      }
      return;
    }

    if ((extension !== ".exe" && extension !== ".lnk") || !stats.isFile()) {
      throw new Error("Choose a Windows application or shortcut.");
    }
  }
}

function failed(
  reason: Extract<WorkspaceCompanionOpenResult, { kind: "failed" }>["reason"],
  message: string
): WorkspaceCompanionOpenResult {
  return { kind: "failed", reason, message };
}
