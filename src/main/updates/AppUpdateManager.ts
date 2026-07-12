import { EventEmitter } from "node:events";

import electronUpdater, { type AppUpdater, type ProgressInfo, type UpdateInfo } from "electron-updater";

import type { AppUpdateStatus } from "../../shared/types";

interface ManualUpdateAsset {
  browserDownloadUrl: string;
  name: string;
  releasePageUrl?: string;
}

interface ManualUpdateAssetRequest {
  arch: string;
  productName: string;
  repository: string;
  tag: string;
  version: string;
}

interface AppUpdateManagerOptions {
  currentVersion: string;
  arch?: string;
  fetchManualUpdateAsset?: (request: ManualUpdateAssetRequest) => Promise<ManualUpdateAsset | null>;
  isPackaged: boolean;
  manualUpdateRepository?: string;
  openExternal?: (url: string) => Promise<void> | void;
  platform?: NodeJS.Platform;
  productName?: string;
  updater?: AppUpdater;
}

export class AppUpdateManager extends EventEmitter {
  private readonly arch: string;
  private readonly fetchManualUpdateAsset?: (request: ManualUpdateAssetRequest) => Promise<ManualUpdateAsset | null>;
  private readonly installMode: AppUpdateStatus["installMode"];
  private readonly manualUpdateRepository?: string;
  private readonly openExternal: (url: string) => Promise<void> | void;
  private readonly productName: string;
  private readonly updater: AppUpdater;
  private status: AppUpdateStatus;

  constructor({
    arch = process.arch,
    currentVersion,
    fetchManualUpdateAsset,
    isPackaged,
    manualUpdateRepository,
    openExternal = unavailableOpenExternal,
    platform = process.platform,
    productName = "Rion Studio",
    updater = electronUpdater.autoUpdater
  }: AppUpdateManagerOptions) {
    super();
    this.arch = arch;
    this.installMode = platform === "darwin" ? "manual" : "automatic";
    this.manualUpdateRepository = normalizeRepository(manualUpdateRepository);
    this.fetchManualUpdateAsset =
      fetchManualUpdateAsset ?? (this.manualUpdateRepository ? fetchGitHubManualUpdateAsset : undefined);
    this.openExternal = openExternal;
    this.productName = productName;
    this.updater = updater;
    this.status = {
      currentVersion,
      installMode: this.installMode,
      isPackaged,
      state: isPackaged ? "idle" : "unsupported"
    };

    this.updater.autoDownload = this.installMode === "automatic";
    this.updater.autoInstallOnAppQuit = this.installMode === "automatic";
    this.registerUpdaterEvents();
  }

  getStatus(): AppUpdateStatus {
    return { ...this.status };
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
      const result = await this.updater.checkForUpdates();

      if (this.installMode === "manual" && result?.updateInfo && this.status.state === "available") {
        await this.loadManualUpdateAsset(result.updateInfo);
      }
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

  private async loadManualUpdateAsset(info: UpdateInfo): Promise<void> {
    const repository = this.manualUpdateRepository;
    const tag = readReleaseTag(info);

    if (!repository || !tag || !this.fetchManualUpdateAsset) {
      return;
    }

    try {
      const asset = await this.fetchManualUpdateAsset({
        arch: this.arch,
        productName: this.productName,
        repository,
        tag,
        version: info.version
      });

      if (!asset || this.status.state !== "available" || this.status.availableVersion !== info.version) {
        return;
      }

      this.setStatus({
        downloadUrl: asset.browserDownloadUrl,
        installerName: asset.name,
        releasePageUrl: asset.releasePageUrl ?? this.status.releasePageUrl
      });
    } catch {
      // Keep the release page fallback from update-available when the asset lookup fails.
    }
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
  const downloadUrl = findMacDownloadUrl(info, options.arch);

  return {
    downloadUrl,
    installerName: readInstallerName(downloadUrl) ?? `${options.productName}-${info.version}-mac-${options.arch}.zip`,
    releasePageUrl
  };
}

function readReleaseTag(info: UpdateInfo): string | undefined {
  const value = (info as UpdateInfo & { tag?: unknown }).tag;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function findMacDownloadUrl(info: UpdateInfo, arch: string): string | undefined {
  const files = (info.files ?? [])
    .map((file) => toHttpUrl(file.url))
    .filter((url): url is string => typeof url === "string" && isMacDownloadAssetName(url));

  return preferCurrentArch(files, arch) ?? files[0];
}

function preferCurrentArch(urls: string[], arch: string): string | undefined {
  const matchingArch = urls.find((url) => fileNameMatchesArch(url, arch));

  if (matchingArch) {
    return matchingArch;
  }

  const compatible = urls.find((url) => !fileNameMatchesOtherArch(url, arch));
  return compatible ?? urls[0];
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

async function fetchGitHubManualUpdateAsset(request: ManualUpdateAssetRequest): Promise<ManualUpdateAsset | null> {
  const [owner, repo] = request.repository.split("/");
  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/tags/${encodeURIComponent(request.tag)}`,
    {
      headers: {
        Accept: "application/vnd.github+json"
      }
    }
  );

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as {
    assets?: unknown;
    html_url?: unknown;
  };
  const asset = selectGitHubMacAsset(payload.assets, request);

  if (!asset) {
    return null;
  }

  return {
    browserDownloadUrl: asset.browserDownloadUrl,
    name: asset.name,
    releasePageUrl: typeof payload.html_url === "string" ? payload.html_url : undefined
  };
}

function selectGitHubMacAsset(
  assets: unknown,
  request: Pick<ManualUpdateAssetRequest, "arch" | "productName">
): ManualUpdateAsset | null {
  if (!Array.isArray(assets)) {
    return null;
  }

  const macAssets = assets
    .map((asset) => readGitHubAsset(asset))
    .filter((asset): asset is ManualUpdateAsset => asset !== null && isMacDownloadAssetName(asset.name));

  if (macAssets.length === 0) {
    return null;
  }

  const productAssets = macAssets.filter((asset) => fileNameMatchesProductName(asset.name, request.productName));
  const candidates = productAssets.length > 0 ? productAssets : macAssets;

  return (
    candidates.find((asset) => fileNameMatchesArch(asset.name, request.arch)) ??
    candidates.find((asset) => !fileNameMatchesOtherArch(asset.name, request.arch)) ??
    candidates[0]
  );
}

function isMacDownloadAssetName(name: string): boolean {
  const lowerName = name.toLowerCase();
  return lowerName.endsWith(".zip") || lowerName.endsWith(".dmg");
}

function fileNameMatchesProductName(fileName: string, productName: string): boolean {
  return normalizeAssetName(fileName).includes(normalizeAssetName(productName));
}

function normalizeAssetName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function readGitHubAsset(asset: unknown): ManualUpdateAsset | null {
  if (!asset || typeof asset !== "object") {
    return null;
  }

  const { browser_download_url: browserDownloadUrl, name } = asset as {
    browser_download_url?: unknown;
    name?: unknown;
  };

  if (typeof browserDownloadUrl !== "string" || typeof name !== "string") {
    return null;
  }

  return {
    browserDownloadUrl,
    name
  };
}
