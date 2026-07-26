import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CHECKSUM_ASSET_NAME,
  REQUIRED_RELEASE_ASSETS,
  verifyReleaseAssets,
  verifyReleaseChecksums,
  writeReleaseChecksums
} from "../scripts/releaseArtifacts.mjs";
import {
  assertPublicReleaseNotesSafe,
  sanitizePublicReleaseNotes
} from "../scripts/sanitizePublicReleaseNotes.mjs";

describe("release artifact verification", () => {
  it("accepts the complete stable asset contract and writes deterministic checksums", async () => {
    const directory = await createReleaseFixture("1.20.0");

    await expect(verifyReleaseAssets(directory, "1.20.0")).resolves.toEqual(
      expect.arrayContaining(REQUIRED_RELEASE_ASSETS)
    );
    const first = await writeReleaseChecksums(directory);
    const second = await writeReleaseChecksums(directory);

    expect(first).toBe(second);
    expect(first.trim().split("\n")).toHaveLength(REQUIRED_RELEASE_ASSETS.length);
    expect(await readFile(join(directory, CHECKSUM_ASSET_NAME), "utf8")).toBe(first);
    await expect(
      verifyReleaseAssets(directory, "1.20.0", { allowChecksums: true })
    ).resolves.toContain(CHECKSUM_ASSET_NAME);
  });

  it("rejects missing assets, unexpected files, and mismatched updater versions", async () => {
    const missingDirectory = await createReleaseFixture("1.20.0", {
      omit: "latest.yml"
    });
    await expect(verifyReleaseAssets(missingDirectory, "1.20.0")).rejects.toThrow(
      "Missing required release assets: latest.yml"
    );

    const unexpectedDirectory = await createReleaseFixture("1.20.0");
    await writeFile(join(unexpectedDirectory, "source-map.js.map"), "not allowed", "utf8");
    await expect(verifyReleaseAssets(unexpectedDirectory, "1.20.0")).rejects.toThrow(
      "Unexpected release assets: source-map.js.map"
    );

    const wrongVersionDirectory = await createReleaseFixture("1.19.0");
    await expect(verifyReleaseAssets(wrongVersionDirectory, "1.20.0")).rejects.toThrow(
      "latest.json version 1.19.0 does not match 1.20.0"
    );
  });

  it("rejects a release asset changed after checksums were published", async () => {
    const directory = await createReleaseFixture("1.20.0");
    await writeReleaseChecksums(directory);
    await expect(verifyReleaseChecksums(directory)).resolves.toBeUndefined();

    await writeFile(join(directory, "Rion.Studio-win.exe.sig"), "tampered-signature", "utf8");
    await expect(
      verifyReleaseAssets(directory, "1.20.0", { allowChecksums: true })
    ).rejects.toThrow("SHA256SUMS.txt does not match the release assets");
  });
});

describe("public release notes", () => {
  it("removes public and private source commit links", () => {
    const source = [
      "# [1.20.0](https://github.com/rion-tw/rion-studio-source/compare/v1.19.0...v1.20.0) (2026-07-16)",
      "",
      "* add private release publishing ([0b5d542](https://github.com/rion-tw/rion-studio-source/commit/0b5d542e5047fa6618bfc1503ef8d43a3ff737df))"
    ].join("\n");

    const result = sanitizePublicReleaseNotes(source);

    expect(result).toContain("# 1.20.0 (2026-07-16)");
    expect(result).toContain("* add private release publishing");
    expect(result).not.toContain("0b5d542");
    expect(() => assertPublicReleaseNotesSafe(result)).not.toThrow();
  });

  it("rejects unsafe source references that bypass sanitization", () => {
    expect(() =>
      assertPublicReleaseNotesSafe("See https://github.com/rion-tw/rion-studio/commit/abc")
    ).toThrow("forbidden source reference");
  });
});

async function createReleaseFixture(version: string, options: { omit?: string } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "rion-release-assets-"));
  const macDmg = join(directory, "Rion.Studio-mac.dmg");
  const macArchive = join(directory, "Rion.Studio-mac.app.tar.gz");
  const windowsInstaller = join(directory, "Rion.Studio-win.exe");
  await Promise.all([
    writeFile(macDmg, "fixture:mac-dmg"),
    writeFile(macArchive, "fixture:mac-archive"),
    writeFile(`${macArchive}.sig`, "mac-signature"),
    writeFile(windowsInstaller, "fixture:windows-installer"),
    writeFile(`${windowsInstaller}.sig`, "windows-signature")
  ]);
  runScript([
    "scripts/createTauriUpdaterManifest.mjs",
    "--version", version,
    "--base-url", `https://downloads.example.test/${version}`,
    "--mac-archive", macArchive,
    "--windows-installer", windowsInstaller,
    "--published-at", "2026-07-26T00:00:00Z",
    "--output", join(directory, "latest.json")
  ]);
  runScript([
    "scripts/createLegacyUpdateManifests.mjs",
    "--version", version,
    "--mac-dmg", macDmg,
    "--windows-installer", windowsInstaller,
    "--published-at", "2026-07-26T00:00:00Z",
    "--output-directory", directory
  ]);
  if (options.omit) await rm(join(directory, options.omit));
  return directory;
}

function runScript(args: string[]): void {
  const result = spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
}
