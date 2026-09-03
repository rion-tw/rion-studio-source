import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { isDeepStrictEqual } from "node:util";

import {
  capturePackagedElectronPackageManifest,
  removeExactPortablePackagedElectronPackageManifestEntry,
  toPortablePackagedElectronPackageManifest
} from "./packagedElectronPackageManifest.mjs";
import {
  isUpdaterPrivateEnvironmentName,
  sanitizeUpdaterRuntimeEnvironment
} from "./runtimeEnvironmentPolicy.mjs";
import {
  assertWindowsElectronInstallerPayloadProof,
  serializeWindowsElectronInstallerPayloadProof,
  WINDOWS_ELECTRON_INSTALLER_NAME,
  WINDOWS_ELECTRON_INSTALLER_PAYLOAD_POLICY,
  WINDOWS_ELECTRON_INSTALLER_PAYLOAD_PROOF_INSTALL_MODE,
  WINDOWS_ELECTRON_INSTALLER_PAYLOAD_PROOF_ISOLATION_KIND,
  WINDOWS_ELECTRON_INSTALLER_PAYLOAD_PROOF_KIND,
  WINDOWS_ELECTRON_INSTALLER_PAYLOAD_PROOF_NAME,
  WINDOWS_ELECTRON_MAIN_EXECUTABLE_PATH,
  WINDOWS_ELECTRON_UNINSTALLER_PATH
} from "./windowsElectronInstallerPayloadProofContract.mjs";
import {
  assertWindowsIsolatedProfileResult,
  createWindowsIsolatedProfileCommandInvocationSha256,
  serializeWindowsIsolatedProfileResult,
  WINDOWS_ISOLATED_PROFILE_RESULT_NAME
} from "./windowsIsolatedProfileResultContract.mjs";
import {
  verifyPackagedElectron,
  verifyProductionElectronArchive
} from "./verifyElectronPackage.mjs";

const execFileAsync = promisify(execFile);
const MAX_INSTALLER_BYTES = 1024 * 1024 * 1024;
const MAX_COMMAND_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const MAX_COMMAND_HARNESS_BYTES = 1024 * 1024;
const MAX_FORBIDDEN_SOURCE_LIST_BYTES = 32 * 1024 * 1024;
const MAX_ISOLATION_RESULT_BYTES = 64 * 1024;
const MAX_PROOF_BYTES = 8 * 1024 * 1024;
const READ_ONLY_NO_FOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

export async function createWindowsElectronInstallerPayloadProof(input) {
  if (process.platform !== "win32") {
    throw new Error("The Windows installer payload proof can be produced only on Windows.");
  }
  assertPrivateUpdaterKeyAbsent(input.environment ?? process.env);
  const sourceApplicationPath = path.resolve(requiredString(
    input.sourceApplicationPath,
    "source application path"
  ));
  const installedApplicationPath = path.resolve(requiredString(
    input.installedApplicationPath,
    "installed application path"
  ));
  const installerPath = path.resolve(requiredString(input.installerPath, "installer path"));
  const attemptNonce = requiredAttemptNonce(input.attemptNonce);
  const commandPath = path.resolve(requiredString(input.commandPath, "command path"));
  const commandScriptPath = path.resolve(requiredString(
    input.commandScriptPath,
    "command script path"
  ));
  const forbiddenSourceFileListPath = path.resolve(requiredString(
    input.forbiddenSourceFileListPath,
    "forbidden source file list path"
  ));
  const gateRootPath = path.resolve(requiredString(input.gateRootPath, "gate root path"));
  if (installedApplicationPath !== path.join(gateRootPath, "application")) {
    throw new Error(
      "The Windows installer payload proof installation must use the exact gate child."
    );
  }
  const isolationResultPath = path.resolve(requiredString(
    input.isolationResultPath,
    "isolation result path"
  ));
  const outputPath = path.resolve(requiredString(input.outputPath, "proof output path"));
  if (path.basename(outputPath) !== WINDOWS_ELECTRON_INSTALLER_PAYLOAD_PROOF_NAME) {
    throw new Error(
      `The Windows installer payload proof output must be named ${WINDOWS_ELECTRON_INSTALLER_PAYLOAD_PROOF_NAME}.`
    );
  }
  await assertPathMissing(outputPath, "Windows installer payload proof");
  const [
    installerBefore,
    commandExecutable,
    commandHarness,
    sourceManifestBefore
  ] = await Promise.all([
    captureStableRegularFileArtifact(
      installerPath,
      MAX_INSTALLER_BYTES,
      "Windows NSIS installer"
    ),
    captureStableRegularFileArtifact(
      commandPath,
      MAX_COMMAND_EXECUTABLE_BYTES,
      "Windows isolated-profile command executable"
    ),
    captureStableRegularFileArtifact(
      commandScriptPath,
      MAX_COMMAND_HARNESS_BYTES,
      "Windows installer proof command harness"
    ),
    capturePackagedElectronPackageManifest(sourceApplicationPath)
  ]);
  const forbiddenSourceListBefore = await readAndVerifyForbiddenSourcePathListForManifest(
    forbiddenSourceFileListPath,
    sourceManifestBefore
  );
  assertArtifactName(installerBefore, WINDOWS_ELECTRON_INSTALLER_NAME, "installer");
  const commandArguments = windowsInstallerProofCommandArguments({
    artifactPath: installerPath,
    attemptNonce,
    commandScriptPath,
    forbiddenSourceFileListPath,
    gateRootPath,
    installDirectory: installedApplicationPath,
    version: input.version
  });
  const commandInvocationSha256 =
    createWindowsIsolatedProfileCommandInvocationSha256({
      arguments: commandArguments,
      commandPath,
      workingDirectory: gateRootPath
    });
  const isolationResult = await readAndVerifyWindowsIsolatedProfileResult(
    isolationResultPath,
    {
      attemptNonce,
      attestedInputs: {
        commandExecutable,
        commandHarness,
        forbiddenSourceList: forbiddenSourceListBefore.identity,
        installer: installerBefore
      },
      commandInvocationSha256
    }
  );

  const installerAuthenticode = await captureWindowsAuthenticodeArtifact(
    installerPath,
    input.environment ?? process.env
  );
  const installerAfter = await captureStableRegularFileArtifact(
    installerPath,
    MAX_INSTALLER_BYTES,
    "Windows NSIS installer"
  );
  assertAuthenticodeArtifactMatches(
    installerAuthenticode,
    installerBefore,
    "Windows NSIS installer"
  );
  assertArtifactUnchanged(installerBefore, installerAfter, "Windows NSIS installer");

  const installedManifestBefore = await capturePackagedElectronPackageManifest(
    installedApplicationPath
  );
  const [sourceLayout, installedLayout] = await Promise.all([
    verifyPackagedElectron(sourceApplicationPath),
    verifyPackagedElectron(installedApplicationPath)
  ]);
  const [sourceArchive, installedArchive] = [sourceLayout, installedLayout].map((layout) =>
    verifyProductionElectronArchive(path.join(layout.resourcesPath, "app.asar")));
  const expectedVersion = requiredString(input.version, "proof version");
  if (sourceArchive.packageVersion !== expectedVersion) {
    throw new Error("The Windows installer payload proof source ASAR version does not match.");
  }
  if (installedArchive.packageVersion !== expectedVersion) {
    throw new Error("The Windows installer payload proof installed ASAR version does not match.");
  }

  const installedUninstallerPath = path.join(
    installedApplicationPath,
    WINDOWS_ELECTRON_UNINSTALLER_PATH
  );
  const [mainArtifactBefore, uninstallerArtifactBefore] = await Promise.all([
    captureStableRegularFileArtifact(
      installedLayout.executablePath,
      MAX_INSTALLER_BYTES,
      "installed Windows executable"
    ),
    captureStableRegularFileArtifact(
      installedUninstallerPath,
      MAX_INSTALLER_BYTES,
      "installed Windows NSIS uninstaller"
    )
  ]);
  const [mainAuthenticode, uninstallerAuthenticode] = await Promise.all([
    captureWindowsAuthenticodeArtifact(
      installedLayout.executablePath,
      input.environment ?? process.env
    ),
    captureWindowsAuthenticodeArtifact(
      installedUninstallerPath,
      input.environment ?? process.env
    )
  ]);
  const [mainArtifactAfter, uninstallerArtifactAfter] = await Promise.all([
    captureStableRegularFileArtifact(
      installedLayout.executablePath,
      MAX_INSTALLER_BYTES,
      "installed Windows executable"
    ),
    captureStableRegularFileArtifact(
      installedUninstallerPath,
      MAX_INSTALLER_BYTES,
      "installed Windows NSIS uninstaller"
    )
  ]);
  assertAuthenticodeArtifactMatches(
    mainAuthenticode,
    mainArtifactBefore,
    "installed Windows executable"
  );
  assertAuthenticodeArtifactMatches(
    uninstallerAuthenticode,
    uninstallerArtifactBefore,
    "installed Windows NSIS uninstaller"
  );
  assertArtifactUnchanged(
    mainArtifactBefore,
    mainArtifactAfter,
    "installed Windows executable"
  );
  assertArtifactUnchanged(
    uninstallerArtifactBefore,
    uninstallerArtifactAfter,
    "installed Windows NSIS uninstaller"
  );
  assertArtifactName(
    uninstallerArtifactAfter,
    WINDOWS_ELECTRON_UNINSTALLER_PATH,
    "installed uninstaller"
  );

  const [sourceManifestAfter, installedManifestAfter] = await Promise.all([
    capturePackagedElectronPackageManifest(sourceApplicationPath),
    capturePackagedElectronPackageManifest(installedApplicationPath)
  ]);
  const forbiddenSourceListAfter = await readAndVerifyForbiddenSourcePathListForManifest(
    forbiddenSourceFileListPath,
    sourceManifestAfter
  );
  assertManifestUnchanged(
    sourceManifestBefore,
    sourceManifestAfter,
    "source Windows package"
  );
  assertManifestUnchanged(
    installedManifestBefore,
    installedManifestAfter,
    "installed Windows package"
  );
  assertArtifactUnchanged(
    forbiddenSourceListBefore.identity,
    forbiddenSourceListAfter.identity,
    "forbidden source-path list"
  );

  const proof = buildWindowsElectronInstallerPayloadProof({
    installedAppVersion: installedArchive.packageVersion,
    installedManifest: toPortablePackagedElectronPackageManifest(installedManifestAfter),
    installer: installerAfter,
    installerAuthenticodeStatus: installerAuthenticode.authenticodeStatus,
    isolationResult,
    mainAuthenticodeStatus: mainAuthenticode.authenticodeStatus,
    sourceAppVersion: sourceArchive.packageVersion,
    sourceManifest: toPortablePackagedElectronPackageManifest(sourceManifestAfter),
    sourceSha: input.sourceSha,
    uninstallerAuthenticodeStatus: uninstallerAuthenticode.authenticodeStatus,
    version: expectedVersion
  });
  if (
    proof.installedPackage.uninstaller.bytes !== uninstallerArtifactAfter.bytes ||
    proof.installedPackage.uninstaller.sha256 !== uninstallerArtifactAfter.sha256
  ) {
    throw new Error(
      "The Windows installer payload proof uninstaller changed while it was verified."
    );
  }
  const source = serializeWindowsElectronInstallerPayloadProof(proof);
  await writeFile(outputPath, source, { flag: "wx", mode: 0o600 });
  return Object.freeze({
    identity: Object.freeze({
      bytes: source.length,
      fileName: WINDOWS_ELECTRON_INSTALLER_PAYLOAD_PROOF_NAME,
      sha256: sha256Buffer(source)
    }),
    proof
  });
}

export function buildWindowsElectronInstallerPayloadProof(input) {
  const isolationResult = assertWindowsIsolatedProfileResult(input.isolationResult);
  const sourceManifest = input.sourceManifest;
  const installedManifest = input.installedManifest;
  const normalizedInstalledManifest =
    removeExactPortablePackagedElectronPackageManifestEntry(
      installedManifest,
      WINDOWS_ELECTRON_UNINSTALLER_PATH
    );
  const installedExecutable = requiredRegularEntry(
    installedManifest,
    WINDOWS_ELECTRON_MAIN_EXECUTABLE_PATH
  );
  const installedUninstaller = requiredRegularEntry(
    installedManifest,
    WINDOWS_ELECTRON_UNINSTALLER_PATH
  );
  return assertWindowsElectronInstallerPayloadProof({
    comparison: {
      addedPaths: [WINDOWS_ELECTRON_UNINSTALLER_PATH],
      changedPaths: [],
      normalizedInstalledManifest,
      policy: WINDOWS_ELECTRON_INSTALLER_PAYLOAD_POLICY,
      removedPaths: [],
      verdict: "identical"
    },
    installedPackage: {
      appVersion: input.installedAppVersion,
      executable: {
        authenticodeStatus: input.mainAuthenticodeStatus,
        bytes: installedExecutable.bytes,
        relativePath: WINDOWS_ELECTRON_MAIN_EXECUTABLE_PATH,
        sha256: installedExecutable.sha256
      },
      manifest: installedManifest,
      uninstaller: {
        authenticodeStatus: input.uninstallerAuthenticodeStatus,
        bytes: installedUninstaller.bytes,
        relativePath: WINDOWS_ELECTRON_UNINSTALLER_PATH,
        sha256: installedUninstaller.sha256
      }
    },
    installer: {
      authenticodeStatus: input.installerAuthenticodeStatus,
      bytes: input.installer.bytes,
      fileName: input.installer.fileName,
      sha256: input.installer.sha256
    },
    isolation: {
      applicationLaunchRequested: false,
      installMode: WINDOWS_ELECTRON_INSTALLER_PAYLOAD_PROOF_INSTALL_MODE,
      kind: WINDOWS_ELECTRON_INSTALLER_PAYLOAD_PROOF_ISOLATION_KIND,
      runnerResult: isolationResult
    },
    kind: WINDOWS_ELECTRON_INSTALLER_PAYLOAD_PROOF_KIND,
    platform: "windows-x86_64",
    schemaVersion: 1,
    sourcePackage: {
      appVersion: input.sourceAppVersion,
      manifest: sourceManifest
    },
    sourceSha: input.sourceSha,
    verdict: "passed",
    version: input.version
  });
}

export async function writeWindowsForbiddenSourcePathList(input) {
  const sourceApplicationPath = path.resolve(requiredString(
    input?.sourceApplicationPath,
    "source application path"
  ));
  const outputPath = path.resolve(requiredString(
    input?.outputPath,
    "forbidden source-path list output path"
  ));
  await assertPathMissing(outputPath, "forbidden source-path list");
  const sourceManifest = await capturePackagedElectronPackageManifest(
    sourceApplicationPath
  );
  const paths = windowsForbiddenSourcePaths(sourceManifest);
  const source = serializeWindowsForbiddenSourcePaths(paths);
  await writeFile(outputPath, source, { flag: "wx", mode: 0o600 });
  return Object.freeze({
    identity: Object.freeze({
      bytes: source.length,
      fileName: path.basename(outputPath),
      sha256: sha256Buffer(source)
    }),
    paths
  });
}

export async function readAndVerifyWindowsForbiddenSourcePathList(input) {
  const sourceManifest = await capturePackagedElectronPackageManifest(
    path.resolve(requiredString(input?.sourceApplicationPath, "source application path"))
  );
  return readAndVerifyForbiddenSourcePathListForManifest(
    path.resolve(requiredString(input?.listPath, "forbidden source-path list path")),
    sourceManifest
  );
}

async function readAndVerifyForbiddenSourcePathListForManifest(listPath, sourceManifest) {
  const source = await readStableBoundedRegularFile(
    listPath,
    MAX_FORBIDDEN_SOURCE_LIST_BYTES,
    "Windows forbidden source-path list"
  );
  let parsed;
  try {
    parsed = JSON.parse(source.toString("utf8"));
  } catch (error) {
    throw new Error("The Windows forbidden source-path list is invalid JSON.", {
      cause: error
    });
  }
  const expectedPaths = windowsForbiddenSourcePaths(sourceManifest);
  if (!isDeepStrictEqual(parsed, expectedPaths)) {
    throw new Error(
      "The Windows forbidden source-path list does not match the source package inventory."
    );
  }
  if (!source.equals(serializeWindowsForbiddenSourcePaths(expectedPaths))) {
    throw new Error("The Windows forbidden source-path list is not canonical JSON.");
  }
  return Object.freeze({
    identity: Object.freeze({
      bytes: source.length,
      fileName: path.basename(listPath),
      sha256: sha256Buffer(source)
    }),
    paths: expectedPaths
  });
}

function windowsForbiddenSourcePaths(sourceManifest) {
  const root = path.resolve(requiredString(
    sourceManifest?.packageDirectory,
    "source package directory"
  ));
  const paths = [
    root,
    ...sourceManifest.entries.map((entry) =>
      path.join(root, ...entry.path.split("/")))
  ];
  if (new Set(paths).size !== paths.length) {
    throw new Error("The Windows source package inventory contains duplicate paths.");
  }
  return Object.freeze(paths);
}

function serializeWindowsForbiddenSourcePaths(paths) {
  return Buffer.from(`${JSON.stringify(paths)}\n`, "utf8");
}

export async function readAndVerifyWindowsIsolatedProfileResult(resultPath, expectedBinding) {
  const absolutePath = path.resolve(requiredString(
    resultPath,
    "Windows isolated-profile result path"
  ));
  if (path.basename(absolutePath) !== WINDOWS_ISOLATED_PROFILE_RESULT_NAME) {
    throw new Error(
      `The Windows isolated-profile result must be named ${WINDOWS_ISOLATED_PROFILE_RESULT_NAME}.`
    );
  }
  const source = await readStableBoundedRegularFile(
    absolutePath,
    MAX_ISOLATION_RESULT_BYTES,
    "Windows isolated-profile result"
  );
  let parsed;
  try {
    parsed = JSON.parse(source.toString("utf8"));
  } catch (error) {
    throw new Error("The Windows isolated-profile result is invalid JSON.", {
      cause: error
    });
  }
  const result = assertWindowsIsolatedProfileResult(parsed);
  if (!source.equals(serializeWindowsIsolatedProfileResult(result))) {
    throw new Error("The Windows isolated-profile result is not canonical JSON.");
  }
  if (!expectedBinding || typeof expectedBinding !== "object") {
    throw new Error("The Windows isolated-profile result binding is required.");
  }
  if (result.attemptNonce !== expectedBinding.attemptNonce) {
    throw new Error("The Windows isolated-profile result attempt nonce does not match.");
  }
  if (result.commandInvocationSha256 !== expectedBinding.commandInvocationSha256) {
    throw new Error(
      "The Windows isolated-profile result command invocation does not match."
    );
  }
  if (!isDeepStrictEqual(result.attestedInputs, expectedBinding.attestedInputs)) {
    throw new Error("The Windows isolated-profile result attested inputs do not match.");
  }
  return result;
}

export async function readAndVerifyWindowsElectronInstallerPayloadProof(input) {
  const proofPath = path.resolve(requiredString(input.proofPath, "payload proof path"));
  if (path.basename(proofPath) !== WINDOWS_ELECTRON_INSTALLER_PAYLOAD_PROOF_NAME) {
    throw new Error(
      `The Windows installer payload proof must be named ${WINDOWS_ELECTRON_INSTALLER_PAYLOAD_PROOF_NAME}.`
    );
  }
  const source = await readStableBoundedRegularFile(
    proofPath,
    MAX_PROOF_BYTES,
    "Windows installer payload proof"
  );
  let parsed;
  try {
    parsed = JSON.parse(source.toString("utf8"));
  } catch (error) {
    throw new Error("The Windows installer payload proof is invalid JSON.", { cause: error });
  }
  const proof = assertWindowsElectronInstallerPayloadProof(parsed);
  if (!source.equals(serializeWindowsElectronInstallerPayloadProof(proof))) {
    throw new Error("The Windows installer payload proof is not canonical JSON.");
  }
  if (input.sourceSha !== undefined && proof.sourceSha !== input.sourceSha) {
    throw new Error("The Windows installer payload proof source SHA does not match.");
  }
  if (input.version !== undefined && proof.version !== input.version) {
    throw new Error("The Windows installer payload proof version does not match.");
  }
  if (input.sourceApplicationPath !== undefined) {
    const currentSourceManifest = toPortablePackagedElectronPackageManifest(
      await capturePackagedElectronPackageManifest(input.sourceApplicationPath)
    );
    if (!isDeepStrictEqual(currentSourceManifest, proof.sourcePackage.manifest)) {
      throw new Error(
        "The Windows installer payload proof source package does not match the current application."
      );
    }
  }
  if (input.installerPath !== undefined) {
    const installer = await captureStableRegularFileArtifact(
      input.installerPath,
      MAX_INSTALLER_BYTES,
      "Windows NSIS installer"
    );
    if (
      installer.fileName !== proof.installer.fileName ||
      installer.bytes !== proof.installer.bytes ||
      installer.sha256 !== proof.installer.sha256
    ) {
      throw new Error(
        "The Windows installer payload proof does not match the current installer."
      );
    }
  }
  if (input.blackBoxEvidence !== undefined) {
    assertWindowsInstallerPayloadProofMatchesBlackBox(proof, input.blackBoxEvidence);
  }
  return Object.freeze({
    identity: Object.freeze({
      bytes: source.length,
      fileName: WINDOWS_ELECTRON_INSTALLER_PAYLOAD_PROOF_NAME,
      sha256: sha256Buffer(source)
    }),
    proof,
    source
  });
}

export function assertWindowsInstallerPayloadProofMatchesBlackBox(
  proofValue,
  blackBoxEvidence
) {
  const proof = assertWindowsElectronInstallerPayloadProof(proofValue);
  const manifest = proof.sourcePackage.manifest;
  const summary = {
    directoryCount: manifest.directoryCount,
    entryCount: manifest.entryCount,
    regularFileBytes: manifest.regularFileBytes,
    regularFileCount: manifest.regularFileCount,
    schemaVersion: manifest.schemaVersion,
    sha256: manifest.sha256,
    symlinkCount: manifest.symlinkCount
  };
  if (!isDeepStrictEqual(summary, blackBoxEvidence?.packageManifest)) {
    throw new Error(
      "The Windows installer payload proof source manifest does not match black-box evidence."
    );
  }
  if (proof.version !== blackBoxEvidence?.appVersion) {
    throw new Error(
      "The Windows installer payload proof version does not match black-box evidence."
    );
  }
  for (const [relativePath, field] of [
    [WINDOWS_ELECTRON_MAIN_EXECUTABLE_PATH, "executable"],
    ["resources/app.asar", "appAsar"],
    ["resources/native/rion-core.node", "nativeAddon"]
  ]) {
    const entry = requiredRegularEntry(manifest, relativePath);
    if (entry.sha256 !== blackBoxEvidence?.[field]?.sha256) {
      throw new Error(
        `The Windows installer payload proof ${field} does not match black-box evidence.`
      );
    }
  }
  return proof;
}

export async function captureStableRegularFileArtifact(
  filePath,
  maximumBytes = MAX_INSTALLER_BYTES,
  label = "artifact"
) {
  const absolutePath = path.resolve(requiredString(filePath, `${label} path`));
  const initialMetadata = await lstat(absolutePath, { bigint: true });
  assertBoundedRegularFile(initialMetadata, maximumBytes, label);
  const handle = await open(absolutePath, READ_ONLY_NO_FOLLOW);
  try {
    const openedMetadata = await handle.stat({ bigint: true });
    assertSameRegularFile(initialMetadata, openedMetadata, label);
    assertBoundedRegularFile(openedMetadata, maximumBytes, label);
    const digest = createHash("sha256");
    let observedBytes = 0;
    const expectedBytes = Number(openedMetadata.size);
    const stream = handle.createReadStream({
      autoClose: false,
      end: expectedBytes - 1,
      start: 0
    });
    for await (const chunk of stream) {
      observedBytes += chunk.length;
      digest.update(chunk);
    }
    if (observedBytes !== expectedBytes) {
      throw new Error(`${label} changed while it was being hashed.`);
    }
    const completedMetadata = await handle.stat({ bigint: true });
    assertSameRegularFile(openedMetadata, completedMetadata, label);
    const completedPathMetadata = await lstat(absolutePath, { bigint: true });
    assertSameRegularFile(completedMetadata, completedPathMetadata, label);
    return Object.freeze({
      bytes: expectedBytes,
      fileName: path.basename(absolutePath),
      sha256: digest.digest("hex")
    });
  } finally {
    await handle.close();
  }
}

async function readStableBoundedRegularFile(filePath, maximumBytes, label) {
  const initialMetadata = await lstat(filePath, { bigint: true });
  assertBoundedRegularFile(initialMetadata, maximumBytes, label);
  const handle = await open(filePath, READ_ONLY_NO_FOLLOW);
  try {
    const openedMetadata = await handle.stat({ bigint: true });
    assertSameRegularFile(initialMetadata, openedMetadata, label);
    assertBoundedRegularFile(openedMetadata, maximumBytes, label);
    const length = Number(openedMetadata.size);
    const source = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const result = await handle.read(source, offset, length - offset, offset);
      if (result.bytesRead === 0) {
        throw new Error(`${label} changed while it was being read.`);
      }
      offset += result.bytesRead;
    }
    const sentinel = Buffer.allocUnsafe(1);
    if ((await handle.read(sentinel, 0, 1, length)).bytesRead !== 0) {
      throw new Error(`${label} exceeded its safe byte bound while it was being read.`);
    }
    const completedMetadata = await handle.stat({ bigint: true });
    assertSameRegularFile(openedMetadata, completedMetadata, label);
    const completedPathMetadata = await lstat(filePath, { bigint: true });
    assertSameRegularFile(completedMetadata, completedPathMetadata, label);
    return source;
  } finally {
    await handle.close();
  }
}

async function captureWindowsAuthenticodeArtifact(filePath, environment) {
  const sanitizedEnvironment = sanitizeUpdaterRuntimeEnvironment(environment);
  const result = await execFileAsync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      [
        "$path = $env:RION_WINDOWS_PROOF_AUTHENTICODE_PATH",
        "$stream = [IO.FileStream]::new($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)",
        "try {",
        "  $sha = [Security.Cryptography.SHA256]::Create()",
        "  try { $before = -join ($sha.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) } finally { $sha.Dispose() }",
        "  $stream.Position = 0",
        "  $signature = Get-AuthenticodeSignature -LiteralPath $path",
        "  $stream.Position = 0",
        "  $sha = [Security.Cryptography.SHA256]::Create()",
        "  try { $after = -join ($sha.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) } finally { $sha.Dispose() }",
        "  if ($before -ne $after) { throw 'Authenticode input changed while locked.' }",
        "  [ordered]@{ authenticodeStatus = $signature.Status.ToString(); bytes = $stream.Length; fileName = [IO.Path]::GetFileName($path); sha256 = $after } | ConvertTo-Json -Compress | Write-Output",
        "} finally { $stream.Dispose() }"
      ].join("\n")
    ],
    {
      encoding: "utf8",
      env: {
        ...sanitizedEnvironment,
        RION_WINDOWS_PROOF_AUTHENTICODE_PATH: filePath
      },
      maxBuffer: 1024 * 1024,
      windowsHide: true
    }
  );
  let parsed;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch (error) {
    throw new Error("The Windows Authenticode artifact result is invalid JSON.", {
      cause: error
    });
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !isDeepStrictEqual(
      Object.keys(parsed).sort(),
      ["authenticodeStatus", "bytes", "fileName", "sha256"].sort()
    ) ||
    typeof parsed.authenticodeStatus !== "string" ||
    !Number.isSafeInteger(parsed.bytes) ||
    parsed.bytes <= 0 ||
    typeof parsed.fileName !== "string" ||
    typeof parsed.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(parsed.sha256)
  ) {
    throw new Error("The Windows Authenticode artifact result has an invalid schema.");
  }
  return Object.freeze(parsed);
}

function windowsInstallerProofCommandArguments(input) {
  return Object.freeze([
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-File",
    input.commandScriptPath,
    "-ArtifactPath",
    input.artifactPath,
    "-AttemptNonce",
    input.attemptNonce,
    "-ForbiddenSourceFileListPath",
    input.forbiddenSourceFileListPath,
    "-GateRoot",
    input.gateRootPath,
    "-InstallDirectory",
    input.installDirectory,
    "-Version",
    input.version
  ]);
}

function assertAuthenticodeArtifactMatches(observed, expected, label) {
  if (
    observed.bytes !== expected.bytes ||
    observed.fileName !== expected.fileName ||
    observed.sha256 !== expected.sha256
  ) {
    throw new Error(`${label} Authenticode status was measured from different bytes.`);
  }
}

function assertPrivateUpdaterKeyAbsent(environment) {
  if (Object.keys(environment).some(isUpdaterPrivateEnvironmentName)) {
    throw new Error(
      "The Windows installer payload proof must run before updater private-key scope."
    );
  }
}

function requiredRegularEntry(manifest, relativePath) {
  const entry = manifest.entries.find((candidate) => candidate.path === relativePath);
  if (entry?.type !== "regular-file" || entry.bytes <= 0) {
    throw new Error(
      `The Windows installer payload proof lacks nonempty regular file ${JSON.stringify(relativePath)}.`
    );
  }
  return entry;
}

function assertManifestUnchanged(before, after, label) {
  const beforePortable = toPortablePackagedElectronPackageManifest(before);
  const afterPortable = toPortablePackagedElectronPackageManifest(after);
  if (!isDeepStrictEqual(beforePortable, afterPortable)) {
    throw new Error(`The ${label} changed while the Windows payload proof was produced.`);
  }
}

function assertArtifactUnchanged(before, after, label) {
  if (!isDeepStrictEqual(before, after)) {
    throw new Error(`The ${label} changed while the Windows payload proof was produced.`);
  }
}

function assertArtifactName(artifact, expectedName, label) {
  if (artifact.fileName !== expectedName) {
    throw new Error(`The Windows payload proof ${label} has the wrong filename.`);
  }
}

function assertBoundedRegularFile(metadata, maximumBytes, label) {
  if (
    !metadata.isFile() ||
    metadata.nlink !== 1n ||
    metadata.size <= 0n ||
    metadata.size > BigInt(maximumBytes)
  ) {
    throw new Error(
      `${label} is not a bounded, nonempty, exclusively linked regular file.`
    );
  }
}

function assertSameRegularFile(expected, observed, label) {
  if (
    !observed.isFile() ||
    expected.dev !== observed.dev ||
    expected.ino !== observed.ino ||
    expected.mode !== observed.mode ||
    expected.nlink !== observed.nlink ||
    expected.size !== observed.size ||
    expected.mtimeNs !== observed.mtimeNs ||
    expected.ctimeNs !== observed.ctimeNs
  ) {
    throw new Error(`${label} identity changed while it was being read.`);
  }
}

async function assertPathMissing(filePath, label) {
  try {
    await lstat(filePath);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`The ${label} path already exists: ${filePath}`);
}

function sha256Buffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requiredString(value, label) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function requiredAttemptNonce(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/u.test(value)) {
    throw new Error("Windows installer payload proof attempt nonce is invalid.");
  }
  return value;
}

function parseArguments(argumentsList, expectedNames) {
  const options = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid Windows installer payload proof argument near ${name ?? "<end>"}.`);
    }
    const key = name.slice(2);
    if (options.has(key)) throw new Error(`Duplicate option --${key}.`);
    options.set(key, value);
  }
  const expected = [...expectedNames].sort();
  if (!isDeepStrictEqual([...options.keys()].sort(), expected)) {
    throw new Error("The Windows installer payload proof command has an unexpected option set.");
  }
  return options;
}

async function runCli(argumentsList = process.argv.slice(2), environment = process.env) {
  const [command, ...optionArguments] = argumentsList[0] === "--"
    ? argumentsList.slice(1)
    : argumentsList;
  if (command === "write-forbidden-source-list") {
    const options = parseArguments(optionArguments, [
      "output",
      "source-application"
    ]);
    return writeWindowsForbiddenSourcePathList({
      outputPath: options.get("output"),
      sourceApplicationPath: options.get("source-application")
    });
  }
  if (command !== "create") {
    throw new Error(
      "Usage: windowsElectronInstallerPayloadProof.mjs create|write-forbidden-source-list ..."
    );
  }
  const options = parseArguments(optionArguments, [
    "attempt-nonce",
    "command-path",
    "command-script",
    "forbidden-source-file-list",
    "gate-root",
    "installed-application",
    "installer",
    "isolation-result",
    "output",
    "source-application",
    "source-sha",
    "version"
  ]);
  return createWindowsElectronInstallerPayloadProof({
    attemptNonce: options.get("attempt-nonce"),
    commandPath: options.get("command-path"),
    commandScriptPath: options.get("command-script"),
    environment,
    forbiddenSourceFileListPath: options.get("forbidden-source-file-list"),
    gateRootPath: options.get("gate-root"),
    installedApplicationPath: options.get("installed-application"),
    installerPath: options.get("installer"),
    isolationResultPath: options.get("isolation-result"),
    outputPath: options.get("output"),
    sourceApplicationPath: options.get("source-application"),
    sourceSha: options.get("source-sha"),
    version: options.get("version")
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
