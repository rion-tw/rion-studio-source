import { createHash } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { describe, expect, it, vi } from "vitest";

const fileOpenRace = vi.hoisted((): {
  afterOpen?: (path: string) => Promise<void>;
} => ({}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    async open(...argumentsList: Parameters<typeof actual.open>) {
      const handle = await actual.open(...argumentsList);
      try {
        await fileOpenRace.afterOpen?.(String(argumentsList[0]));
        return handle;
      } catch (error) {
        await handle.close();
        throw error;
      }
    }
  };
});

import {
  assertPortablePackagedElectronPackageManifest,
  assertPackagedElectronPackageManifestSummary,
  assertPackagedElectronPackageManifestUnchanged,
  capturePackagedElectronPackageManifest,
  comparePackagedElectronPackageManifests,
  createPortablePackagedElectronPackageManifest,
  removeExactPortablePackagedElectronPackageManifestEntry,
  summarizePackagedElectronPackageManifest,
  toPortablePackagedElectronPackageManifest
} from "../scripts/packagedElectronPackageManifest.mjs";

const unixIt = process.platform === "win32" ? it.skip : it;

describe("packaged Electron package manifest", () => {
  it("captures a deterministic, deeply frozen, no-follow package manifest", async () => {
    await withPackageFixture(async ({ packageRoot }) => {
      await mkdir(join(packageRoot, "nested"));
      const rootSource = Buffer.from("root file\n");
      const nestedSource = Buffer.from("nested file\n");
      await Promise.all([
        writeFile(join(packageRoot, "empty.bin"), Buffer.alloc(0)),
        writeFile(join(packageRoot, "nested", "nested.txt"), nestedSource),
        writeFile(join(packageRoot, "root.txt"), rootSource)
      ]);

      const manifest = await capturePackagedElectronPackageManifest(packageRoot);
      expect(manifest).toMatchObject({
        directoryCount: 1,
        entryCount: 4,
        packageDirectory: await realpath(packageRoot),
        regularFileBytes: rootSource.length + nestedSource.length,
        regularFileCount: 3,
        rootMode: await permissionMode(packageRoot),
        schemaVersion: 1,
        symlinkCount: 0
      });
      expect(manifest.entries).toEqual([
        {
          bytes: 0,
          mode: await permissionMode(join(packageRoot, "empty.bin")),
          path: "empty.bin",
          sha256: sha256(Buffer.alloc(0)),
          type: "regular-file"
        },
        {
          mode: await permissionMode(join(packageRoot, "nested")),
          path: "nested",
          type: "directory"
        },
        {
          bytes: nestedSource.length,
          mode: await permissionMode(join(packageRoot, "nested", "nested.txt")),
          path: "nested/nested.txt",
          sha256: sha256(nestedSource),
          type: "regular-file"
        },
        {
          bytes: rootSource.length,
          mode: await permissionMode(join(packageRoot, "root.txt")),
          path: "root.txt",
          sha256: sha256(rootSource),
          type: "regular-file"
        }
      ]);
      expect(Object.isFrozen(manifest)).toBe(true);
      expect(Object.isFrozen(manifest.entries)).toBe(true);
      expect(manifest.entries.every((entry) => Object.isFrozen(entry))).toBe(true);

      const repeated = await capturePackagedElectronPackageManifest(packageRoot);
      expect(repeated.sha256).toBe(manifest.sha256);
      const comparison = comparePackagedElectronPackageManifests(manifest, repeated);
      expect(comparison).toEqual({
        addedPaths: [],
        changedPaths: [],
        matches: true,
        removedPaths: []
      });
      expect(Object.isFrozen(comparison)).toBe(true);
      expect(Object.isFrozen(comparison.addedPaths)).toBe(true);

      const summary = assertPackagedElectronPackageManifestUnchanged(manifest, repeated);
      expect(summary).toEqual(summarizePackagedElectronPackageManifest(manifest));
      expect(Object.isFrozen(summary)).toBe(true);
      expect(assertPackagedElectronPackageManifestSummary(summary)).toEqual(summary);
      expect(() => assertPackagedElectronPackageManifestSummary({
        ...summary,
        entryCount: summary.entryCount + 1
      })).toThrow("entry count is inconsistent");
    });
  });

  it("creates and validates closed, path-independent portable manifests", async () => {
    await withPackageFixture(async ({ packageRoot }) => {
      await mkdir(join(packageRoot, "nested"));
      await Promise.all([
        writeFile(join(packageRoot, "first.bin"), "first\n"),
        writeFile(join(packageRoot, "nested", "second.bin"), "second\n")
      ]);
      const captured = await capturePackagedElectronPackageManifest(packageRoot);
      const portable = toPortablePackagedElectronPackageManifest(captured);

      expect(Object.hasOwn(portable, "packageDirectory")).toBe(false);
      expect(portable).toEqual({
        directoryCount: captured.directoryCount,
        entries: captured.entries,
        entryCount: captured.entryCount,
        regularFileBytes: captured.regularFileBytes,
        regularFileCount: captured.regularFileCount,
        rootMode: captured.rootMode,
        schemaVersion: captured.schemaVersion,
        sha256: captured.sha256,
        symlinkCount: captured.symlinkCount
      });
      expect(createPortablePackagedElectronPackageManifest(
        portable.entries,
        portable.rootMode
      )).toEqual(portable);
      const asserted = assertPortablePackagedElectronPackageManifest(portable);
      expect(asserted).toEqual(portable);
      expect(asserted).not.toBe(portable);
      expect(asserted.entries).not.toBe(portable.entries);
      expect(asserted.entries[0]).not.toBe(portable.entries[0]);
      expect(Object.isFrozen(asserted)).toBe(true);
      expect(Object.isFrozen(asserted.entries)).toBe(true);
      expect(asserted.entries.every((entry) => Object.isFrozen(entry))).toBe(true);

      expect(() => assertPortablePackagedElectronPackageManifest({
        ...portable,
        unexpected: true
      })).toThrow("fields must be exactly");
      expect(() => assertPortablePackagedElectronPackageManifest({
        ...portable,
        sha256: "0".repeat(64)
      })).toThrow("invalid SHA-256");

      const unsortedEntries = [...portable.entries].reverse();
      expect(() => assertPortablePackagedElectronPackageManifest({
        ...portable,
        entries: unsortedEntries
      })).toThrow("unique sorted paths");
      expect(() => createPortablePackagedElectronPackageManifest(
        unsortedEntries,
        portable.rootMode
      )).toThrow("unique sorted paths");

      const duplicateEntries = [
        portable.entries[0],
        portable.entries[0],
        ...portable.entries.slice(1)
      ];
      expect(() => createPortablePackagedElectronPackageManifest(
        duplicateEntries,
        portable.rootMode
      )).toThrow("unique sorted paths");
    });
  });

  it("removes one exact portable-manifest entry and recomputes all evidence", async () => {
    await withPackageFixture(async ({ packageRoot }) => {
      await Promise.all([
        mkdir(join(packageRoot, "resources")),
        writeFile(join(packageRoot, "Rion Studio.exe"), "executable\n")
      ]);
      await writeFile(join(packageRoot, "resources", "app.asar"), "archive\n");
      const source = toPortablePackagedElectronPackageManifest(
        await capturePackagedElectronPackageManifest(packageRoot)
      );
      await writeFile(
        join(packageRoot, "Uninstall Rion Studio.exe"),
        "uninstaller\n"
      );
      const installed = toPortablePackagedElectronPackageManifest(
        await capturePackagedElectronPackageManifest(packageRoot)
      );

      const normalized =
        removeExactPortablePackagedElectronPackageManifestEntry(
          installed,
          "Uninstall Rion Studio.exe"
        );
      expect(normalized).toEqual(source);
      expect(normalized).not.toBe(source);
      expect(Object.isFrozen(normalized)).toBe(true);
      expect(Object.isFrozen(normalized.entries)).toBe(true);
      expect(() => removeExactPortablePackagedElectronPackageManifestEntry(
        installed,
        "uninstall rion studio.exe"
      )).toThrow("does not contain exact entry");
    });
  });

  it("reports additions, deletions, content changes, and type changes", async () => {
    await withPackageFixture(async ({ packageRoot }) => {
      await Promise.all([
        writeFile(join(packageRoot, "content.bin"), "alpha"),
        writeFile(join(packageRoot, "delete-me.txt"), "delete\n"),
        writeFile(join(packageRoot, "type-entry"), "file\n")
      ]);
      const before = await capturePackagedElectronPackageManifest(packageRoot);

      await Promise.all([
        writeFile(join(packageRoot, "added.txt"), "added\n"),
        writeFile(join(packageRoot, "content.bin"), "bravo"),
        rm(join(packageRoot, "delete-me.txt")),
        rm(join(packageRoot, "type-entry"))
      ]);
      await mkdir(join(packageRoot, "type-entry"));
      const after = await capturePackagedElectronPackageManifest(packageRoot);

      const comparison = comparePackagedElectronPackageManifests(before, after);
      expect(comparison).toEqual({
        addedPaths: ["added.txt"],
        changedPaths: ["content.bin", "type-entry"],
        matches: false,
        removedPaths: ["delete-me.txt"]
      });
      expect(() => assertPackagedElectronPackageManifestUnchanged(before, after))
        .toThrow(
          "The packaged Electron directory changed: added \"added.txt\"; " +
          "removed \"delete-me.txt\"; changed \"content.bin\", \"type-entry\""
        );
    });
  });

  it("enforces explicit entry, per-file, total-file, and symlink-target byte bounds", async () => {
    await withPackageFixture(async ({ packageRoot }) => {
      await Promise.all([
        writeFile(join(packageRoot, "a.bin"), "1234"),
        writeFile(join(packageRoot, "b.bin"), "5678")
      ]);

      await expect(capturePackagedElectronPackageManifest(packageRoot, {
        maximumEntries: 1
      })).rejects.toThrow("exceeds 1 entries");
      await expect(capturePackagedElectronPackageManifest(packageRoot, {
        maximumFileBytes: 3
      })).rejects.toThrow("exceeds its byte bound");
      await expect(capturePackagedElectronPackageManifest(packageRoot, {
        maximumTotalFileBytes: 7
      })).rejects.toThrow("exceeds 7 file bytes");
      await expect(capturePackagedElectronPackageManifest(packageRoot, {
        maximumEntries: Number.MAX_SAFE_INTEGER + 1
      })).rejects.toThrow("maximumEntries must be a safe positive integer");
    });
  });

  unixIt("binds only internal relative symlinks without traversing the alias", async () => {
    await withPackageFixture(async ({ packageRoot, temporaryRoot }) => {
      await Promise.all([
        mkdir(join(packageRoot, "first-target")),
        mkdir(join(packageRoot, "second-target")),
        mkdir(join(temporaryRoot, "external-target"))
      ]);
      await writeFile(join(packageRoot, "first-target", "inside.txt"), "inside\n");
      const pointerPath = join(packageRoot, "pointer");
      await symlink("first-target", pointerPath, "dir");

      const before = await capturePackagedElectronPackageManifest(packageRoot);
      expect(before.entries.find((entry) => entry.path === "pointer")).toEqual({
        mode: await permissionMode(pointerPath),
        path: "pointer",
        target: "first-target",
        type: "symlink"
      });
      expect(before.entries.some((entry) => entry.path.startsWith("pointer/")))
        .toBe(false);
      await expect(capturePackagedElectronPackageManifest(packageRoot, {
        maximumSymlinkTargetBytes: 1
      })).rejects.toThrow("exceeds its target byte bound");

      await unlink(pointerPath);
      await symlink("second-target", pointerPath, "dir");
      const after = await capturePackagedElectronPackageManifest(packageRoot);
      expect(comparePackagedElectronPackageManifests(before, after).changedPaths)
        .toEqual(["pointer"]);

      await unlink(pointerPath);
      await symlink("../external-target", pointerPath, "dir");
      await expect(capturePackagedElectronPackageManifest(packageRoot)).rejects
        .toThrow("escapes the package root");

      await unlink(pointerPath);
      await createDirectorySymlink(
        join(temporaryRoot, "external-target"),
        pointerPath
      );
      await expect(capturePackagedElectronPackageManifest(packageRoot)).rejects
        .toThrow("has an absolute target");
    });
  });

  unixIt("rejects hard-linked files and detects permission-only changes", async () => {
    await withPackageFixture(async ({ packageRoot }) => {
      const executablePath = join(packageRoot, "runtime-helper");
      const aliasPath = join(packageRoot, "runtime-helper-alias");
      await writeFile(executablePath, "helper\n");
      await link(executablePath, aliasPath);
      await expect(capturePackagedElectronPackageManifest(packageRoot)).rejects
        .toThrow("must have exactly one directory entry");

      await unlink(aliasPath);
      await chmod(executablePath, 0o644);
      const before = await capturePackagedElectronPackageManifest(packageRoot);
      await chmod(executablePath, 0o755);
      const after = await capturePackagedElectronPackageManifest(packageRoot);
      expect(comparePackagedElectronPackageManifests(before, after).changedPaths)
        .toEqual(["runtime-helper"]);
    });
  });

  it("rejects a symlink or junction in place of the package root", async () => {
    await withPackageFixture(async ({ packageRoot, temporaryRoot }) => {
      const alias = join(temporaryRoot, "package-alias");
      await createDirectorySymlink(packageRoot, alias);
      await expect(capturePackagedElectronPackageManifest(alias)).rejects
        .toThrow("root must be a real directory");
    });
  });

  unixIt("rejects a file-to-directory race after opening the no-follow handle", async () => {
    await withPackageFixture(async ({ packageRoot }) => {
      const racedPath = join(packageRoot, "raced-entry");
      await writeFile(racedPath, "opened bytes\n");
      fileOpenRace.afterOpen = async (openedPath) => {
        if (openedPath !== racedPath) return;
        fileOpenRace.afterOpen = undefined;
        await rename(racedPath, `${racedPath}.original`);
        await mkdir(racedPath);
      };
      try {
        await expect(capturePackagedElectronPackageManifest(packageRoot)).rejects
          .toThrow("changed while its manifest was captured");
      } finally {
        fileOpenRace.afterOpen = undefined;
      }
    });
  });
});

async function withPackageFixture(
  run: (fixture: Readonly<{ packageRoot: string; temporaryRoot: string }>) => Promise<void>
) {
  const temporaryLink = await mkdtemp(join(tmpdir(), "rion-package-manifest-"));
  const temporaryRoot = await realpath(temporaryLink);
  const packageRoot = join(temporaryRoot, "package");
  try {
    await mkdir(packageRoot);
    await run({ packageRoot, temporaryRoot });
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

function createDirectorySymlink(target: string, path: string) {
  return symlink(target, path, process.platform === "win32" ? "junction" : "dir");
}

function sha256(source: Buffer) {
  return createHash("sha256").update(source).digest("hex");
}

async function permissionMode(path: string) {
  return Number((await lstat(path, { bigint: true })).mode & 0o7777n);
}
