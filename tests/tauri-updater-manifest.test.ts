import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

describe("updater manifest", () => {
  it("publishes the same signed and hashed manifest through neutral and legacy entry points", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rion-updater-manifest-"));
    const macArchive = path.join(directory, "Rion.Studio-mac.app.tar.gz");
    const windowsArchive = path.join(directory, "Rion.Studio-win.exe");
    await Promise.all([
      writeFile(macArchive, "mac"),
      writeFile(`${macArchive}.sig`, "mac-signature\n"),
      writeFile(windowsArchive, "windows"),
      writeFile(`${windowsArchive}.sig`, "windows-signature\n")
    ]);

    const manifests = [];
    for (const [index, script] of [
      "scripts/createUpdaterManifest.mjs",
      "scripts/createTauriUpdaterManifest.mjs"
    ].entries()) {
      const output = path.join(directory, `latest-${index}.json`);
      const result = runManifestScript(script, macArchive, windowsArchive, output);
      expect(result.status, result.stderr).toBe(0);
      manifests.push(JSON.parse(await readFile(output, "utf8")));
    }

    expect(manifests[0]).toEqual({
      version: "2.3.4",
      pub_date: "2026-07-26T00:00:00Z",
      platforms: {
        "darwin-aarch64": {
          url: "https://downloads.example.test/releases/v2.3.4/Rion.Studio-mac.app.tar.gz",
          signature: "mac-signature",
          sha256: sha256("mac")
        },
        "windows-x86_64": {
          url: "https://downloads.example.test/releases/v2.3.4/Rion.Studio-win.exe",
          signature: "windows-signature",
          sha256: sha256("windows")
        }
      }
    });
    expect(manifests[1]).toEqual(manifests[0]);
  });

  it("fails closed when an updater signature is missing", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rion-updater-manifest-"));
    const macArchive = path.join(directory, "mac.tar.gz");
    const windowsArchive = path.join(directory, "windows.zip");
    await Promise.all([writeFile(macArchive, "mac"), writeFile(windowsArchive, "windows")]);

    const result = spawnSync(
      process.execPath,
      [
        "scripts/createUpdaterManifest.mjs",
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

  it("rejects authenticated or non-public updater endpoints", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rion-updater-manifest-"));
    const macArchive = path.join(directory, "Rion.Studio-mac.app.tar.gz");
    const windowsArchive = path.join(directory, "Rion.Studio-win.exe");
    await Promise.all([
      writeFile(macArchive, "mac"),
      writeFile(`${macArchive}.sig`, "mac-signature"),
      writeFile(windowsArchive, "windows"),
      writeFile(`${windowsArchive}.sig`, "windows-signature")
    ]);

    const result = runManifestScript(
      "scripts/createUpdaterManifest.mjs",
      macArchive,
      windowsArchive,
      path.join(directory, "latest.json"),
      "https://user:password@downloads.example.test/releases/v2.3.4"
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("public HTTPS without credentials");
  });
});

function runManifestScript(
  script: string,
  macArchive: string,
  windowsArchive: string,
  output: string,
  baseUrl = "https://downloads.example.test/releases/v2.3.4"
) {
  return spawnSync(
    process.execPath,
    [
      script,
      "--version", "2.3.4",
      "--base-url", baseUrl,
      "--mac-archive", macArchive,
      "--windows-installer", windowsArchive,
      "--published-at", "2026-07-26T00:00:00Z",
      "--output", output
    ],
    { cwd: process.cwd(), encoding: "utf8" }
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
