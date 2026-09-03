import { isDeepStrictEqual } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  captureStableBoundedFileIdentity,
  MAX_ELECTRON_CANDIDATE_ARTIFACT_BYTES
} from "./electronProductionCandidateAssetBinding.mjs";
import {
  assertPackagedApplicationVersion
} from "./electronProductionMacosPackageBinding.mjs";
import {
  assertPackagedElectronPackageManifestSummary,
  assertPackagedElectronPackageManifestUnchanged,
  capturePackagedElectronPackageManifest,
  PACKAGED_ELECTRON_PACKAGE_MANIFEST_LIMITS,
  summarizePackagedElectronPackageManifest
} from "./packagedElectronPackageManifest.mjs";
import { extractSafeTarGzipSubtree } from "./safeTarGzipExtraction.mjs";
import { verifyPackagedElectron } from "./verifyElectronPackage.mjs";

export const ELECTRON_UPDATER_MACOS_PACKAGE_VERIFICATION_KIND =
  "rion-electron-updater-macos-package-verification";

const APPLICATION_BUNDLE_NAME = "Rion Studio.app";
const ARTIFACT_NAME = "Rion.Studio-mac.app.tar.gz";
const VERIFICATION_KIND =
  "safe-tar-extraction-production-electron-package-v1";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export async function verifyElectronUpdaterMacosPackage(input) {
  const artifactPath = requiredArtifactPath(input?.artifactPath);
  const expectedArtifact = requiredExpectedArtifact(
    input?.expectedArtifact,
    artifactPath
  );
  const expectedVersion = requiredSemanticVersion(input?.expectedVersion);
  const referenceApplicationPath = requiredReferenceApplicationPath(
    input?.referenceApplicationPath
  );
  const packageVerifier = input?.packageVerifier ?? verifyPackagedElectron;
  if (typeof packageVerifier !== "function") {
    throw new Error("The macOS updater package verifier is invalid.");
  }

  const before = await captureStableBoundedFileIdentity(
    artifactPath,
    MAX_ELECTRON_CANDIDATE_ARTIFACT_BYTES,
    "prepared macOS updater archive"
  );
  assertArtifactIdentity(before, expectedArtifact);

  const referenceManifestBefore = await captureVerifiedPackageManifest({
    applicationPath: referenceApplicationPath,
    expectedVersion,
    packageVerifier
  });

  const extractionRoot = await mkdtemp(
    path.join(tmpdir(), "rion-updater-macos-package-")
  );
  let packageManifest;
  try {
    const extractedApplicationPath = path.join(
      extractionRoot,
      APPLICATION_BUNDLE_NAME
    );
    const extraction = await extractSafeTarGzipSubtree({
      archivePath: artifactPath,
      archiveRoot: APPLICATION_BUNDLE_NAME,
      destinationPath: extractedApplicationPath,
      limits: {
        maximumArchiveBytes: MAX_ELECTRON_CANDIDATE_ARTIFACT_BYTES,
        maximumEntries: PACKAGED_ELECTRON_PACKAGE_MANIFEST_LIMITS.maximumEntries,
        maximumFileBytes:
          PACKAGED_ELECTRON_PACKAGE_MANIFEST_LIMITS.maximumFileBytes,
        maximumSymlinkTargetBytes:
          PACKAGED_ELECTRON_PACKAGE_MANIFEST_LIMITS.maximumSymlinkTargetBytes,
        maximumTotalFileBytes:
          PACKAGED_ELECTRON_PACKAGE_MANIFEST_LIMITS.maximumTotalFileBytes
      }
    });
    if (
      extraction.archiveBytes !== expectedArtifact.bytes ||
      extraction.archiveSha256 !== expectedArtifact.sha256
    ) {
      throw new Error(
        "The safely extracted macOS updater archive does not match its signed-input receipt."
      );
    }
    packageManifest = await captureVerifiedPackageManifest({
      applicationPath: extractedApplicationPath,
      expectedVersion,
      packageVerifier
    });
    if (!isDeepStrictEqual(packageManifest, referenceManifestBefore)) {
      throw new Error(
        "The prepared macOS updater archive package does not match the verified unpacked application."
      );
    }
  } finally {
    await rm(extractionRoot, { force: true, recursive: true });
  }

  const after = await captureStableBoundedFileIdentity(
    artifactPath,
    MAX_ELECTRON_CANDIDATE_ARTIFACT_BYTES,
    "prepared macOS updater archive"
  );
  if (!isDeepStrictEqual(before, after)) {
    throw new Error(
      "The prepared macOS updater archive changed while its package was verified."
    );
  }
  assertArtifactIdentity(after, expectedArtifact);
  const referenceManifestAfter = summarizePackagedElectronPackageManifest(
    await capturePackagedElectronPackageManifest(referenceApplicationPath)
  );
  if (!isDeepStrictEqual(referenceManifestBefore, referenceManifestAfter)) {
    throw new Error(
      "The verified unpacked macOS application changed while the updater archive was checked."
    );
  }

  return Object.freeze({
    schemaVersion: 1,
    kind: ELECTRON_UPDATER_MACOS_PACKAGE_VERIFICATION_KIND,
    verificationKind: VERIFICATION_KIND,
    applicationBundle: APPLICATION_BUNDLE_NAME,
    expectedVersion,
    artifact: Object.freeze({
      fileName: ARTIFACT_NAME,
      bytes: after.bytes,
      sha256: after.sha256
    }),
    packageManifest
  });
}

export function assertElectronUpdaterMacosPackageVerification(
  value,
  expected
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The macOS updater package verification is invalid.");
  }
  assertExactKeys(value, [
    "applicationBundle",
    "artifact",
    "expectedVersion",
    "kind",
    "packageManifest",
    "schemaVersion",
    "verificationKind"
  ]);
  if (
    value.schemaVersion !== 1 ||
    value.kind !== ELECTRON_UPDATER_MACOS_PACKAGE_VERIFICATION_KIND ||
    value.verificationKind !== VERIFICATION_KIND ||
    value.applicationBundle !== APPLICATION_BUNDLE_NAME ||
    value.expectedVersion !== expected.version
  ) {
    throw new Error("The macOS updater package verification contract is invalid.");
  }
  assertExactKeys(value.artifact, ["bytes", "fileName", "sha256"]);
  if (
    value.artifact.fileName !== ARTIFACT_NAME ||
    value.artifact.bytes !== expected.artifact.bytes ||
    value.artifact.sha256 !== expected.artifact.sha256
  ) {
    throw new Error(
      "The macOS updater package verification artifact does not match the prepared input."
    );
  }
  const packageManifest = assertPackagedElectronPackageManifestSummary(
    value.packageManifest
  );
  return Object.freeze({
    ...value,
    artifact: Object.freeze({ ...value.artifact }),
    packageManifest
  });
}

async function captureVerifiedPackageManifest(input) {
  const before = await capturePackagedElectronPackageManifest(
    input.applicationPath
  );
  const layout = await input.packageVerifier(input.applicationPath);
  if (!layout || typeof layout.resourcesPath !== "string") {
    throw new Error(
      "The macOS updater package verifier returned an invalid layout."
    );
  }
  await assertPackagedApplicationVersion(
    layout.resourcesPath,
    input.expectedVersion
  );
  const after = await capturePackagedElectronPackageManifest(
    input.applicationPath
  );
  return assertPackagedElectronPackageManifestUnchanged(before, after);
}

function requiredArtifactPath(value) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    path.basename(value) !== ARTIFACT_NAME
  ) {
    throw new Error(
      `The prepared macOS updater archive must be an absolute ${ARTIFACT_NAME} path.`
    );
  }
  return path.resolve(value);
}

function requiredExpectedArtifact(value, artifactPath) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The expected macOS updater artifact identity is invalid.");
  }
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["bytes", "path", "sha256"])) {
    throw new Error("The expected macOS updater artifact identity schema is invalid.");
  }
  if (
    value.path !== artifactPath ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes <= 0 ||
    !SHA256_PATTERN.test(value.sha256 ?? "")
  ) {
    throw new Error("The expected macOS updater artifact identity is invalid.");
  }
  return Object.freeze({ ...value });
}

function requiredReferenceApplicationPath(value) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    path.basename(value) !== APPLICATION_BUNDLE_NAME
  ) {
    throw new Error(
      `The verified unpacked macOS application must be an absolute ${APPLICATION_BUNDLE_NAME} path.`
    );
  }
  return path.resolve(value);
}

function requiredSemanticVersion(value) {
  if (
    typeof value !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value)
  ) {
    throw new Error("The macOS updater package version is invalid.");
  }
  return value;
}

function assertArtifactIdentity(actual, expected) {
  if (
    actual.bytes !== expected.bytes ||
    actual.sha256 !== expected.sha256
  ) {
    throw new Error(
      "The prepared macOS updater archive does not match its signed-input receipt."
    );
  }
}

function assertExactKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The macOS updater package verification schema is invalid.");
  }
  const actualKeys = Object.keys(value).sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify([...expectedKeys].sort())) {
    throw new Error("The macOS updater package verification schema is invalid.");
  }
}
