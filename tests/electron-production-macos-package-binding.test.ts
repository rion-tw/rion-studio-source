import { createPackage } from "@electron/asar";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  createVerifiedMacosPackageBinding,
  verifyMacosDistributionPackage,
  verifyMacosUpdaterArchive
} from "../scripts/electronProductionMacosPackageBinding.mjs";
import {
  capturePackagedElectronPackageManifest,
  summarizePackagedElectronPackageManifest
} from "../scripts/packagedElectronPackageManifest.mjs";

const execFileAsync = promisify(execFile);
const VERSION = "23.4.5";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("macOS production candidate package binding", () => {
  it.runIf(process.platform === "darwin")(
    "extracts the tar and mounts the DMG read-only against one package manifest",
    async () => {
      const root = await temporaryDirectory();
      const packageRoot = join(root, "package-root");
      const applicationPath = join(packageRoot, "Rion Studio.app");
      const resourcesPath = join(applicationPath, "Contents", "Resources");
      const asarSource = join(root, "asar-source");
      const artifactPath = join(root, "Rion.Studio-mac.app.tar.gz");
      const distributionPath = join(root, "Rion.Studio-mac.dmg");
      const mismatchedDistributionPath = join(root, "mismatched-mac.dmg");
      await Promise.all([
        mkdir(resourcesPath, { recursive: true }),
        mkdir(asarSource, { recursive: true })
      ]);
      await writeFile(
        join(asarSource, "package.json"),
        `${JSON.stringify({ name: "rion-native-binding-fixture", version: VERSION })}\n`
      );
      await createPackage(asarSource, join(resourcesPath, "app.asar"));
      await writeFile(
        join(applicationPath, "Contents", "fixture.bin"),
        "retained-appkit-chromium-fixture"
      );
      const expectedPackageManifest = summarizePackagedElectronPackageManifest(
        await capturePackagedElectronPackageManifest(applicationPath)
      );
      await execFileAsync(
        "/usr/bin/tar",
        [
          "-czf",
          artifactPath,
          "-C",
          packageRoot,
          "Rion Studio.app"
        ],
        { env: { ...process.env, COPYFILE_DISABLE: "1" } }
      );
      await createDmg(packageRoot, distributionPath);

      const packageVerifier = async (candidateApplicationPath: string) => ({
        resourcesPath: join(candidateApplicationPath, "Contents", "Resources")
      });
      const verificationInput = {
        environment: process.env,
        expectedPackageManifest,
        expectedVersion: VERSION,
        packageVerifier
      };
      await expect(verifyMacosUpdaterArchive({
        ...verificationInput,
        artifactPath
      })).resolves.toBeUndefined();
      await expect(createVerifiedMacosPackageBinding({
        ...verificationInput,
        artifactPath,
        distributionPath
      })).resolves.toMatchObject({
        applicationBundle: "Rion Studio.app",
        artifact: { fileName: "Rion.Studio-mac.app.tar.gz" },
        distribution: { fileName: "Rion.Studio-mac.dmg" },
        packageManifest: expectedPackageManifest,
        verificationKind: "safe-tar-extraction-and-read-only-dmg-mount-v2"
      });

      const unexpectedPath = join(applicationPath, "Contents", "unexpected.bin");
      await writeFile(unexpectedPath, "unexpected-distribution-content");
      await createDmg(packageRoot, mismatchedDistributionPath);
      await rm(unexpectedPath);
      await expect(verifyMacosDistributionPackage({
        ...verificationInput,
        distributionPath: mismatchedDistributionPath
      })).rejects.toThrow(
        "distribution package manifest does not match the black-box package"
      );
    },
    60_000
  );
});

async function createDmg(sourceDirectory: string, outputPath: string): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await execFileAsync("/usr/bin/hdiutil", [
    "create",
    "-quiet",
    "-volname",
    "Rion Studio",
    "-srcfolder",
    sourceDirectory,
    "-format",
    "UDZO",
    outputPath
  ]);
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(
    join(tmpdir(), "rion-electron-macos-package-binding-")
  );
  temporaryDirectories.push(directory);
  return directory;
}
