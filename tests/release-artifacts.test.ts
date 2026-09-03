import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
  assertStableTauriV22PublicReleaseAssets
} from "../scripts/publicReleaseRuntimePolicy.mjs";
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
    const manifest = JSON.parse(await readFile(join(directory, "latest.json"), "utf8"));
    expect(manifest.platforms["darwin-aarch64"].sha256).toBe(sha256("fixture:mac-archive"));
    expect(manifest.platforms["windows-x86_64"].sha256).toBe(
      sha256("fixture:windows-installer")
    );
    expect(first).toContain(
      `${manifest.platforms["darwin-aarch64"].sha256}  Rion.Studio-mac.app.tar.gz`
    );
    expect(first).toContain(
      `${manifest.platforms["windows-x86_64"].sha256}  Rion.Studio-win.exe`
    );
    await expect(
      verifyReleaseAssets(directory, "1.20.0", { allowChecksums: true })
    ).resolves.toContain(CHECKSUM_ASSET_NAME);
  });

  it("rejects missing assets, unexpected files, and mismatched updater versions", async () => {
    const missingDirectory = await createReleaseFixture("1.20.0", {
      omit: "latest.json"
    });
    await expect(verifyReleaseAssets(missingDirectory, "1.20.0")).rejects.toThrow(
      "Missing required release assets: latest.json"
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

  it("rejects a published signature that diverges from the manifest", async () => {
    const directory = await createReleaseFixture("1.20.0");
    await writeReleaseChecksums(directory);
    await expect(verifyReleaseChecksums(directory)).resolves.toBeUndefined();

    await writeFile(join(directory, "Rion.Studio-win.exe.sig"), "tampered-signature", "utf8");
    await expect(
      verifyReleaseAssets(directory, "1.20.0", { allowChecksums: true })
    ).rejects.toThrow(
      "latest.json windows-x86_64 signature does not match Rion.Studio-win.exe.sig"
    );
  });

  it("rejects inline hashes that diverge from either the payload or checksum document", async () => {
    const payloadMismatchDirectory = await createReleaseFixture("1.20.0");
    const manifestPath = join(payloadMismatchDirectory, "latest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.platforms["darwin-aarch64"].sha256 = "0".repeat(64);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await expect(verifyReleaseAssets(payloadMismatchDirectory, "1.20.0")).rejects.toThrow(
      "latest.json darwin-aarch64 sha256 does not match Rion.Studio-mac.app.tar.gz"
    );

    const checksumMismatchDirectory = await createReleaseFixture("1.20.0");
    await writeReleaseChecksums(checksumMismatchDirectory);
    const checksumPath = join(checksumMismatchDirectory, CHECKSUM_ASSET_NAME);
    const checksums = await readFile(checksumPath, "utf8");
    await writeFile(
      checksumPath,
      checksums.replace(
        `${sha256("fixture:windows-installer")}  Rion.Studio-win.exe`,
        `${"0".repeat(64)}  Rion.Studio-win.exe`
      ),
      "utf8"
    );
    await expect(
      verifyReleaseAssets(checksumMismatchDirectory, "1.20.0", { allowChecksums: true })
    ).rejects.toThrow("latest.json windows-x86_64 sha256 does not match SHA256SUMS.txt");
  });

  it("rejects non-public artifact URLs and unexpected updater platforms", async () => {
    const insecureDirectory = await createReleaseFixture("1.20.0");
    const insecureManifestPath = join(insecureDirectory, "latest.json");
    const insecureManifest = JSON.parse(await readFile(insecureManifestPath, "utf8"));
    insecureManifest.platforms["darwin-aarch64"].url =
      "http://downloads.example.test/Rion.Studio-mac.app.tar.gz";
    await writeFile(
      insecureManifestPath,
      `${JSON.stringify(insecureManifest, null, 2)}\n`,
      "utf8"
    );
    await expect(verifyReleaseAssets(insecureDirectory, "1.20.0"))
      .rejects.toThrow("invalid darwin-aarch64 artifact URL");

    const extraPlatformDirectory = await createReleaseFixture("1.20.0");
    const extraPlatformManifestPath = join(extraPlatformDirectory, "latest.json");
    const extraPlatformManifest = JSON.parse(
      await readFile(extraPlatformManifestPath, "utf8")
    );
    extraPlatformManifest.platforms["linux-x86_64"] = {
      ...extraPlatformManifest.platforms["windows-x86_64"]
    };
    await writeFile(
      extraPlatformManifestPath,
      `${JSON.stringify(extraPlatformManifest, null, 2)}\n`,
      "utf8"
    );
    await expect(verifyReleaseAssets(extraPlatformDirectory, "1.20.0"))
      .rejects.toThrow("platforms must be exactly");
  });
});

describe("stable Tauri v22 public release policy", () => {
  it("accepts the packaged Tauri application shape", async () => {
    const directory = await createMacRuntimeArchiveFixture("tauri");

    await expect(
      assertStableTauriV22PublicReleaseAssets(directory)
    ).resolves.toBeUndefined();
  });

  it("rejects Electron assets even when they use the stable release filenames", async () => {
    const directory = await createMacRuntimeArchiveFixture("electron");

    await expect(
      assertStableTauriV22PublicReleaseAssets(directory)
    ).rejects.toThrow(
      "Electron release assets require a separate owner-approved promotion workflow"
    );
  });

  it("rejects candidate evidence because verified is not published", async () => {
    const directory = await createMacRuntimeArchiveFixture("tauri");
    await writeFile(
      join(directory, "electron-production-candidate-receipt.json"),
      '{"status":"verified-not-published"}\n',
      "utf8"
    );

    await expect(
      assertStableTauriV22PublicReleaseAssets(directory)
    ).rejects.toThrow("Electron candidate receipts are not public promotion receipts");
  });

  it("rejects a generic app disguised with the stable archive shape", async () => {
    const directory = await createMacRuntimeArchiveFixture("generic");

    await expect(
      assertStableTauriV22PublicReleaseAssets(directory)
    ).rejects.toThrow("only the stable Tauri v22 executable");
  });

  it("rejects an additional top-level macOS executable beside rion-tauri", async () => {
    const directory = await createMacRuntimeArchiveFixture("tauri-with-extra-executable");

    await expect(
      assertStableTauriV22PublicReleaseAssets(directory)
    ).rejects.toThrow("only the stable Tauri v22 executable");
  });

  it("rejects a symlink disguised as the stable Tauri executable", async () => {
    const directory = await createMacRuntimeArchiveFixture("tauri-symlink");

    await expect(
      assertStableTauriV22PublicReleaseAssets(directory)
    ).rejects.toThrow("must be a regular archive entry");
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
  if (options.omit) await rm(join(directory, options.omit));
  return directory;
}

async function createMacRuntimeArchiveFixture(
  runtime: "electron" | "generic" | "tauri" | "tauri-symlink" | "tauri-with-extra-executable"
) {
  const directory = await mkdtemp(join(tmpdir(), "rion-public-runtime-policy-"));
  const application = join(directory, "archive-root", "Rion Studio.app", "Contents");
  await Promise.all([
    mkdir(join(application, "MacOS"), { recursive: true }),
    mkdir(join(application, "Resources"), { recursive: true }),
    mkdir(join(application, "Frameworks"), { recursive: true })
  ]);
  await writeFile(join(application, "Info.plist"), "fixture:info-plist");
  const executablePath = join(
    application,
    "MacOS",
    runtime.startsWith("tauri") ? "rion-tauri" : "Rion Studio"
  );
  if (runtime === "tauri-symlink") {
    await writeFile(join(application, "Resources", "rion-tauri-real"), "fixture:executable");
    await symlink("../Resources/rion-tauri-real", executablePath);
  } else {
    await writeFile(executablePath, "fixture:executable");
  }
  if (runtime === "tauri-with-extra-executable") {
    await writeFile(join(application, "MacOS", "unexpected-helper"), "fixture:helper");
  }
  if (runtime === "electron") {
    await Promise.all([
      writeFile(join(application, "Resources", "app.asar"), "fixture:electron-asar"),
      mkdir(join(application, "Frameworks", "Electron Framework.framework"))
    ]);
  }

  const result = spawnSync(
    "tar",
    [
      "-czf",
      join(directory, "Rion.Studio-mac.app.tar.gz"),
      "-C",
      join(directory, "archive-root"),
      "Rion Studio.app"
    ],
    { encoding: "utf8" }
  );
  expect(result.status, result.stderr).toBe(0);
  return directory;
}

function runScript(args: string[]): void {
  const result = spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
