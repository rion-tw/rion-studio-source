import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { buildElectronUpdaterPreviousFixtures } from
  "../scripts/buildElectronUpdaterPreviousFixtures.mjs";

describe("Windows previous Electron updater fixture command", () => {
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
