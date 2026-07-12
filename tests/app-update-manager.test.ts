import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { AppUpdateManager } from "../src/main/updates/AppUpdateManager";

class FakeUpdater extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = true;
  checkForUpdates = vi.fn();
  quitAndInstall = vi.fn();
}

describe("AppUpdateManager", () => {
  it("keeps update checks disabled outside packaged releases", async () => {
    const updater = new FakeUpdater();
    const manager = new AppUpdateManager({
      currentVersion: "0.1.0",
      isPackaged: false,
      platform: "win32",
      updater: updater as never
    });

    await expect(manager.checkForUpdates()).resolves.toMatchObject({
      currentVersion: "0.1.0",
      isPackaged: false,
      state: "unsupported"
    });
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it("tracks available, download progress, and downloaded states", async () => {
    const updater = new FakeUpdater();
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit("update-available", { version: "0.2.0" });
      updater.emit("download-progress", { percent: 42.4 });
      updater.emit("update-downloaded", { version: "0.2.0" });
    });
    const manager = new AppUpdateManager({
      currentVersion: "0.1.0",
      isPackaged: true,
      platform: "win32",
      updater: updater as never
    });
    const changes = vi.fn();
    manager.on("change", changes);

    await expect(manager.checkForUpdates()).resolves.toMatchObject({
      state: "downloaded",
      availableVersion: "0.2.0",
      downloadProgress: 100
    });
    expect(changes).toHaveBeenCalledWith(expect.objectContaining({ state: "available", availableVersion: "0.2.0" }));
    expect(changes).toHaveBeenCalledWith(expect.objectContaining({ state: "downloading", downloadProgress: 42 }));
  });

  it("installs only after an update has downloaded", async () => {
    const updater = new FakeUpdater();
    const manager = new AppUpdateManager({
      currentVersion: "0.1.0",
      isPackaged: true,
      platform: "win32",
      updater: updater as never
    });

    expect(() => manager.installDownloadedUpdate()).toThrow("No downloaded update is ready to install.");

    updater.emit("update-downloaded", { version: "0.2.0" });
    manager.installDownloadedUpdate();

    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it("records update errors", async () => {
    const updater = new FakeUpdater();
    updater.checkForUpdates.mockRejectedValue(new Error("Network unavailable"));
    const manager = new AppUpdateManager({
      currentVersion: "0.1.0",
      isPackaged: true,
      platform: "win32",
      updater: updater as never
    });

    await expect(manager.checkForUpdates()).resolves.toMatchObject({
      state: "error",
      error: "Network unavailable"
    });
  });

  it("exposes a manual macOS installer download instead of auto-downloading", async () => {
    const updater = new FakeUpdater();
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const fetchManualUpdateAsset = vi.fn().mockResolvedValue({
      browserDownloadUrl: "https://github.com/rion-studio/rion-studio/releases/download/v0.2.0/Rion.Studio-mac.zip",
      name: "Rion.Studio-mac.zip",
      releasePageUrl: "https://github.com/rion-studio/rion-studio/releases/tag/v0.2.0"
    });

    updater.checkForUpdates.mockImplementation(async () => {
      const updateInfo = {
        files: [],
        path: "",
        releaseDate: "2026-07-12T00:00:00.000Z",
        sha512: "",
        tag: "v0.2.0",
        version: "0.2.0"
      };
      updater.emit("update-available", updateInfo);
      return {
        isUpdateAvailable: true,
        updateInfo,
        versionInfo: updateInfo
      };
    });

    const manager = new AppUpdateManager({
      arch: "arm64",
      currentVersion: "0.1.0",
      fetchManualUpdateAsset,
      isPackaged: true,
      manualUpdateRepository: "rion-studio/rion-studio",
      openExternal,
      platform: "darwin",
      updater: updater as never
    });

    await expect(manager.checkForUpdates()).resolves.toMatchObject({
      availableVersion: "0.2.0",
      downloadUrl: "https://github.com/rion-studio/rion-studio/releases/download/v0.2.0/Rion.Studio-mac.zip",
      installMode: "manual",
      installerName: "Rion.Studio-mac.zip",
      releasePageUrl: "https://github.com/rion-studio/rion-studio/releases/tag/v0.2.0",
      state: "available"
    });
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(fetchManualUpdateAsset).toHaveBeenCalledWith({
      arch: "arm64",
      productName: "Rion Studio",
      repository: "rion-studio/rion-studio",
      tag: "v0.2.0",
      version: "0.2.0"
    });

    await manager.openUpdateDownload();
    expect(openExternal).toHaveBeenCalledWith(
      "https://github.com/rion-studio/rion-studio/releases/download/v0.2.0/Rion.Studio-mac.zip"
    );
  });
});
