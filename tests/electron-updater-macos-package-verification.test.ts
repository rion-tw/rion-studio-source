import { createPackage } from "@electron/asar";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { createGzip } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import { captureStableBoundedFileIdentity } from
  "../scripts/electronProductionCandidateAssetBinding.mjs";
import {
  assertElectronUpdaterMacosPackageVerification,
  verifyElectronUpdaterMacosPackage
} from "../scripts/electronUpdaterMacosPackageVerification.mjs";

interface TarFixturePack extends NodeJS.ReadableStream {
  entry(
    header: Readonly<{ mode: number; name: string; type: string }>,
    body: Buffer,
    callback: (error?: Error | null) => void
  ): void;
  finalize(): void;
}

const require = createRequire(import.meta.url);
const tarStream = require("tar-stream") as { pack(): TarFixturePack };
const temporaryDirectories: string[] = [];
const VERSION = "23.4.0";

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("macOS updater package verification", () => {
  it.runIf(process.platform !== "win32")(
    "binds the exact signed archive to the verified unpacked AppKit package",
    async () => {
      const fixture = await createFixture();
      const verifiedApplications: string[] = [];
      const evidence = await verifyElectronUpdaterMacosPackage({
        artifactPath: fixture.artifactPath,
        expectedArtifact: fixture.artifactIdentity,
        expectedVersion: VERSION,
        packageVerifier: async (applicationPath) => {
          verifiedApplications.push(applicationPath);
          await expect(readFile(
            path.join(
              applicationPath,
              "Contents",
              "Resources",
              "native",
              "rion-core.node"
            ),
            "utf8"
          )).resolves.toBe("retained-appkit-native-addon\n");
          return {
            resourcesPath: path.join(applicationPath, "Contents", "Resources")
          };
        },
        referenceApplicationPath: fixture.applicationPath
      });

      expect(verifiedApplications).toHaveLength(2);
      expect(verifiedApplications[0]).toBe(fixture.applicationPath);
      expect(verifiedApplications[1]).not.toBe(fixture.applicationPath);
      expect(evidence).toMatchObject({
        schemaVersion: 1,
        kind: "rion-electron-updater-macos-package-verification",
        verificationKind:
          "safe-tar-extraction-production-electron-package-v1",
        applicationBundle: "Rion Studio.app",
        expectedVersion: VERSION,
        artifact: {
          fileName: "Rion.Studio-mac.app.tar.gz",
          bytes: fixture.artifactIdentity.bytes,
          sha256: fixture.artifactIdentity.sha256
        }
      });
      expect(() => assertElectronUpdaterMacosPackageVerification(evidence, {
        artifact: fixture.artifactIdentity,
        version: VERSION
      })).not.toThrow();
    }
  );

  it.runIf(process.platform !== "win32")(
    "binds evidence to the exact archive handle consumed by safe extraction",
    async () => {
      const fixture = await createFixture("divergent-native-addon\n");
      const expectedArchivePath = path.join(fixture.root, "expected-archive.tar.gz");
      const verifiedArchivePath = path.join(fixture.root, "verified-archive.tar.gz");
      await rename(fixture.artifactPath, expectedArchivePath);
      await writeApplicationArchive(
        verifiedArchivePath,
        fixture.asar,
        "retained-appkit-native-addon\n"
      );
      await rename(expectedArchivePath, fixture.artifactPath);
      let verifierCalls = 0;

      await expect(verifyElectronUpdaterMacosPackage({
        artifactPath: fixture.artifactPath,
        expectedArtifact: fixture.artifactIdentity,
        expectedVersion: VERSION,
        packageVerifier: async (applicationPath) => {
          verifierCalls += 1;
          if (verifierCalls === 1) {
            await rename(fixture.artifactPath, expectedArchivePath);
            await rename(verifiedArchivePath, fixture.artifactPath);
          } else if (verifierCalls === 2) {
            await rename(fixture.artifactPath, verifiedArchivePath);
            await rename(expectedArchivePath, fixture.artifactPath);
          }
          return {
            resourcesPath: path.join(applicationPath, "Contents", "Resources")
          };
        },
        referenceApplicationPath: fixture.applicationPath
      })).rejects.toThrow(
        "safely extracted macOS updater archive does not match its signed-input receipt"
      );
    }
  );

  it.runIf(process.platform !== "win32")(
    "rejects an archive whose extracted package diverges from the reference",
    async () => {
      const fixture = await createFixture("divergent-native-addon\n");
      await expect(verifyElectronUpdaterMacosPackage({
        artifactPath: fixture.artifactPath,
        expectedArtifact: fixture.artifactIdentity,
        expectedVersion: VERSION,
        packageVerifier: async (applicationPath) => ({
          resourcesPath: path.join(applicationPath, "Contents", "Resources")
        }),
        referenceApplicationPath: fixture.applicationPath
      })).rejects.toThrow(
        "does not match the verified unpacked application"
      );
    }
  );

  it.runIf(process.platform !== "win32")(
    "rejects an archive identity that differs from the signed-input receipt",
    async () => {
      const fixture = await createFixture();
      await expect(verifyElectronUpdaterMacosPackage({
        artifactPath: fixture.artifactPath,
        expectedArtifact: {
          ...fixture.artifactIdentity,
          sha256: createHash("sha256").update("another archive").digest("hex")
        },
        expectedVersion: VERSION,
        packageVerifier: async (applicationPath) => ({
          resourcesPath: path.join(applicationPath, "Contents", "Resources")
        }),
        referenceApplicationPath: fixture.applicationPath
      })).rejects.toThrow("does not match its signed-input receipt");
    }
  );

  it("fails closed when verification evidence is rebound to another artifact", () => {
    const evidence = {
      schemaVersion: 1,
      kind: "rion-electron-updater-macos-package-verification",
      verificationKind: "safe-tar-extraction-production-electron-package-v1",
      applicationBundle: "Rion Studio.app",
      expectedVersion: VERSION,
      artifact: {
        bytes: 123,
        fileName: "Rion.Studio-mac.app.tar.gz",
        sha256: "a".repeat(64)
      },
      packageManifest: {
        directoryCount: 1,
        entryCount: 2,
        regularFileBytes: 10,
        regularFileCount: 1,
        schemaVersion: 1,
        sha256: "b".repeat(64),
        symlinkCount: 0
      }
    };
    expect(() => assertElectronUpdaterMacosPackageVerification(evidence, {
      artifact: { bytes: 123, sha256: "c".repeat(64) },
      version: VERSION
    })).toThrow("does not match the prepared input");
  });
});

async function createFixture(
  archivedAddon = "retained-appkit-native-addon\n"
) {
  const root = await mkdtemp(path.join(tmpdir(), "rion-updater-macos-package-test-"));
  temporaryDirectories.push(root);
  const applicationPath = path.join(root, "Rion Studio.app");
  const resourcesPath = path.join(applicationPath, "Contents", "Resources");
  const nativePath = path.join(resourcesPath, "native");
  const asarSource = path.join(root, "asar-source");
  await Promise.all([
    mkdir(nativePath, { recursive: true }),
    mkdir(asarSource, { recursive: true })
  ]);
  await writeFile(
    path.join(asarSource, "package.json"),
    `${JSON.stringify({ name: "rion-updater-package-fixture", version: VERSION })}\n`
  );
  const asarPath = path.join(resourcesPath, "app.asar");
  const addonPath = path.join(nativePath, "rion-core.node");
  await createPackage(asarSource, asarPath);
  await writeFile(addonPath, "retained-appkit-native-addon\n");
  await Promise.all([
    chmod(applicationPath, 0o755),
    chmod(path.join(applicationPath, "Contents"), 0o755),
    chmod(resourcesPath, 0o755),
    chmod(nativePath, 0o755),
    chmod(asarPath, 0o644),
    chmod(addonPath, 0o644)
  ]);

  const asar = await readFile(asarPath);
  const artifactPath = path.join(root, "Rion.Studio-mac.app.tar.gz");
  await writeApplicationArchive(artifactPath, asar, archivedAddon);
  const artifactIdentity = {
    path: artifactPath,
    ...await captureStableBoundedFileIdentity(
      artifactPath,
      1024 * 1024 * 1024,
      "test updater archive"
    )
  };
  return { applicationPath, artifactIdentity, artifactPath, asar, root };
}

async function writeApplicationArchive(
  artifactPath: string,
  asar: Buffer,
  addon: string
) {
  await writeTarGzip(artifactPath, [
    directory("Rion Studio.app"),
    directory("Rion Studio.app/Contents"),
    directory("Rion Studio.app/Contents/Resources"),
    directory("Rion Studio.app/Contents/Resources/native"),
    file("Rion Studio.app/Contents/Resources/app.asar", asar),
    file(
      "Rion Studio.app/Contents/Resources/native/rion-core.node",
      Buffer.from(addon, "utf8")
    )
  ]);
}

function directory(name: string) {
  return {
    body: Buffer.alloc(0),
    header: { mode: 0o755, name, type: "directory" }
  };
}

function file(name: string, body: Buffer) {
  return { body, header: { mode: 0o644, name, type: "file" } };
}

async function writeTarGzip(
  archivePath: string,
  entries: Array<ReturnType<typeof directory> | ReturnType<typeof file>>
) {
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
