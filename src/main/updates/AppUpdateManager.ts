import { EventEmitter } from "node:events";

import electronUpdater, { type AppUpdater, type ProgressInfo, type UpdateInfo } from "electron-updater";

import type { AppUpdateStatus } from "../../shared/types";

export const DEFAULT_UPDATE_REPOSITORY = "rion-tw/rion-studio";
const MAC_UPDATE_INSTALLER_NAME = "Rion.Studio-mac.dmg";

interface AppUpdateManagerOptions {
  currentVersion: string;
  arch?: string;
  autoUpdateEnabled?: boolean;
  isPackaged: boolean;
  manualUpdateRepository?: string;
  openExternal?: (url: string) => Promise<void> | void;
  platform?: NodeJS.Platform;
  productName?: string;
  updater?: AppUpdater;
}

export class AppUpdateManager extends EventEmitter {
  private readonly arch: string;
  private readonly installMode: AppUpdateStatus["installMode"];
  private autoUpdateEnabled: boolean;
  private readonly manualUpdateRepository?: string;
  private readonly openExternal: (url: string) => Promise<void> | void;
  private readonly productName: string;
  private readonly updater: AppUpdater;
  private status: AppUpdateStatus;

  constructor({
    arch = process.arch,
    currentVersion,
    isPackaged,
    manualUpdateRepository,
    openExternal = unavailableOpenExternal,
    platform = process.platform,
    autoUpdateEnabled = true,
    productName = "Rion Studio",
    updater = electronUpdater.autoUpdater
  }: AppUpdateManagerOptions) {
    super();
    this.arch = arch;
    this.installMode = platform === "darwin" ? "manual" : "automatic";
    this.autoUpdateEnabled = autoUpdateEnabled;
    this.manualUpdateRepository = normalizeRepository(manualUpdateRepository);
    this.openExternal = openExternal;
    this.productName = productName;
    this.updater = updater;
    this.status = {
      currentVersion,
      installMode: this.installMode,
      isPackaged,
      autoUpdateEnabled: this.autoUpdateEnabled,
      state: isPackaged ? "idle" : "unsupported"
    };

    this.updater.autoDownload = this.installMode === "automatic";
    this.updater.autoInstallOnAppQuit = this.installMode === "automatic";
    this.registerUpdaterEvents();
  }

  getStatus(): AppUpdateStatus {
    return { ...this.status };
  }

  setAutoUpdateEnabled(enabled: boolean): AppUpdateStatus {
    this.autoUpdateEnabled = enabled === true;
    this.setStatus({ autoUpdateEnabled: this.autoUpdateEnabled });
    return this.getStatus();
  }

  async checkForUpdates(): Promise<AppUpdateStatus> {
    if (!this.status.isPackaged) {
      this.setStatus({
        state: "unsupported",
        availableVersion: undefined,
        downloadProgress: undefined,
        downloadUrl: undefined,
        error: undefined,
        installerName: undefined,
        releasePageUrl: undefined
      });
      return this.getStatus();
    }

    if (this.status.state === "checking" || this.status.state === "downloading") {
      return this.getStatus();
    }

    this.setStatus({
      state: "checking",
      availableVersion: undefined,
      downloadProgress: undefined,
      downloadUrl: undefined,
      error: undefined,
      checkedAt: new Date().toISOString(),
      installerName: undefined,
      releasePageUrl: undefined
    });

    try {
      await this.updater.checkForUpdates();
    } catch (error) {
      this.setStatus({
        state: "error",
        downloadProgress: undefined,
        downloadUrl: undefined,
        error: toErrorMessage(error),
        installerName: undefined,
        releasePageUrl: undefined
      });
    }

    return this.getStatus();
  }

  async openUpdateDownload(): Promise<void> {
    const downloadUrl = this.status.downloadUrl ?? this.status.releasePageUrl;

    if (!downloadUrl) {
      throw new Error("No update download is available.");
    }

    await this.openExternal(downloadUrl);
  }

  installDownloadedUpdate(): void {
    if (this.status.state !== "downloaded") {
      throw new Error("No downloaded update is ready to install.");
    }

    this.updater.quitAndInstall(false, true);
  }

  private registerUpdaterEvents(): void {
    this.updater.on("checking-for-update", () => {
      this.setStatus({
        state: "checking",
        downloadProgress: undefined,
        error: undefined,
        checkedAt: new Date().toISOString(),
        downloadUrl: undefined,
        installerName: undefined,
        releasePageUrl: undefined
      });
    });

    this.updater.on("update-available", (info: UpdateInfo) => {
      const manualUpdate = this.installMode === "manual" ? resolveManualUpdateDownload(info, {
        arch: this.arch,
        productName: this.productName,
        repository: this.manualUpdateRepository
      }) : {};

      this.setStatus({
        state: "available",
        availableVersion: info.version,
        downloadProgress: undefined,
        downloadUrl: manualUpdate.downloadUrl,
        error: undefined,
        installerName: manualUpdate.installerName,
        releasePageUrl: manualUpdate.releasePageUrl
      });
    });

    this.updater.on("update-not-available", () => {
      this.setStatus({
        state: "not_available",
        availableVersion: undefined,
        downloadProgress: undefined,
        downloadUrl: undefined,
        error: undefined,
        checkedAt: new Date().toISOString(),
        installerName: undefined,
        releasePageUrl: undefined
      });
    });

    this.updater.on("download-progress", (progress: ProgressInfo) => {
      this.setStatus({
        state: "downloading",
        downloadProgress: clampProgress(progress.percent),
        downloadUrl: undefined,
        error: undefined
      });
    });

    this.updater.on("update-downloaded", (info: UpdateInfo) => {
      this.setStatus({
        state: "downloaded",
        availableVersion: info.version,
        downloadProgress: 100,
        downloadUrl: undefined,
        error: undefined,
        installerName: undefined,
        releasePageUrl: undefined
      });
    });

    this.updater.on("error", (error: Error) => {
      this.setStatus({
        state: "error",
        error: toErrorMessage(error),
        downloadProgress: undefined,
        downloadUrl: undefined,
        installerName: undefined,
        releasePageUrl: undefined
      });
    });
  }

  private setStatus(nextStatus: Partial<AppUpdateStatus>): void {
    this.status = {
      ...this.status,
      ...nextStatus
    };
    this.emit("change", this.getStatus());
  }
}

function clampProgress(percent: number): number {
  if (!Number.isFinite(percent)) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round(percent)));
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unavailableOpenExternal(): never {
  throw new Error("External update downloads are not available.");
}

function normalizeRepository(repository: string | undefined): string | undefined {
  if (!repository) {
    return undefined;
  }

  const trimmed = repository.trim();
  return /^[^/\s]+\/[^/\s]+$/.test(trimmed) ? trimmed : undefined;
}

function resolveManualUpdateDownload(
  info: UpdateInfo,
  options: {
    arch: string;
    productName: string;
    repository?: string;
  }
): Pick<AppUpdateStatus, "downloadUrl" | "installerName" | "releasePageUrl"> {
  const tag = readReleaseTag(info) ?? `v${info.version}`;
  const releasePageUrl = options.repository
    ? `https://github.com/${options.repository}/releases/tag/${encodeURIComponent(tag)}`
    : undefined;
  const downloadUrl = options.repository
    ? createLatestReleaseAssetUrl(options.repository, MAC_UPDATE_INSTALLER_NAME)
    : findMacDownloadUrl(info, options.arch);

  return {
    downloadUrl,
    installerName: readInstallerName(downloadUrl) ?? `${options.productName}-${info.version}-mac-${options.arch}.dmg`,
    releasePageUrl
  };
}

function createLatestReleaseAssetUrl(repository: string, assetName: string): string {
  return `https://github.com/${repository}/releases/latest/download/${encodeURIComponent(assetName)}`;
}

function readReleaseTag(info: UpdateInfo): string | undefined {
  const value = (info as UpdateInfo & { tag?: unknown }).tag;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function findMacDownloadUrl(info: UpdateInfo, arch: string): string | undefined {
  const files = (info.files ?? [])
    .map((file) => toHttpUrl(file.url))
    .filter((url): url is string => typeof url === "string" && isMacDownloadAssetName(url));

  return preferMacInstaller(files, arch, (url) => readInstallerName(url) ?? url);
}

function preferMacInstaller<T>(items: T[], arch: string, readName: (item: T) => string): T | undefined {
  const matchingArch = items.filter((item) => fileNameMatchesArch(readName(item), arch));

  if (matchingArch.length > 0) {
    return preferDmg(matchingArch, readName);
  }

  const compatible = items.filter((item) => !fileNameMatchesOtherArch(readName(item), arch));
  return preferDmg(compatible, readName) ?? preferDmg(items, readName);
}

function preferDmg<T>(items: T[], readName: (item: T) => string): T | undefined {
  return items.find((item) => readName(item).toLowerCase().endsWith(".dmg")) ?? items[0];
}

function fileNameMatchesArch(url: string, arch: string): boolean {
  const fileName = readInstallerName(url)?.toLowerCase() ?? url.toLowerCase();
  return fileName.includes(arch.toLowerCase());
}

function fileNameMatchesOtherArch(url: string, arch: string): boolean {
  const fileName = readInstallerName(url)?.toLowerCase() ?? url.toLowerCase();

  if (arch === "arm64") {
    return fileName.includes("x64") || fileName.includes("x86_64") || fileName.includes("amd64");
  }

  if (arch === "x64") {
    return fileName.includes("arm64") || fileName.includes("aarch64");
  }

  return false;
}

function toHttpUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function readInstallerName(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }

  try {
    const pathname = new URL(url).pathname;
    const name = pathname.split("/").filter(Boolean).pop();
    return name ? decodeURIComponent(name) : undefined;
  } catch {
    return undefined;
  }
}

function isMacDownloadAssetName(name: string): boolean {
  const lowerName = name.toLowerCase();
  return lowerName.endsWith(".zip") || lowerName.endsWith(".dmg");
}
