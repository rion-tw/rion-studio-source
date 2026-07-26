import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

describe("Tauri updater manifest", () => {
  it("publishes only explicit signed macOS and Windows updater archives", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rion-updater-manifest-"));
    const macArchive = path.join(directory, "Rion.Studio-mac.app.tar.gz");
    const windowsArchive = path.join(directory, "Rion.Studio-win.exe");
    const output = path.join(directory, "latest.json");
    await Promise.all([
      writeFile(macArchive, "mac"),
      writeFile(`${macArchive}.sig`, "mac-signature\n"),
      writeFile(windowsArchive, "windows"),
      writeFile(`${windowsArchive}.sig`, "windows-signature\n")
    ]);

    const result = spawnSync(
      process.execPath,
      [
        "scripts/createTauriUpdaterManifest.mjs",
        "--version", "2.3.4",
        "--base-url", "https://downloads.example.test/releases/v2.3.4",
        "--mac-archive", macArchive,
        "--windows-installer", windowsArchive,
        "--published-at", "2026-07-26T00:00:00Z",
        "--output", output
      ],
      { cwd: process.cwd(), encoding: "utf8" }
    );

    expect(result.status, result.stderr).toBe(0);
    const manifest = JSON.parse(await readFile(output, "utf8"));
    expect(manifest).toEqual({
      version: "2.3.4",
      pub_date: "2026-07-26T00:00:00Z",
      platforms: {
        "darwin-aarch64": {
          url: "https://downloads.example.test/releases/v2.3.4/Rion.Studio-mac.app.tar.gz",
          signature: "mac-signature"
        },
        "windows-x86_64": {
          url: "https://downloads.example.test/releases/v2.3.4/Rion.Studio-win.exe",
          signature: "windows-signature"
        }
      }
    });
  });

  it("fails closed when an updater signature is missing", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rion-updater-manifest-"));
    const macArchive = path.join(directory, "mac.tar.gz");
    const windowsArchive = path.join(directory, "windows.zip");
    await Promise.all([writeFile(macArchive, "mac"), writeFile(windowsArchive, "windows")]);

    const result = spawnSync(
      process.execPath,
      [
        "scripts/createTauriUpdaterManifest.mjs",
        "--version", "2.3.4",
        "--base-url", "https://downloads.example.test/",
        "--mac-archive", macArchive,
        "--windows-installer", windowsArchive,
        "--output", path.join(directory, "latest.json")
      ],
      { cwd: process.cwd(), encoding: "utf8" }
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`${macArchive}.sig does not exist.`);
  });
});
