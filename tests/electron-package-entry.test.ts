import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { packageElectron } from "../scripts/packageElectron.mjs";
import { spawnPlatformCommand } from "../scripts/spawnPlatformCommand.mjs";

vi.mock("../scripts/spawnPlatformCommand.mjs", () => ({
  spawnPlatformCommand: vi.fn()
}));

beforeEach(() => vi.mocked(spawnPlatformCommand).mockReset());

describe("Electron package subprocess boundary", () => {
  it.each([
    ["darwin", "pnpm", "package:electron:mac"],
    ["win32", "pnpm.cmd", "package:electron:win"]
  ] as const)("excludes signing material while retaining public configuration on %s", async (platform, command, script) => {
    const child = new EventEmitter();
    vi.mocked(spawnPlatformCommand).mockReturnValue(child as ReturnType<typeof spawnPlatformCommand>);
    const environment = {
      PATH: "test-tool-path",
      RION_STUDIO_UPDATER_PUBLIC_KEY: "test-public-key",
      RION_STUDIO_UPDATER_ENDPOINT: "https://updates.example/latest.json",
      TAURI_SIGNING_PRIVATE_KEY: "test-private-placeholder",
      tauri_signing_private_key_password: "test-password",
      RION_STUDIO_UPDATER_PRIVATE_PATH: "test-private-path"
    };
    const pending = packageElectron({ platform, environment });
    expect(spawnPlatformCommand).toHaveBeenCalledWith(command, ["run", script], expect.objectContaining({
      env: {
        PATH: environment.PATH,
        RION_STUDIO_UPDATER_PUBLIC_KEY: environment.RION_STUDIO_UPDATER_PUBLIC_KEY,
        RION_STUDIO_UPDATER_ENDPOINT: environment.RION_STUDIO_UPDATER_ENDPOINT
      },
      windowsHide: true
    }));
    child.emit("exit", 0, null);
    await expect(pending).resolves.toBeUndefined();
    expect(environment.TAURI_SIGNING_PRIVATE_KEY).toBe("test-private-placeholder");
  });

  it.each(["darwin", "win32"] as const)("preserves a failed package process on %s", async (platform) => {
    const child = new EventEmitter();
    vi.mocked(spawnPlatformCommand).mockReturnValue(child as ReturnType<typeof spawnPlatformCommand>);
    const pending = packageElectron({ platform, environment: {} });
    child.emit("exit", 7, null);
    await expect(pending).rejects.toThrow("Electron packaging failed: 7");
  });
});
