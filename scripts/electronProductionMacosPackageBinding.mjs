import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  assertPackagedElectronPackageManifestSummary,
  capturePackagedElectronPackageManifest,
  PACKAGED_ELECTRON_PACKAGE_MANIFEST_LIMITS,
  summarizePackagedElectronPackageManifest
} from "./packagedElectronPackageManifest.mjs";
import {
  captureStableBoundedFileIdentity,
  MAX_ELECTRON_CANDIDATE_ARTIFACT_BYTES as MAX_ARTIFACT_BYTES
} from "./electronProductionCandidateAssetBinding.mjs";
import { sanitizeUpdaterRuntimeEnvironment } from "./runtimeEnvironmentPolicy.mjs";
import { extractSafeTarGzipSubtree } from "./safeTarGzipExtraction.mjs";

export const ELECTRON_MACOS_PACKAGE_BINDING_KIND =
  "rion-electron-macos-package-binding";
const ELECTRON_MACOS_UPDATER_ARCHIVE_NAME = "Rion.Studio-mac.app.tar.gz";
const ELECTRON_MACOS_DISTRIBUTION_NAME = "Rion.Studio-mac.dmg";
const APPLICATION_BUNDLE_NAME = "Rion Studio.app";
const VERIFICATION_KIND =
  "safe-tar-extraction-and-read-only-dmg-mount-v2";

export async function createVerifiedMacosPackageBinding(input) {
  const artifactPath = path.resolve(input.artifactPath);
  const distributionPath = path.resolve(input.distributionPath);
  const [artifactMetadata, distributionMetadata, artifactParentMetadata,
    distributionParentMetadata, artifactBefore, distributionBefore] =
    await Promise.all([
      requiredVerificationPathMetadata(artifactPath, "macOS updater archive"),
      requiredVerificationPathMetadata(distributionPath, "macOS distribution"),
      requiredVerificationParentMetadata(artifactPath, "macOS updater archive"),
      requiredVerificationParentMetadata(distributionPath, "macOS distribution"),
      captureStableBoundedFileIdentity(
        artifactPath,
        MAX_ARTIFACT_BYTES,
        "macOS updater archive"
      ),
      captureStableBoundedFileIdentity(
        distributionPath,
        MAX_ARTIFACT_BYTES,
        "macOS distribution"
      )
    ]);
  await verifyMacosUpdaterArchive({
    artifactPath,
    environment: input.environment,
    expectedPackageManifest: input.expectedPackageManifest,
    expectedVersion: input.expectedVersion,
    packageVerifier: input.packageVerifier
  });
  await verifyMacosDistributionPackage({
    distributionPath,
    environment: input.environment,
    expectedPackageManifest: input.expectedPackageManifest,
    expectedVersion: input.expectedVersion,
    packageVerifier: input.packageVerifier
  });
  const [artifactAfterMetadata, distributionAfterMetadata,
    artifactAfterParentMetadata, distributionAfterParentMetadata, artifactAfter,
    distributionAfter] = await Promise.all([
    requiredVerificationPathMetadata(artifactPath, "macOS updater archive"),
    requiredVerificationPathMetadata(distributionPath, "macOS distribution"),
    requiredVerificationParentMetadata(artifactPath, "macOS updater archive"),
    requiredVerificationParentMetadata(distributionPath, "macOS distribution"),
    captureStableBoundedFileIdentity(
      artifactPath,
      MAX_ARTIFACT_BYTES,
      "macOS updater archive"
    ),
    captureStableBoundedFileIdentity(
      distributionPath,
      MAX_ARTIFACT_BYTES,
      "macOS distribution"
    )
  ]);
  assertSameVerificationPathMetadata(
    artifactMetadata,
    artifactAfterMetadata,
    "macOS updater archive"
  );
  assertSameVerificationPathMetadata(
    distributionMetadata,
    distributionAfterMetadata,
    "macOS distribution"
  );
  assertSameVerificationParentMetadata(
    artifactParentMetadata,
    artifactAfterParentMetadata,
    "macOS updater archive"
  );
  assertSameVerificationParentMetadata(
    distributionParentMetadata,
    distributionAfterParentMetadata,
    "macOS distribution"
  );
  if (!isDeepStrictEqual(artifactBefore, artifactAfter)) {
    throw new Error("The macOS updater archive changed while its package binding was verified.");
  }
  if (!isDeepStrictEqual(distributionBefore, distributionAfter)) {
    throw new Error("The macOS distribution changed while its package binding was verified.");
  }
  return createMacosPackageBindingEvidence({
    artifact: {
      ...artifactAfter,
      fileName: ELECTRON_MACOS_UPDATER_ARCHIVE_NAME
    },
    distribution: {
      ...distributionAfter,
      fileName: ELECTRON_MACOS_DISTRIBUTION_NAME
    },
    packageManifest: input.expectedPackageManifest
  });
}

export async function verifyMacosUpdaterArchive(input) {
  const extractionRoot = await mkdtemp(
    path.join(tmpdir(), "rion-electron-candidate-archive-")
  );
  try {
    const extractedApplicationPath = path.join(
      extractionRoot,
      APPLICATION_BUNDLE_NAME
    );
    await extractSafeTarGzipSubtree({
      archivePath: path.resolve(input.artifactPath),
      archiveRoot: APPLICATION_BUNDLE_NAME,
      destinationPath: extractedApplicationPath,
      limits: {
        maximumArchiveBytes: MAX_ARTIFACT_BYTES,
        maximumEntries: PACKAGED_ELECTRON_PACKAGE_MANIFEST_LIMITS.maximumEntries,
        maximumFileBytes: PACKAGED_ELECTRON_PACKAGE_MANIFEST_LIMITS.maximumFileBytes,
        maximumSymlinkTargetBytes:
          PACKAGED_ELECTRON_PACKAGE_MANIFEST_LIMITS.maximumSymlinkTargetBytes,
        maximumTotalFileBytes:
          PACKAGED_ELECTRON_PACKAGE_MANIFEST_LIMITS.maximumTotalFileBytes
      }
    });
    const layout = await input.packageVerifier(extractedApplicationPath);
    await assertPackagedApplicationVersion(
      layout.resourcesPath,
      input.expectedVersion
    );
    const extractedManifest = summarizePackagedElectronPackageManifest(
      await capturePackagedElectronPackageManifest(extractedApplicationPath)
    );
    if (!isDeepStrictEqual(extractedManifest, input.expectedPackageManifest)) {
      throw new Error(
        "The macOS updater archive package manifest does not match the black-box package."
      );
    }
  } finally {
    await rm(extractionRoot, { force: true, recursive: true });
  }
}

export async function verifyMacosDistributionPackage(input) {
  const sanitizedEnvironment = sanitizeUpdaterRuntimeEnvironment(input.environment);
  await runCommand(
    "/usr/bin/hdiutil",
    ["verify", input.distributionPath],
    sanitizedEnvironment
  );
  const verificationRoot = await mkdtemp(
    path.join(tmpdir(), "rion-electron-candidate-dmg-")
  );
  const mountPoint = path.join(verificationRoot, "mounted");
  await mkdir(mountPoint, { mode: 0o700 });
  const unmountedMetadata = await lstat(mountPoint, { bigint: true });
  let attached = false;
  let verificationFailure;
  try {
    await runCommand(
      "/usr/bin/hdiutil",
      [
        "attach",
        "-readonly",
        "-nobrowse",
        "-mountpoint",
        mountPoint,
        input.distributionPath
      ],
      sanitizedEnvironment
    );
    attached = true;
    const mountedApplicationPath = path.join(
      mountPoint,
      APPLICATION_BUNDLE_NAME
    );
    const layout = await input.packageVerifier(mountedApplicationPath);
    await assertPackagedApplicationVersion(
      layout.resourcesPath,
      input.expectedVersion
    );
    const mountedManifest = summarizePackagedElectronPackageManifest(
      await capturePackagedElectronPackageManifest(mountedApplicationPath)
    );
    if (!isDeepStrictEqual(mountedManifest, input.expectedPackageManifest)) {
      throw new Error(
        "The macOS distribution package manifest does not match the black-box package."
      );
    }
  } catch (error) {
    if (!attached) {
      const observedMetadata = await lstat(mountPoint, { bigint: true });
      attached =
        observedMetadata.dev !== unmountedMetadata.dev ||
        observedMetadata.ino !== unmountedMetadata.ino;
    }
    verificationFailure = error;
  }
  let detachFailure;
  if (attached) {
    try {
      await runCommand(
        "/usr/bin/hdiutil",
        ["detach", mountPoint],
        sanitizedEnvironment
      );
      attached = false;
    } catch (error) {
      detachFailure = error;
    }
  }
  if (!attached) {
    await rm(verificationRoot, { force: true, recursive: true });
  }
  if (verificationFailure && detachFailure) {
    throw new AggregateError(
      [verificationFailure, detachFailure],
      "The macOS distribution package verification and detach both failed."
    );
  }
  if (detachFailure) throw detachFailure;
  if (verificationFailure) throw verificationFailure;
}

export async function assertPackagedApplicationVersion(
  resourcesPath,
  expectedVersion
) {
  const { extractFile } = await import("@electron/asar");
  const packageMetadata = JSON.parse(
    extractFile(path.join(resourcesPath, "app.asar"), "package.json").toString("utf8")
  );
  if (packageMetadata?.version !== expectedVersion) {
    throw new Error(
      `Packaged Electron version ${String(packageMetadata?.version ?? "<missing>")} does not match ${expectedVersion}.`
    );
  }
}

export function createMacosPackageBindingEvidence(input) {
  const binding = {
    schemaVersion: 1,
    kind: ELECTRON_MACOS_PACKAGE_BINDING_KIND,
    verificationKind: VERIFICATION_KIND,
    applicationBundle: APPLICATION_BUNDLE_NAME,
    artifact: copyBindingIdentity(input.artifact, "updater archive"),
    distribution: copyBindingIdentity(input.distribution, "distribution"),
    packageManifest: { ...input.packageManifest }
  };
  assertPackagedElectronPackageManifestSummary(binding.packageManifest);
  return assertMacosPackageBindingEvidence(
    binding,
    { packageManifest: binding.packageManifest },
    binding.artifact,
    binding.distribution
  );
}

export function assertMacosPackageBindingEvidence(
  binding,
  blackBoxEvidence,
  artifactIdentity,
  distributionIdentity
) {
  assertExactKeys(binding, [
    "applicationBundle",
    "artifact",
    "distribution",
    "kind",
    "packageManifest",
    "schemaVersion",
    "verificationKind"
  ], "macOS package binding");
  const checks = [
    [binding.schemaVersion, 1, "schema version"],
    [binding.kind, ELECTRON_MACOS_PACKAGE_BINDING_KIND, "kind"],
    [binding.verificationKind, VERIFICATION_KIND, "verification kind"],
    [binding.applicationBundle, APPLICATION_BUNDLE_NAME, "application bundle"]
  ];
  for (const [actual, expected, label] of checks) {
    if (actual !== expected) {
      throw new Error(`The macOS package binding ${label} does not match.`);
    }
  }
  assertBindingIdentity(
    binding.artifact,
    ELECTRON_MACOS_UPDATER_ARCHIVE_NAME,
    "updater archive"
  );
  assertBindingIdentity(
    binding.distribution,
    ELECTRON_MACOS_DISTRIBUTION_NAME,
    "distribution"
  );
  assertPackagedElectronPackageManifestSummary(binding.packageManifest);
  if (!isDeepStrictEqual(binding.packageManifest, blackBoxEvidence.packageManifest)) {
    throw new Error(
      "The macOS package binding manifest does not match the black-box package."
    );
  }
  if (!isDeepStrictEqual(binding.artifact, artifactIdentity)) {
    throw new Error(
      "The macOS package binding updater archive does not match the signed artifact."
    );
  }
  if (!isDeepStrictEqual(binding.distribution, distributionIdentity)) {
    throw new Error(
      "The macOS package binding distribution does not match the staged DMG."
    );
  }
  return Object.freeze({
    ...binding,
    artifact: Object.freeze({ ...binding.artifact }),
    distribution: Object.freeze({ ...binding.distribution }),
    packageManifest: Object.freeze({ ...binding.packageManifest })
  });
}

async function requiredVerificationPathMetadata(filePath, label) {
  const metadata = await lstat(filePath, { bigint: true });
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1n ||
    metadata.size <= 0n ||
    metadata.size > BigInt(MAX_ARTIFACT_BYTES)
  ) {
    throw new Error(
      `The ${label} must be a bounded, nonempty, exclusively linked regular file.`
    );
  }
  return metadata;
}

async function requiredVerificationParentMetadata(filePath, label) {
  const metadata = await lstat(path.dirname(filePath), { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`The ${label} parent must be a real directory.`);
  }
  return metadata;
}

function assertSameVerificationPathMetadata(expected, observed, label) {
  // hdiutil legitimately updates host-file extended attributes, which changes
  // ctime without changing the path entry or bytes. Parent directory times
  // below fence rename-based path replacement across the native commands.
  const fields = ["dev", "ino", "mode", "nlink", "size", "mtimeNs"];
  const changedFields = fields.filter((field) => expected[field] !== observed[field]);
  if (changedFields.length > 0) {
    throw new Error(
      `The ${label} path identity changed during native verification (${changedFields.join(", ")}).`
    );
  }
}

function assertSameVerificationParentMetadata(expected, observed, label) {
  const fields = ["dev", "ino", "mode", "mtimeNs", "ctimeNs"];
  const changedFields = fields.filter((field) => expected[field] !== observed[field]);
  if (changedFields.length > 0) {
    throw new Error(
      `The ${label} parent identity changed during native verification (${changedFields.join(", ")}).`
    );
  }
}

function copyBindingIdentity(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`The macOS package binding ${label} identity must be an object.`);
  }
  return {
    bytes: value.bytes,
    fileName: value.fileName,
    sha256: value.sha256
  };
}

function assertBindingIdentity(identity, fileName, label) {
  assertExactKeys(identity, ["bytes", "fileName", "sha256"], label);
  if (!Number.isSafeInteger(identity.bytes) || identity.bytes <= 0) {
    throw new Error(`The macOS package binding ${label} bytes are invalid.`);
  }
  if (typeof identity.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(identity.sha256)) {
    throw new Error(`The macOS package binding ${label} SHA-256 is invalid.`);
  }
  if (identity.fileName !== fileName) {
    throw new Error(`The macOS package binding ${label} has the wrong filename.`);
  }
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`The macOS package binding ${label} must be an object.`);
  }
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`The macOS package binding ${label} has an unexpected schema.`);
  }
}

async function runCommand(command, argumentsList, environment, capture = false) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, argumentsList, {
      env: environment,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
    }
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun(capture ? stdout : undefined);
      else reject(new Error(signal
        ? `${command} was terminated by ${signal}.`
        : `${command} exited with code ${code ?? "unknown"}.${stderr ? `\n${stderr}` : ""}`));
    });
  });
}
