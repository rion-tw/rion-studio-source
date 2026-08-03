import { mkdtemp, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  RELEASE_SIZE_LIMITS,
  verifyReleaseSizeBudget
} from "../scripts/checkReleaseSize.mjs";

describe("release artifact size budget", () => {
  it("defines balanced fixed limits for every release artifact", () => {
    expect(RELEASE_SIZE_LIMITS).toEqual({
      "Rion.Studio-mac.app.tar.gz": 16_777_216,
      "Rion.Studio-mac.dmg": 18_874_368,
      "Rion.Studio-win.exe": 12_582_912
    });
  });

  it("accepts macOS and Windows candidates at their fixed limits", async () => {
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

  it.each([
    { name: "Rion.Studio-mac.app.tar.gz" },
    { name: "Rion.Studio-mac.dmg" },
    { name: "Rion.Studio-win.exe" }
  ] as const)("rejects $name when it is one byte over its fixed limit", async ({ name }) => {
    const directory = await fixtureDirectory();
    if (name === "Rion.Studio-win.exe") {
      await sparseFile(join(directory, name), RELEASE_SIZE_LIMITS[name] + 1);
    } else {
      await sparseFile(
        join(directory, "Rion.Studio-mac.app.tar.gz"),
        RELEASE_SIZE_LIMITS["Rion.Studio-mac.app.tar.gz"]
      );
      await sparseFile(
        join(directory, "Rion.Studio-mac.dmg"),
        RELEASE_SIZE_LIMITS["Rion.Studio-mac.dmg"]
      );
      await sparseFile(join(directory, name), RELEASE_SIZE_LIMITS[name] + 1);
    }

    const sizeBytes = RELEASE_SIZE_LIMITS[name] + 1;
    await expect(verifyReleaseSizeBudget(directory)).rejects.toThrow(
      `${name} is ${sizeBytes} bytes; it must be at most ${RELEASE_SIZE_LIMITS[name]} bytes.`
    );
  });

  it("rejects an incomplete normalized macOS candidate", async () => {
    const directory = await fixtureDirectory();
    await sparseFile(join(directory, "Rion.Studio-mac.dmg"), 1);

    await expect(verifyReleaseSizeBudget(directory)).rejects.toThrow(
      "Rion.Studio-mac.app.tar.gz"
    );
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
