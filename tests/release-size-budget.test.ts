import { mkdtemp, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  RELEASE_SIZE_BASELINES,
  RELEASE_SIZE_LIMITS,
  RELEASE_SIZE_TOLERANCES,
  verifyReleaseSizeBudget
} from "../scripts/checkReleaseSize.mjs";

describe("release artifact size budget", () => {
  it("accepts macOS and Windows candidates at their fixed v3.18.1 limits", async () => {
    const macDirectory = await fixtureDirectory();
    await sparseFile(
      join(macDirectory, "Rion.Studio-mac.app.tar.gz"),
      RELEASE_SIZE_LIMITS["Rion.Studio-mac.app.tar.gz"]
    );
    await sparseFile(
      join(macDirectory, "Rion.Studio-mac.dmg"),
      RELEASE_SIZE_LIMITS["Rion.Studio-mac.dmg"]
    );
    const windowsDirectory = await fixtureDirectory();
    await sparseFile(
      join(windowsDirectory, "Rion.Studio-win.exe"),
      RELEASE_SIZE_LIMITS["Rion.Studio-win.exe"]
    );

    await expect(verifyReleaseSizeBudget(macDirectory)).resolves.toHaveLength(2);
    await expect(verifyReleaseSizeBudget(windowsDirectory)).resolves.toHaveLength(1);
  });

  it("rejects an artifact that is one byte over its fixed limit", async () => {
    const directory = await fixtureDirectory();
    await sparseFile(
      join(directory, "Rion.Studio-win.exe"),
      RELEASE_SIZE_LIMITS["Rion.Studio-win.exe"] + 1
    );

    await expect(verifyReleaseSizeBudget(directory)).rejects.toThrow(
      "10% smaller than v3.18.1"
    );
  });

  it("accepts the observed macOS DMG packaging variance", async () => {
    const directory = await fixtureDirectory();
    await sparseFile(
      join(directory, "Rion.Studio-mac.app.tar.gz"),
      RELEASE_SIZE_LIMITS["Rion.Studio-mac.app.tar.gz"]
    );
    await sparseFile(join(directory, "Rion.Studio-mac.dmg"), 13_770_747);

    const results = await verifyReleaseSizeBudget(directory);
    expect(results.find(({ name }) => name === "Rion.Studio-mac.dmg")).toMatchObject({
      maximumBytes: 13_778_981,
      toleranceBytes: 32 * 1024
    });
  });

  it("rejects an incomplete normalized macOS candidate", async () => {
    const directory = await fixtureDirectory();
    await sparseFile(join(directory, "Rion.Studio-mac.dmg"), 1);

    await expect(verifyReleaseSizeBudget(directory)).rejects.toThrow(
      "Rion.Studio-mac.app.tar.gz"
    );
  });

  it("limits macOS DMG packaging variance to the explicit tolerance", () => {
    expect(RELEASE_SIZE_TOLERANCES["Rion.Studio-mac.dmg"]).toBe(32 * 1024);
    expect(RELEASE_SIZE_LIMITS["Rion.Studio-mac.dmg"]).toBe(
      Math.floor(RELEASE_SIZE_BASELINES["Rion.Studio-mac.dmg"] * 0.9) + 32 * 1024
    );
    expect(RELEASE_SIZE_TOLERANCES["Rion.Studio-mac.app.tar.gz"]).toBeUndefined();
    expect(RELEASE_SIZE_TOLERANCES["Rion.Studio-win.exe"]).toBeUndefined();
  });
});

async function fixtureDirectory() {
  return mkdtemp(join(tmpdir(), "rion-release-size-"));
}

async function sparseFile(path: string, size: number) {
  const handle = await open(path, "w");
  try {
    await handle.truncate(size);
  } finally {
    await handle.close();
  }
}
