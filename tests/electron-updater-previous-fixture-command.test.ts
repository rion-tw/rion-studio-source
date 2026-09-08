import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { buildElectronUpdaterPreviousFixtures } from
  "../scripts/buildElectronUpdaterPreviousFixtures.mjs";

describe("Previous updater source fixtures", () => {
  it("rejects an unpinned macOS source version before downloading or rebuilding", async () => {
    const root = await mkdtemp(join(tmpdir(), "rion mac fixture "));
    const githubEnvironment = join(root, "github environment");
    await writeFile(githubEnvironment, "");
    const executeFile = vi.fn();
    try {
      await expect(buildElectronUpdaterPreviousFixtures({
        CI: "true", GITHUB_ACTIONS: "true", GITHUB_ENV: githubEnvironment,
        RION_UPDATER_CI_FIXTURE_ROOT: root, RION_UPDATER_PRIOR_V23_VERSION: "8.4.0",
        RION_STUDIO_ELECTRON_PACKAGE_VERSION: "8.5.0", RION_UPDATER_TAURI_V22_VERSION: "8.2.0"
      }, { platform: "darwin", executeFile })).rejects.toThrow("pinned published v22 asset");
      expect(executeFile).not.toHaveBeenCalled();
      expect(await readFile(githubEnvironment, "utf8")).toBe("");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects changed macOS archive bytes before extraction and withholds signing inputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "rion mac fixture "));
    const githubEnvironment = join(root, "github environment");
    await writeFile(githubEnvironment, "");
    const executeFile = vi.fn(async (
      _executable: string, args: string[], _options: { env: NodeJS.ProcessEnv }
    ) => {
      await writeFile(args[args.indexOf("--output") + 1], "substituted archive");
    });
    try {
      await expect(buildElectronUpdaterPreviousFixtures({
        CI: "true", GITHUB_ACTIONS: "true", GITHUB_ENV: githubEnvironment,
        RION_UPDATER_CI_FIXTURE_ROOT: root, RION_UPDATER_PRIOR_V23_VERSION: "8.4.0",
        RION_STUDIO_ELECTRON_PACKAGE_VERSION: "8.5.0", RION_UPDATER_TAURI_V22_VERSION: "8.3.0",
        TAURI_SIGNING_PRIVATE_KEY: "must-not-enter-download", APPLE_PASSWORD: "must-not-enter-download"
      }, { platform: "darwin", executeFile })).rejects.toThrow("pinned bytes or SHA-256");
      expect(executeFile).toHaveBeenCalledExactlyOnceWith("/usr/bin/curl", expect.arrayContaining([
        "--max-redirs", "2", "--connect-timeout", "10", "--max-time", "30",
        "--max-filesize", "14229514",
        "https://github.com/rion-tw/rion-studio/releases/download/v8.3.0/Rion.Studio-mac.app.tar.gz"
      ]), expect.objectContaining({ env: expect.any(Object) }));
      const downloadEnvironment = executeFile.mock.calls[0][2].env;
      expect(downloadEnvironment).not.toHaveProperty("TAURI_SIGNING_PRIVATE_KEY");
      expect(downloadEnvironment).not.toHaveProperty("APPLE_PASSWORD");
      expect(await readFile(githubEnvironment, "utf8")).toBe("");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("executes the pinned CLI directly and retains exact spaced paths and version", async () => {
    const root = await mkdtemp(join(tmpdir(), "rion previous fixture "));
    const githubEnvironment = join(root, "github environment");
    await writeFile(githubEnvironment, "");
    const executeFile = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    try {
      const environment = {
        CI: "true", GITHUB_ACTIONS: "true", GITHUB_ENV: githubEnvironment,
        RION_UPDATER_CI_FIXTURE_ROOT: root,
        RION_UPDATER_PRIOR_V23_VERSION: "8.4.0",
        RION_STUDIO_ELECTRON_PACKAGE_VERSION: "8.5.0"
      };
      const result = await buildElectronUpdaterPreviousFixtures(environment, {
        platform: "win32", executeFile
      });
      const output = join(root, "previous-8.4.0");
      expect(executeFile).toHaveBeenCalledExactlyOnceWith(process.execPath, [
        createRequire(import.meta.url).resolve("electron-builder/cli.js"),
        "--config", "electron-builder.config.mjs", "--win", "--x64",
        "--publish", "never", `--config.directories.output=${output}`
      ], {
        cwd: process.cwd(),
        env: { ...environment, RION_STUDIO_ELECTRON_PACKAGE_VERSION: "8.4.0" },
        maxBuffer: 16 * 1024 * 1024, windowsHide: true
      });
      expect(result).toEqual({ V23: join(output, "Rion.Studio-win.exe") });
      expect(await readFile(githubEnvironment, "utf8")).toBe(
        `RION_UPDATER_PREVIOUS_V23_INSTALLER=${result.V23}\n` +
        "RION_UPDATER_PREVIOUS_V23_VERSION=8.4.0\n"
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
