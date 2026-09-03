import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  capturePackagedElectronPackageManifest,
  createPortablePackagedElectronPackageManifest,
  summarizePackagedElectronPackageManifest,
  toPortablePackagedElectronPackageManifest,
  type PackagedElectronPackageManifestEntry
} from "../scripts/packagedElectronPackageManifest.mjs";
import {
  assertWindowsElectronInstallerPayloadProof,
  serializeWindowsElectronInstallerPayloadProof,
  WINDOWS_ELECTRON_INSTALLER_PAYLOAD_PROOF_NAME
} from "../scripts/windowsElectronInstallerPayloadProofContract.mjs";
import {
  assertWindowsInstallerPayloadProofMatchesBlackBox,
  buildWindowsElectronInstallerPayloadProof,
  captureStableRegularFileArtifact,
  readAndVerifyWindowsElectronInstallerPayloadProof,
  readAndVerifyWindowsForbiddenSourcePathList,
  readAndVerifyWindowsIsolatedProfileResult,
  writeWindowsForbiddenSourcePathList
} from "../scripts/windowsElectronInstallerPayloadProof.mjs";
import {
  createWindowsIsolatedProfileCommandInvocationSha256,
  serializeWindowsIsolatedProfileResult,
  WINDOWS_ISOLATED_PROFILE_RESULT_NAME
} from "../scripts/windowsIsolatedProfileResultContract.mjs";

const SOURCE_SHA = "a".repeat(40);
const VERSION = "23.4.5";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("Windows Electron installer payload proof", () => {
  it("binds the exact ordered isolated command invocation", () => {
    const input = {
      arguments: ["-NoProfile", "-File", "C:\\proof\\install.ps1"],
      commandPath: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      workingDirectory: "C:\\proof\\gate"
    };
    expect(createWindowsIsolatedProfileCommandInvocationSha256(input)).toBe(sha256([
      "rion-windows-isolated-command-invocation-v1",
      input.commandPath,
      input.workingDirectory,
      ...input.arguments
    ].join("\0")));
    expect(createWindowsIsolatedProfileCommandInvocationSha256({
      ...input,
      arguments: [...input.arguments].reverse()
    })).not.toBe(createWindowsIsolatedProfileCommandInvocationSha256(input));
  });

  it("writes and verifies the exact canonical forbidden source inventory", async () => {
    const root = await temporaryDirectory();
    const sourceApplicationPath = join(root, "win-unpacked");
    const listPath = join(root, "forbidden-source-files.json");
    await mkdir(join(sourceApplicationPath, "resources"), { recursive: true });
    await Promise.all([
      writeFile(join(sourceApplicationPath, "Rion Studio.exe"), "main"),
      writeFile(join(sourceApplicationPath, "resources", "app.asar"), "asar")
    ]);

    const written = await writeWindowsForbiddenSourcePathList({
      outputPath: listPath,
      sourceApplicationPath
    });
    await expect(readAndVerifyWindowsForbiddenSourcePathList({
      listPath,
      sourceApplicationPath
    })).resolves.toEqual(written);
    const canonicalSourceApplicationPath = await realpath(sourceApplicationPath);
    expect(written.paths).toContain(canonicalSourceApplicationPath);
    expect(written.paths).toContain(join(canonicalSourceApplicationPath, "resources"));
    expect(written.paths).toContain(
      join(canonicalSourceApplicationPath, "resources", "app.asar")
    );

    await writeFile(listPath, `${JSON.stringify(written.paths, null, 2)}\n`);
    await expect(readAndVerifyWindowsForbiddenSourcePathList({
      listPath,
      sourceApplicationPath
    })).rejects.toThrow("not canonical JSON");

    await writeFile(listPath, `${JSON.stringify(written.paths.slice(1))}\n`);
    await expect(readAndVerifyWindowsForbiddenSourcePathList({
      listPath,
      sourceApplicationPath
    })).rejects.toThrow("does not match the source package inventory");
  });

  it("keeps the canonical version-one proof encoding stable", () => {
    const proof = syntheticProof();
    const source = serializeWindowsElectronInstallerPayloadProof(proof);

    expect(source.at(-1)).toBe(10);
    expect(sha256(source)).toBe(
      "998189c068cd93f7679af7be96432384aaf8324f498a407304a5cf62dc26f79f"
    );
    expect(Object.isFrozen(assertWindowsElectronInstallerPayloadProof(proof))).toBe(true);
  });

  it("recomputes the normalized installed tree and cross-binds black-box components", () => {
    const proof = syntheticProof();
    const sourceManifest = proof.sourcePackage.manifest;
    const entries = new Map(sourceManifest.entries.map((entry) => [entry.path, entry]));

    expect(assertWindowsInstallerPayloadProofMatchesBlackBox(proof, {
      appAsar: {
        fileName: "app.asar",
        sha256: regularEntry(entries, "resources/app.asar").sha256
      },
      appVersion: VERSION,
      executable: {
        fileName: "Rion Studio.exe",
        sha256: regularEntry(entries, "Rion Studio.exe").sha256
      },
      nativeAddon: {
        fileName: "rion-core.node",
        sha256: regularEntry(entries, "resources/native/rion-core.node").sha256
      },
      packageManifest: portableSummary(sourceManifest)
    })).toEqual(proof);

    expect(() => assertWindowsElectronInstallerPayloadProof({
      ...proof,
      comparison: {
        ...proof.comparison,
        normalizedInstalledManifest: {
          ...proof.comparison.normalizedInstalledManifest,
          sha256: "0".repeat(64)
        }
      }
    })).toThrow("invalid SHA-256");
  });

  it("rejects every installed-tree delta except the exact root uninstaller", () => {
    const proof = syntheticProof();
    const sourceManifest = proof.sourcePackage.manifest;
    const unexpectedInstalled = createPortablePackagedElectronPackageManifest([
      ...proof.installedPackage.manifest.entries,
      regularFile("unexpected.bin", "unexpected", 0o644)
    ].sort(compareEntries), proof.installedPackage.manifest.rootMode);
    expect(() => buildProofFromManifests(sourceManifest, unexpectedInstalled)).toThrow(
      "installed payload differs"
    );

    const changedInstalled = createPortablePackagedElectronPackageManifest(
      proof.installedPackage.manifest.entries.map((entry) =>
        entry.path === "resources/app.asar"
          ? regularFile(entry.path, "changed", entry.mode)
          : entry),
      proof.installedPackage.manifest.rootMode
    );
    expect(() => buildProofFromManifests(sourceManifest, changedInstalled)).toThrow(
      "installed payload differs"
    );

    const sourceWithUninstaller = createPortablePackagedElectronPackageManifest([
      ...sourceManifest.entries,
      regularFile("Uninstall Rion Studio.exe", "uninstaller", 0o755)
    ].sort(compareEntries), sourceManifest.rootMode);
    expect(() => buildProofFromManifests(
      sourceWithUninstaller,
      proof.installedPackage.manifest
    )).toThrow("installed payload differs");
  });

  it("rejects symlinks and incorrect Authenticode or process evidence", () => {
    const proof = syntheticProof();
    const symlinkSource = createPortablePackagedElectronPackageManifest([
      ...proof.sourcePackage.manifest.entries,
      {
        mode: 0o777,
        path: "linked",
        target: "resources",
        type: "symlink"
      } satisfies PackagedElectronPackageManifestEntry
    ].sort(compareEntries), proof.sourcePackage.manifest.rootMode);
    expect(() => buildProofFromManifests(
      symlinkSource,
      proof.installedPackage.manifest
    )).toThrow("must not contain symlinks");
    expect(() => assertWindowsElectronInstallerPayloadProof({
      ...proof,
      installer: { ...proof.installer, authenticodeStatus: "Valid" }
    })).toThrow("Authenticode status");
    expect(() => assertWindowsElectronInstallerPayloadProof({
      ...proof,
      isolation: {
        ...proof.isolation,
        runnerResult: {
          ...proof.isolation.runnerResult,
          totalProcesses: 4
        }
      }
    })).toThrow("total process count");
    expect(() => assertWindowsElectronInstallerPayloadProof({
      ...proof,
      isolation: {
        ...proof.isolation,
        runnerResult: {
          ...proof.isolation.runnerResult,
          attestedInputs: {
            ...proof.isolation.runnerResult.attestedInputs,
            installer: {
              ...proof.isolation.runnerResult.attestedInputs.installer,
              sha256: "f".repeat(64)
            }
          }
        }
      }
    })).toThrow("isolated installer SHA-256");
  });

  it("reads only canonical, exclusive-link proof bytes bound to current files", async () => {
    const fixture = await filesystemFixture();
    const proofPath = join(fixture.root, WINDOWS_ELECTRON_INSTALLER_PAYLOAD_PROOF_NAME);
    await writeFile(proofPath, serializeWindowsElectronInstallerPayloadProof(fixture.proof));

    await expect(readAndVerifyWindowsElectronInstallerPayloadProof({
      installerPath: fixture.installerPath,
      proofPath,
      sourceApplicationPath: fixture.sourceApplicationPath,
      sourceSha: SOURCE_SHA,
      version: VERSION
    })).resolves.toMatchObject({
      identity: {
        fileName: WINDOWS_ELECTRON_INSTALLER_PAYLOAD_PROOF_NAME
      },
      proof: {
        verdict: "passed"
      }
    });

    const canonicalSource = await readFile(proofPath, "utf8");
    const duplicateSource = canonicalSource.replace(
      '  "verdict": "passed",',
      '  "verdict": "passed",\n  "verdict": "passed",'
    );
    await writeFile(proofPath, duplicateSource);
    await expect(readAndVerifyWindowsElectronInstallerPayloadProof({
      proofPath
    })).rejects.toThrow("not canonical JSON");

    await writeFile(proofPath, canonicalSource);
    const hardLinkPath = join(fixture.root, "payload-proof-hard-link.json");
    await link(proofPath, hardLinkPath);
    await expect(readAndVerifyWindowsElectronInstallerPayloadProof({
      proofPath
    })).rejects.toThrow("exclusively linked regular file");
    await unlink(hardLinkPath);

    await writeFile(fixture.installerPath, "different installer");
    await expect(readAndVerifyWindowsElectronInstallerPayloadProof({
      installerPath: fixture.installerPath,
      proofPath
    })).rejects.toThrow("does not match the current installer");
  });

  it("accepts only a create-new measured isolated-profile result", async () => {
    const root = await temporaryDirectory();
    const resultPath = join(root, WINDOWS_ISOLATED_PROFILE_RESULT_NAME);
    const result = successfulIsolationResult();
    const binding = successfulIsolationBinding();
    await writeFile(resultPath, serializeWindowsIsolatedProfileResult(result));

    await expect(readAndVerifyWindowsIsolatedProfileResult(resultPath, binding)).resolves
      .toEqual(result);

    await writeFile(resultPath, JSON.stringify({ ...result, unexpected: true }));
    await expect(readAndVerifyWindowsIsolatedProfileResult(resultPath, binding)).rejects
      .toThrow("unexpected schema");

    await writeFile(resultPath, JSON.stringify(result));
    await expect(readAndVerifyWindowsIsolatedProfileResult(resultPath, binding)).rejects
      .toThrow("not canonical JSON");

    const canonicalResult = serializeWindowsIsolatedProfileResult(result).toString("utf8");
    await writeFile(resultPath, canonicalResult.replace(
      '  "totalProcesses": 3',
      '  "totalProcesses": 3,\n  "totalProcesses": 3'
    ));
    await expect(readAndVerifyWindowsIsolatedProfileResult(resultPath, binding)).rejects
      .toThrow("not canonical JSON");

    await writeFile(resultPath, serializeWindowsIsolatedProfileResult(result));
    const hardLinkPath = join(root, "isolated-profile-result-hard-link.json");
    await link(resultPath, hardLinkPath);
    await expect(readAndVerifyWindowsIsolatedProfileResult(resultPath, binding)).rejects
      .toThrow("exclusively linked regular file");
    await unlink(hardLinkPath);

    await expect(readAndVerifyWindowsIsolatedProfileResult(
      join(root, "wrong-result-name.json"),
      binding
    )).rejects.toThrow("must be named");

    await writeFile(resultPath, serializeWindowsIsolatedProfileResult(result));
    await expect(readAndVerifyWindowsIsolatedProfileResult(resultPath, {
      ...binding,
      attemptNonce: "f".repeat(32)
    })).rejects.toThrow("attempt nonce does not match");
    await expect(readAndVerifyWindowsIsolatedProfileResult(resultPath, {
      ...binding,
      commandInvocationSha256: "f".repeat(64)
    })).rejects.toThrow("command invocation does not match");
    await expect(readAndVerifyWindowsIsolatedProfileResult(resultPath, {
      ...binding,
      attestedInputs: {
        ...binding.attestedInputs,
        installer: {
          ...binding.attestedInputs.installer,
          sha256: "f".repeat(64)
        }
      }
    })).rejects.toThrow("attested inputs do not match");
  });
});

function syntheticProof() {
  const sourceManifest = createPortablePackagedElectronPackageManifest([
    regularFile("Rion Studio.exe", "main", 0o755),
    { mode: 0o755, path: "resources", type: "directory" },
    regularFile("resources/app.asar", "asar", 0o644),
    { mode: 0o755, path: "resources/native", type: "directory" },
    regularFile("resources/native/rion-core.node", "addon", 0o644)
  ], 0o755);
  const installedManifest = createPortablePackagedElectronPackageManifest([
    regularFile("Rion Studio.exe", "main", 0o755),
    regularFile("Uninstall Rion Studio.exe", "uninstaller", 0o755),
    { mode: 0o755, path: "resources", type: "directory" },
    regularFile("resources/app.asar", "asar", 0o644),
    { mode: 0o755, path: "resources/native", type: "directory" },
    regularFile("resources/native/rion-core.node", "addon", 0o644)
  ], 0o755);
  return buildProofFromManifests(sourceManifest, installedManifest);
}

function buildProofFromManifests(
  sourceManifest: ReturnType<typeof createPortablePackagedElectronPackageManifest>,
  installedManifest: ReturnType<typeof createPortablePackagedElectronPackageManifest>
) {
  return buildWindowsElectronInstallerPayloadProof({
    installedAppVersion: VERSION,
    installedManifest,
    installer: {
      bytes: 9,
      fileName: "Rion.Studio-win.exe",
      sha256: sha256("installer")
    },
    installerAuthenticodeStatus: "NotSigned",
    isolationResult: successfulIsolationResult(),
    mainAuthenticodeStatus: "NotSigned",
    sourceAppVersion: VERSION,
    sourceManifest,
    sourceSha: SOURCE_SHA,
    uninstallerAuthenticodeStatus: "NotSigned",
    version: VERSION
  });
}

async function filesystemFixture() {
  const root = await temporaryDirectory();
  const sourceApplicationPath = join(root, "win-unpacked");
  const installedApplicationPath = join(root, "installed");
  for (const applicationPath of [sourceApplicationPath, installedApplicationPath]) {
    await mkdir(join(applicationPath, "resources", "native"), { recursive: true });
    await Promise.all([
      writeFile(join(applicationPath, "Rion Studio.exe"), "main"),
      writeFile(join(applicationPath, "resources", "app.asar"), "asar"),
      writeFile(join(applicationPath, "resources", "native", "rion-core.node"), "addon")
    ]);
  }
  await writeFile(
    join(installedApplicationPath, "Uninstall Rion Studio.exe"),
    "uninstaller"
  );
  const installerPath = join(root, "Rion.Studio-win.exe");
  await writeFile(installerPath, "installer");
  const [sourceManifest, installedManifest, installer] = await Promise.all([
    capturePackagedElectronPackageManifest(sourceApplicationPath),
    capturePackagedElectronPackageManifest(installedApplicationPath),
    captureStableRegularFileArtifact(installerPath)
  ]);
  const proof = buildWindowsElectronInstallerPayloadProof({
    installedAppVersion: VERSION,
    installedManifest: toPortablePackagedElectronPackageManifest(installedManifest),
    installer,
    installerAuthenticodeStatus: "NotSigned",
    isolationResult: successfulIsolationResult(),
    mainAuthenticodeStatus: "NotSigned",
    sourceAppVersion: VERSION,
    sourceManifest: toPortablePackagedElectronPackageManifest(sourceManifest),
    sourceSha: SOURCE_SHA,
    uninstallerAuthenticodeStatus: "NotSigned",
    version: VERSION
  });
  return { installerPath, proof, root, sourceApplicationPath };
}

function portableSummary(
  manifest: ReturnType<typeof createPortablePackagedElectronPackageManifest>
) {
  return summarizePackagedElectronPackageManifest({
    ...manifest,
    packageDirectory: "portable-fixture"
  });
}

function regularEntry(
  entries: Map<string, PackagedElectronPackageManifestEntry>,
  path: string
) {
  const entry = entries.get(path);
  if (entry?.type !== "regular-file") throw new Error(`Missing fixture file ${path}`);
  return entry;
}

function regularFile(
  path: string,
  source: string,
  mode: number
): PackagedElectronPackageManifestEntry {
  return {
    bytes: Buffer.byteLength(source),
    mode,
    path,
    sha256: sha256(source),
    type: "regular-file"
  };
}

function compareEntries(
  left: PackagedElectronPackageManifestEntry,
  right: PackagedElectronPackageManifestEntry
) {
  return Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8"));
}

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "rion-windows-installer-proof-"));
  temporaryDirectories.push(directory);
  return directory;
}

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function successfulIsolationResult() {
  return {
    activeProcessesAfterRootExit: 0,
    attemptNonce: "0123456789abcdef0123456789abcdef",
    attestedInputs: {
      commandExecutable: {
        bytes: 4,
        fileName: "pwsh.exe",
        sha256: sha256("pwsh")
      },
      commandHarness: {
        bytes: 7,
        fileName: "install.ps1",
        sha256: sha256("harness")
      },
      forbiddenSourceList: {
        bytes: 8,
        fileName: "forbidden-source-files.json",
        sha256: sha256("forbidden-source-list")
      },
      installer: {
        bytes: 9,
        fileName: "Rion.Studio-win.exe",
        sha256: sha256("installer")
      }
    },
    cleanupVerified: true,
    commandExitCode: 0,
    commandInvocationSha256: sha256("command-invocation"),
    expectedTotalProcesses: 3,
    isolationKind: "temporary-local-windows-user-profile-v1",
    kind: "rion-windows-isolated-profile-result",
    schemaVersion: 1,
    totalProcesses: 3
  } as const;
}

function successfulIsolationBinding() {
  const result = successfulIsolationResult();
  return {
    attemptNonce: result.attemptNonce,
    attestedInputs: result.attestedInputs,
    commandInvocationSha256: result.commandInvocationSha256
  };
}
