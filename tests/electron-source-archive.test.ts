import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createElectronSourceArchive,
  ELECTRON_SOURCE_ARCHIVE_NAME,
  verifyElectronSourceArchive
} from "../scripts/electronSourceArchive.mjs";

const roots: string[] = [];
const required = [
  "LICENSE",
  "TRADEMARKS.md",
  "package.json",
  "third_party/electron-chrome-extensions/LICENSE-GPL",
  "third_party/electron-chrome-extensions/RION-PROVENANCE.md",
  "third_party/electron-chrome-extensions/src/browser/rion.ts",
  "third_party/electron-chrome-extensions/src/rion-preload.ts"
];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture(version = "1.2.3") {
  const root = await mkdtemp(join(tmpdir(), "rion-source-archive-"));
  roots.push(root);
  for (const path of required) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), path === "package.json"
      ? `${JSON.stringify({ name: "rion-studio", version })}\n`
      : `fixture:${path}\n`);
  }
  return root;
}

describe("Electron corresponding source archive", () => {
  it("creates and verifies a deterministic rooted archive", async () => {
    const root = await fixture();
    const outputPath = join(root, ELECTRON_SOURCE_ARCHIVE_NAME);
    const result = await createElectronSourceArchive({
      outputPath,
      root,
      trackedPaths: [...required].reverse(),
      version: "1.2.3"
    });

    expect(result).toMatchObject({ name: ELECTRON_SOURCE_ARCHIVE_NAME, sourceCount: required.length });
    await expect(verifyElectronSourceArchive(outputPath, "1.2.3"))
      .resolves.toEqual({ sourceCount: required.length, version: "1.2.3" });
    expect((await readFile(outputPath)).length).toBeGreaterThan(100);
  });

  it("rejects missing corresponding source and unsafe paths", async () => {
    const root = await fixture();
    await expect(createElectronSourceArchive({
      outputPath: join(root, ELECTRON_SOURCE_ARCHIVE_NAME),
      root,
      trackedPaths: required.filter((path) => !path.endsWith("rion-preload.ts")),
      version: "1.2.3"
    })).rejects.toThrow("missing corresponding source");
    await expect(createElectronSourceArchive({
      outputPath: join(root, ELECTRON_SOURCE_ARCHIVE_NAME),
      root,
      trackedPaths: [...required, "../secret"],
      version: "1.2.3"
    })).rejects.toThrow("path is unsafe");
  });
});
