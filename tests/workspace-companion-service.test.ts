import { describe, expect, it, vi } from "vitest";

import { WorkspaceCompanionService } from "../src/main/workspaces/WorkspaceCompanionService";

describe("WorkspaceCompanionService", () => {
  it("picks a macOS application bundle and derives its label", async () => {
    const showOpenDialog = vi.fn().mockResolvedValue({
      canceled: false,
      filePaths: ["/Applications/VLC.app"]
    });
    const service = createService({
      platform: "darwin",
      showOpenDialog,
      statPath: vi.fn().mockResolvedValue(directoryStats())
    });

    await expect(service.pickApplication()).resolves.toEqual({
      kind: "application",
      label: "VLC",
      path: "/Applications/VLC.app",
      platform: "darwin"
    });
    expect(showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({
      filters: [{ name: "Applications", extensions: ["app"] }],
      properties: ["openFile"]
    }));
  });

  it.each(["exe", "lnk"])("picks a Windows .%s application target", async (extension) => {
    const path = `C:\\Apps\\Player.${extension}`;
    const service = createService({
      platform: "win32",
      showOpenDialog: vi.fn().mockResolvedValue({ canceled: false, filePaths: [path] }),
      statPath: vi.fn().mockResolvedValue(fileStats())
    });

    await expect(service.pickApplication()).resolves.toMatchObject({ path, platform: "win32" });
  });

  it("returns null when application selection is cancelled", async () => {
    const service = createService({
      platform: "darwin",
      showOpenDialog: vi.fn().mockResolvedValue({ canceled: true, filePaths: [] })
    });

    await expect(service.pickApplication()).resolves.toBeNull();
  });

  it("rejects unsupported application paths selected by the user", async () => {
    const service = createService({
      platform: "darwin",
      showOpenDialog: vi.fn().mockResolvedValue({ canceled: false, filePaths: ["/tmp/run.sh"] }),
      statPath: vi.fn().mockResolvedValue(fileStats())
    });

    await expect(service.pickApplication()).rejects.toThrow("macOS application bundle");
  });

  it("opens HTTP targets through the default browser", async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const service = createService({ openExternal });

    await expect(service.open({ kind: "url", url: "https://example.com/watch" })).resolves.toEqual({
      kind: "opened"
    });
    expect(openExternal).toHaveBeenCalledWith("https://example.com/watch");
  });

  it("opens only the persisted application path without arguments", async () => {
    const openPath = vi.fn().mockResolvedValue("");
    const service = createService({
      platform: "darwin",
      openPath,
      statPath: vi.fn().mockResolvedValue(directoryStats())
    });

    await expect(service.open({
      kind: "application",
      label: "Player",
      path: "/Applications/Player.app",
      platform: "darwin"
    })).resolves.toEqual({ kind: "opened" });
    expect(openPath.mock.calls).toEqual([["/Applications/Player.app"]]);
  });

  it("reports platform mismatch, missing targets, and shell failures without throwing", async () => {
    const platformService = createService({ platform: "win32" });
    await expect(platformService.open({
      kind: "application",
      label: "Player",
      path: "/Applications/Player.app",
      platform: "darwin"
    })).resolves.toMatchObject({ kind: "failed", reason: "platform_mismatch" });

    const missingService = createService({
      platform: "darwin",
      statPath: vi.fn().mockRejectedValue(new Error("ENOENT"))
    });
    await expect(missingService.open({
      kind: "application",
      label: "Player",
      path: "/Applications/Player.app",
      platform: "darwin"
    })).resolves.toMatchObject({ kind: "failed", reason: "target_missing" });

    const failedService = createService({ openExternal: vi.fn().mockRejectedValue(new Error("failed")) });
    await expect(failedService.open({ kind: "url", url: "https://example.com" })).resolves.toMatchObject({
      kind: "failed",
      reason: "open_failed"
    });
  });
});

function createService(overrides: Partial<ConstructorParameters<typeof WorkspaceCompanionService>[0]> = {}) {
  return new WorkspaceCompanionService({
    openExternal: vi.fn().mockResolvedValue(undefined),
    openPath: vi.fn().mockResolvedValue(""),
    platform: "darwin",
    showOpenDialog: vi.fn().mockResolvedValue({ canceled: true, filePaths: [] }),
    statPath: vi.fn().mockResolvedValue(directoryStats()),
    ...overrides
  });
}

function directoryStats() {
  return { isDirectory: () => true, isFile: () => false };
}

function fileStats() {
  return { isDirectory: () => false, isFile: () => true };
}
