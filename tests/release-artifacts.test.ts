import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CHECKSUM_ASSET_NAME,
  REQUIRED_RELEASE_ASSETS,
  verifyReleaseAssets,
  writeReleaseChecksums
} from "../scripts/releaseArtifacts.mjs";
import {
  assertPublicReleaseNotesSafe,
  sanitizePublicReleaseNotes
} from "../scripts/sanitizePublicReleaseNotes.mjs";
import { verifyPackagedUpdateConfig } from "../scripts/verifyPackagedUpdateConfig.mjs";

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
      "latest.yml version 1.19.0 does not match 1.20.0"
    );
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

describe("packaged updater configuration", () => {
  it("requires the public distribution repository", () => {
    expect(() =>
      verifyPackagedUpdateConfig(
        "provider: github\nowner: rion-tw\nrepo: rion-studio\n",
        "rion-tw/rion-studio"
      )
    ).not.toThrow();

    expect(() =>
      verifyPackagedUpdateConfig(
        "provider: github\nowner: rion-tw\nrepo: rion-studio-source\n",
        "rion-tw/rion-studio"
      )
    ).toThrow("does not match rion-studio");
  });
});

async function createReleaseFixture(version: string, options: { omit?: string } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "rion-release-assets-"));

  for (const name of REQUIRED_RELEASE_ASSETS) {
    if (name === options.omit) {
      continue;
    }

    if (name === "latest.yml") {
      await writeFile(
        join(directory, name),
        `version: ${version}\nfiles:\n  - url: Rion.Studio-win.exe\npath: Rion.Studio-win.exe\n`,
        "utf8"
      );
    } else if (name === "latest-mac.yml") {
      await writeFile(
        join(directory, name),
        `version: ${version}\nfiles:\n  - url: Rion.Studio-mac.zip\n  - url: Rion.Studio-mac.dmg\npath: Rion.Studio-mac.zip\n`,
        "utf8"
      );
    } else {
      await writeFile(join(directory, name), `fixture:${name}`, "utf8");
    }
  }

  return directory;
}
