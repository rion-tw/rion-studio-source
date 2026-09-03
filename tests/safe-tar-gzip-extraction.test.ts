import { createWriteStream } from "node:fs";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { createGzip } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import { restoreElectronUnsignedInputArchive } from
  "../scripts/restoreElectronUnsignedInputArchive.mjs";
import { extractSafeTarGzipSubtree } from
  "../scripts/safeTarGzipExtraction.mjs";

interface TarFixtureHeader {
  linkname?: string;
  mode?: number;
  name: string;
  type?: string;
}

interface TarFixturePack extends NodeJS.ReadableStream {
  entry(
    header: TarFixtureHeader,
    body: Buffer,
    callback: (error?: Error | null) => void
  ): void;
  finalize(): void;
}

const require = createRequire(import.meta.url);
const tarStream = require("tar-stream") as { pack(): TarFixturePack };
const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("safe tar-gzip subtree extraction", () => {
  it("extracts one exact archive root into a create-new destination", async () => {
    const root = await temporaryDirectory();
    const archivePath = path.join(root, "valid.tar.gz");
    const outputParent = path.join(root, "output");
    const destinationPath = path.join(outputParent, "electron");
    await mkdir(outputParent);
    await writeTarGzip(archivePath, [
      directory("release/electron"),
      directory("release/electron/package"),
      file("release/electron/package/app.bin", "chromium-package")
    ]);

    const summary = await extractSafeTarGzipSubtree({
      archivePath,
      archiveRoot: "release/electron",
      destinationPath
    });

    await expect(readFile(
      path.join(destinationPath, "package", "app.bin"),
      "utf8"
    )).resolves.toBe("chromium-package");
    expect(summary).toMatchObject({
      archiveRoot: "release/electron",
      destinationPath: await realpath(destinationPath),
      directoryCount: 2,
      entryCount: 3,
      regularFileBytes: 16,
      regularFileCount: 1,
      symlinkCount: 0
    });
    expect(summary.archiveSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("restores the unsigned-input CLI contract without retaining archive prefixes", async () => {
    const root = await temporaryDirectory();
    const archivePath = path.join(root, "unsigned.tar.gz");
    const outputParent = path.join(root, "restore", "release");
    const destinationPath = path.join(outputParent, "electron");
    await mkdir(outputParent, { recursive: true });
    await writeTarGzip(archivePath, [
      directory("release/electron"),
      file("release/electron/Rion.Studio-mac.dmg", "dmg-fixture")
    ]);

    await expect(restoreElectronUnsignedInputArchive([
      "--archive",
      archivePath,
      "--destination",
      destinationPath
    ])).resolves.toMatchObject({ archiveRoot: "release/electron" });
    await expect(readFile(
      path.join(destinationPath, "Rion.Studio-mac.dmg"),
      "utf8"
    )).resolves.toBe("dmg-fixture");
    await expect(access(path.join(destinationPath, "release"))).rejects.toThrow();
  });

  it.runIf(process.platform !== "win32")(
    "accepts the exact production tar command with a long native archive path",
    async () => {
      const root = await temporaryDirectory();
      const sourceRoot = path.join(root, "unsigned-input");
      const archivePath = path.join(root, "production.tar.gz");
      const outputParent = path.join(root, "output");
      const destinationPath = path.join(outputParent, "electron");
      const firstLongSegment = "framework-".padEnd(180, "a");
      const secondLongSegment = "resources-".padEnd(180, "b");
      const fixturePath = path.join(
        sourceRoot,
        "release",
        "electron",
        firstLongSegment,
        secondLongSegment,
        "app.bin"
      );
      await mkdir(path.dirname(fixturePath), { recursive: true });
      await mkdir(outputParent);
      await writeFile(fixturePath, "long-electron-path");
      await execFileAsync(
        "tar",
        [
          "-C",
          sourceRoot,
          "-czf",
          archivePath,
          "release/electron"
        ],
        { env: { ...process.env, COPYFILE_DISABLE: "1" } }
      );

      await expect(extractSafeTarGzipSubtree({
        archivePath,
        archiveRoot: "release/electron",
        destinationPath
      })).resolves.toMatchObject({ regularFileCount: 1 });
      await expect(readFile(path.join(
        destinationPath,
        firstLongSegment,
        secondLongSegment,
        "app.bin"
      ), "utf8")).resolves.toBe("long-electron-path");
    }
  );

  it.each([
    {
      entry: file("release/electron/../../scripts/pwn", "escape"),
      label: "dot-segment traversal"
    },
    {
      entry: file("/release/electron/pwn", "escape"),
      label: "absolute member"
    },
    {
      entry: file("release\\electron\\pwn", "escape"),
      label: "backslash member"
    },
    {
      entry: archiveEntry({
        linkname: "release/electron/target",
        mode: 0o644,
        name: "release/electron/hardlink",
        type: "link"
      }),
      label: "hardlink"
    },
    {
      entry: archiveEntry({
        mode: 0o644,
        name: "release/electron/pipe",
        type: "fifo"
      }),
      label: "special file"
    },
    {
      entry: file("release/electron-escape/pwn", "escape"),
      label: "lookalike root"
    },
    {
      entry: file("release/._electron", "apple-double"),
      label: "root-adjacent AppleDouble metadata"
    }
  ])("rejects $label before any destination is committed", async ({ entry }) => {
    const root = await temporaryDirectory();
    const archivePath = path.join(root, "malicious.tar.gz");
    const outputParent = path.join(root, "output");
    const destinationPath = path.join(outputParent, "electron");
    const sentinelPath = path.join(root, "sentinel.txt");
    await mkdir(outputParent);
    await writeFile(sentinelPath, "untouched");
    await writeTarGzip(archivePath, [directory("release/electron"), entry]);

    await expect(extractSafeTarGzipSubtree({
      archivePath,
      archiveRoot: "release/electron",
      destinationPath
    })).rejects.toThrow(/safe-tar/iu);
    await expect(access(destinationPath)).rejects.toThrow();
    await expect(readFile(sentinelPath, "utf8")).resolves.toBe("untouched");
  });

  it("rejects duplicate case-folded paths without overwriting the first file", async () => {
    const root = await temporaryDirectory();
    const archivePath = path.join(root, "collision.tar.gz");
    const outputParent = path.join(root, "output");
    const destinationPath = path.join(outputParent, "electron");
    await mkdir(outputParent);
    await writeTarGzip(archivePath, [
      directory("release/electron"),
      file("release/electron/App.bin", "first"),
      file("release/electron/app.bin", "second")
    ]);

    await expect(extractSafeTarGzipSubtree({
      archivePath,
      archiveRoot: "release/electron",
      destinationPath
    })).rejects.toThrow("collide on a case-insensitive filesystem");
    await expect(access(destinationPath)).rejects.toThrow();
  });

  it("rejects Unicode normalization collisions", async () => {
    const root = await temporaryDirectory();
    const archivePath = path.join(root, "unicode-collision.tar.gz");
    const outputParent = path.join(root, "output");
    const destinationPath = path.join(outputParent, "electron");
    await mkdir(outputParent);
    await writeTarGzip(archivePath, [
      directory("release/electron"),
      file("release/electron/caf\u00e9.bin", "first"),
      file("release/electron/cafe\u0301.bin", "second")
    ]);

    await expect(extractSafeTarGzipSubtree({
      archivePath,
      archiveRoot: "release/electron",
      destinationPath
    })).rejects.toThrow("collide on a case-insensitive filesystem");
    await expect(access(destinationPath)).rejects.toThrow();
  });

  it("rejects a repeated trailing-slash root directory", async () => {
    const root = await temporaryDirectory();
    const archivePath = path.join(root, "repeated-root.tar.gz");
    const outputParent = path.join(root, "output");
    const destinationPath = path.join(outputParent, "electron");
    await mkdir(outputParent);
    await writeTarGzip(archivePath, [
      directory("release/electron"),
      directory("release/electron"),
      file("release/electron/app.bin", "package")
    ]);

    await expect(extractSafeTarGzipSubtree({
      archivePath,
      archiveRoot: "release/electron",
      destinationPath
    })).rejects.toThrow("repeats member");
    await expect(access(destinationPath)).rejects.toThrow();
  });

  it("refuses a child entry whose declared ancestor is a symlink", async () => {
    const root = await temporaryDirectory();
    const archivePath = path.join(root, "symlink-ancestor.tar.gz");
    const outputParent = path.join(root, "output");
    const destinationPath = path.join(outputParent, "electron");
    await mkdir(outputParent);
    await writeTarGzip(archivePath, [
      directory("release/electron"),
      directory("release/electron/real"),
      symlinkEntry("release/electron/link", "real"),
      file("release/electron/link/pwn", "escape")
    ]);

    await expect(extractSafeTarGzipSubtree({
      archivePath,
      archiveRoot: "release/electron",
      destinationPath
    })).rejects.toThrow("undeclared or non-directory ancestor");
    await expect(access(destinationPath)).rejects.toThrow();
  });

  it.each(["../../outside", "C:/outside"])(
    "rejects unsafe or escaping symlink target %s",
    async (linkTarget) => {
      const root = await temporaryDirectory();
      const archivePath = path.join(root, "escaping-symlink.tar.gz");
      const outputParent = path.join(root, "output");
      const destinationPath = path.join(outputParent, "electron");
      await mkdir(outputParent);
      await writeTarGzip(archivePath, [
        directory("release/electron"),
        symlinkEntry("release/electron/link", linkTarget)
      ]);

      await expect(extractSafeTarGzipSubtree({
        archivePath,
        archiveRoot: "release/electron",
        destinationPath
      })).rejects.toThrow(/outside archive root|unsafe target/iu);
      await expect(access(destinationPath)).rejects.toThrow();
    }
  );

  it.runIf(process.platform !== "win32")(
    "preserves a relative symlink that remains inside the archive root",
    async () => {
      const root = await temporaryDirectory();
      const archivePath = path.join(root, "internal-symlink.tar.gz");
      const outputParent = path.join(root, "output");
      const destinationPath = path.join(outputParent, "electron");
      await mkdir(outputParent);
      await writeTarGzip(archivePath, [
        directory("release/electron"),
        directory("release/electron/Versions"),
        directory("release/electron/Versions/A"),
        file("release/electron/Versions/A/app.bin", "package"),
        symlinkEntry("release/electron/Versions/Current", "A"),
        symlinkEntry("release/electron/app.bin", "Versions/Current/app.bin")
      ]);

      await expect(extractSafeTarGzipSubtree({
        archivePath,
        archiveRoot: "release/electron",
        destinationPath
      })).resolves.toMatchObject({ symlinkCount: 2 });
      await expect(readlink(
        path.join(destinationPath, "Versions", "Current")
      )).resolves.toBe("A");
      await expect(readFile(
        path.join(destinationPath, "app.bin"),
        "utf8"
      )).resolves.toBe("package");
    }
  );

  it("never replaces a pre-existing destination", async () => {
    const root = await temporaryDirectory();
    const archivePath = path.join(root, "valid.tar.gz");
    const outputParent = path.join(root, "output");
    const destinationPath = path.join(outputParent, "electron");
    await mkdir(destinationPath, { recursive: true });
    await writeFile(path.join(destinationPath, "sentinel.txt"), "untouched");
    await writeTarGzip(archivePath, [
      directory("release/electron"),
      file("release/electron/app.bin", "replacement")
    ]);

    await expect(extractSafeTarGzipSubtree({
      archivePath,
      archiveRoot: "release/electron",
      destinationPath
    })).rejects.toThrow("must be create-new");
    await expect(readFile(
      path.join(destinationPath, "sentinel.txt"),
      "utf8"
    )).resolves.toBe("untouched");
  });

  it.each([
    { label: "entry-count", limits: { maximumEntries: 1 } },
    { label: "file-size", limits: { maximumFileBytes: 4 } },
    { label: "expanded-byte", limits: { maximumExpandedBytes: 512 } }
  ])("enforces an overridden $label bound without committing output", async ({ limits }) => {
    const root = await temporaryDirectory();
    const archivePath = path.join(root, "bounded.tar.gz");
    const outputParent = path.join(root, "output");
    const destinationPath = path.join(outputParent, "electron");
    await mkdir(outputParent);
    await writeTarGzip(archivePath, [
      directory("release/electron"),
      file("release/electron/app.bin", "too-large")
    ]);

    await expect(extractSafeTarGzipSubtree({
      archivePath,
      archiveRoot: "release/electron",
      destinationPath,
      limits
    })).rejects.toThrow(/exceeds/iu);
    await expect(access(destinationPath)).rejects.toThrow();
  });

  it("rejects a corrupt gzip without committing output", async () => {
    const root = await temporaryDirectory();
    const archivePath = path.join(root, "corrupt.tar.gz");
    const outputParent = path.join(root, "output");
    const destinationPath = path.join(outputParent, "electron");
    await mkdir(outputParent);
    await writeFile(archivePath, "not-a-gzip-stream");

    await expect(extractSafeTarGzipSubtree({
      archivePath,
      archiveRoot: "release/electron",
      destinationPath
    })).rejects.toThrow();
    await expect(access(destinationPath)).rejects.toThrow();
  });
});

function directory(name: string): TarFixtureEntry {
  return { body: Buffer.alloc(0), header: { mode: 0o755, name, type: "directory" } };
}

function file(name: string, body: string): TarFixtureEntry {
  return { body: Buffer.from(body), header: { mode: 0o644, name, type: "file" } };
}

function symlinkEntry(name: string, linkname: string): TarFixtureEntry {
  return {
    body: Buffer.alloc(0),
    header: { linkname, mode: 0o777, name, type: "symlink" }
  };
}

function archiveEntry(header: TarFixtureHeader): TarFixtureEntry {
  return { body: Buffer.alloc(0), header };
}

interface TarFixtureEntry {
  body: Buffer;
  header: TarFixtureHeader;
}

async function writeTarGzip(
  archivePath: string,
  entries: TarFixtureEntry[]
): Promise<void> {
  const pack = tarStream.pack();
  const gzip = createGzip();
  const output = createWriteStream(archivePath, { flags: "wx" });
  const completion = new Promise<void>((resolve, reject) => {
    pack.once("error", reject);
    gzip.once("error", reject);
    output.once("error", reject);
    output.once("close", resolve);
  });
  pack.pipe(gzip).pipe(output);
  for (const entry of entries) {
    await new Promise<void>((resolve, reject) => {
      pack.entry(entry.header, entry.body, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
  pack.finalize();
  await completion;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "rion-safe-tar-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
