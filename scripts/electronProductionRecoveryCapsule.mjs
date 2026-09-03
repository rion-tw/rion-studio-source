import { createHash } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath
} from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  assertEqual,
  assertExactKeys,
  assertSemanticVersionIsNewer,
  readStableFile,
  requiredAbsolutePath,
  requiredCommitSha,
  requiredDigest,
  requiredPositiveInteger,
  requiredSemanticVersion,
  resolveCreateNewFile,
  writeExclusive
} from "./electronUpdaterCompatibilityReceiptIo.mjs";
import {
  assertElectronProductionPublicLatestLease,
  electronProductionPublicLatestLeaseEventSha256
} from "./electronProductionPublicLatestLease.mjs";
import {
  assertDirectoryNodeIdentity,
  assertPathMissing,
  assertSafeRelativePath,
  assertSafeSegment,
  assertSameMetadata,
  captureCreatedDirectoryIdentity,
  materializedPath,
  removeMaterializationRootIfSame,
  resolveCreateNewMaterializationRoot
} from "./electronProductionRecoveryCapsuleLocalIo.mjs";
import {
  assertElectronProductionPublicLatestSnapshot,
  deriveElectronProductionExpectedLatestState
} from "./electronProductionPublicLatestSnapshot.mjs";
import {
  assertElectronProductionPublicationReceipt
} from "./electronProductionPublicationReceipt.mjs";

export const ELECTRON_PRODUCTION_RECOVERY_CAPSULE_KIND =
  "rion-electron-production-publication-recovery-capsule";
export const ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PACKAGE_KIND =
  "rion-electron-production-publication-recovery-capsule-package";
export const ELECTRON_PRODUCTION_RECOVERY_CAPSULE_MANIFEST_NAME =
  "electron-production-publication-recovery-capsule-manifest.json";
export const ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PACKAGE_NAME =
  "electron-production-publication-recovery-capsule.capsule.json";
export const ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PAYLOAD_PATHS = Object.freeze([
  "electron-production-candidate-receipt.json",
  "electron-production-prior-candidate-receipt.json",
  "electron-production-prior-candidate-trusted-control-receipt.json",
  "electron-production-prior-candidate-verification.json",
  "electron-production-public-latest-held-lease-evidence.json",
  "electron-production-public-latest-lease-acquire-operation.json",
  "electron-production-public-latest-lease.json",
  "electron-production-publication-intent-receipt.json",
  "electron-production-publication-staging-plan-receipt.json",
  "electron-production-target-candidate-trusted-control-receipt.json",
  "electron-production-target-candidate-verification.json",
  "source-public-latest-snapshot.json",
  "staged-target-public-release-snapshot.json",
  "target-public-latest-projection.json",
  "tauri-lineage/darwin-aarch64/tauri-v22-public-lineage-receipt.json",
  "tauri-lineage/windows-x86_64/tauri-v22-public-lineage-receipt.json"
].sort(compareStrings));

const SOURCE_REPOSITORY = "rion-tw/rion-studio-source";
const PUBLISHER_WORKFLOW =
  ".github/workflows/electron-production-provisional-publish.yml";
const CANDIDATE_WORKFLOW =
  ".github/workflows/electron-production-candidate.yml";
const MANIFEST_STATUS = "attested-pre-mutation-intent";
const PACKAGE_ENCODING = "base64";
const MAX_PAYLOAD_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_PAYLOAD_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_PACKAGE_BYTES = 8 * 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;
const READ_ONLY_NO_FOLLOW = fileConstants.O_RDONLY |
  (fileConstants.O_NOFOLLOW ?? 0);
const ALL_CAPSULE_PATHS = Object.freeze([
  ...ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PAYLOAD_PATHS,
  ELECTRON_PRODUCTION_RECOVERY_CAPSULE_MANIFEST_NAME
].sort(compareStrings));

const FILES = Object.freeze({
  candidateReceipt: "electron-production-candidate-receipt.json",
  candidateControl:
    "electron-production-target-candidate-trusted-control-receipt.json",
  candidateVerification:
    "electron-production-target-candidate-verification.json",
  heldEvidence:
    "electron-production-public-latest-held-lease-evidence.json",
  leaseAcquireOperation:
    "electron-production-public-latest-lease-acquire-operation.json",
  lease: "electron-production-public-latest-lease.json",
  intent: "electron-production-publication-intent-receipt.json",
  plan: "electron-production-publication-staging-plan-receipt.json",
  priorCandidateReceipt: "electron-production-prior-candidate-receipt.json",
  priorCandidateControl:
    "electron-production-prior-candidate-trusted-control-receipt.json",
  priorCandidateVerification:
    "electron-production-prior-candidate-verification.json",
  sourceSnapshot: "source-public-latest-snapshot.json",
  stagedSnapshot: "staged-target-public-release-snapshot.json",
  targetProjection: "target-public-latest-projection.json",
  lineageMacos:
    "tauri-lineage/darwin-aarch64/tauri-v22-public-lineage-receipt.json",
  lineageWindows:
    "tauri-lineage/windows-x86_64/tauri-v22-public-lineage-receipt.json"
});

export const ELECTRON_PRODUCTION_RECOVERY_CAPSULE_LIMITS = Object.freeze({
  maximumJsonDepth: MAX_JSON_DEPTH,
  maximumJsonNodes: MAX_JSON_NODES,
  maximumManifestBytes: MAX_MANIFEST_BYTES,
  maximumPackageBytes: MAX_PACKAGE_BYTES,
  maximumPayloadFileBytes: MAX_PAYLOAD_FILE_BYTES,
  maximumTotalPayloadBytes: MAX_TOTAL_PAYLOAD_BYTES,
  packedFileCount: ALL_CAPSULE_PATHS.length,
  payloadFileCount: ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PAYLOAD_PATHS.length
});

export async function createElectronProductionRecoveryCapsule(input) {
  assertExactKeys(input, ["binding", "capsulePath", "sourceRoot"],
    "recovery capsule creation input");
  const binding = assertRecoveryBinding(input.binding);
  const root = await requiredStableDirectory(input.sourceRoot, "recovery capsule source root");
  const capsulePath = await resolveCreateNewFile(
    input.capsulePath,
    ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PACKAGE_NAME,
    "packed recovery capsule"
  );
  assertPathOutsideRoot(capsulePath, root.path, "packed recovery capsule");

  const payloads = await captureClosedTree({
    expectedPaths: ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PAYLOAD_PATHS,
    maximumFileBytes: MAX_PAYLOAD_FILE_BYTES,
    maximumTotalBytes: MAX_TOTAL_PAYLOAD_BYTES,
    root
  });
  const verified = verifyPayloadBindings(payloads.files, binding);
  const manifest = buildManifest(payloads, verified, binding);
  const manifestSource = serializeCanonicalJson(manifest);
  assertBoundedNonemptyBytes(
    manifestSource.length,
    MAX_MANIFEST_BYTES,
    "recovery capsule manifest"
  );
  const manifestFileBeforeWrite = {
    bytes: manifestSource.length,
    sha256: sha256(manifestSource),
    source: manifestSource
  };
  const completeBeforeWrite = {
    files: {
      ...payloads.files,
      [ELECTRON_PRODUCTION_RECOVERY_CAPSULE_MANIFEST_NAME]: manifestFileBeforeWrite
    },
    totalBytes: payloads.totalBytes + manifestSource.length
  };
  const capsuleBeforeWrite = buildPackage(
    completeBeforeWrite,
    manifestFileBeforeWrite,
    payloads.files[FILES.intent]
  );
  const capsuleSourceBeforeWrite = serializeCanonicalJson(capsuleBeforeWrite);
  assertBoundedNonemptyBytes(
    capsuleSourceBeforeWrite.length,
    MAX_PACKAGE_BYTES,
    "packed recovery capsule"
  );
  const manifestPath = path.join(
    root.path,
    ELECTRON_PRODUCTION_RECOVERY_CAPSULE_MANIFEST_NAME
  );
  await assertPathMissing(manifestPath, "recovery capsule manifest");
  await writeExclusive(manifestPath, manifestSource);

  const complete = await captureClosedTree({
    expectedPaths: ALL_CAPSULE_PATHS,
    maximumFileBytes: MAX_PAYLOAD_FILE_BYTES,
    maximumTotalBytes: MAX_TOTAL_PAYLOAD_BYTES + MAX_MANIFEST_BYTES,
    root
  });
  const manifestFile = complete.files[ELECTRON_PRODUCTION_RECOVERY_CAPSULE_MANIFEST_NAME];
  assertEqual(manifestFile.sha256, sha256(manifestSource),
    "recovery capsule manifest reread digest");
  assertEqual(manifestFile.bytes, manifestSource.length,
    "recovery capsule manifest reread byte length");
  verifyManifest(manifest, payloads.files, verified, binding);

  const capsule = buildPackage(complete, manifestFile, payloads.files[FILES.intent]);
  const capsuleSource = serializeCanonicalJson(capsule);
  assertBoundedNonemptyBytes(
    capsuleSource.length,
    MAX_PACKAGE_BYTES,
    "packed recovery capsule"
  );
  if (!capsuleSource.equals(capsuleSourceBeforeWrite)) {
    throw new Error("The recovery capsule bytes changed after manifest publication.");
  }
  await writeExclusive(capsulePath, capsuleSource);
  const capsuleSha256 = sha256(capsuleSource);
  const reread = await readElectronProductionRecoveryCapsule({
    binding,
    capsulePath,
    expectedCapsuleSha256: capsuleSha256
  });
  return deepFreeze({
    ...reread,
    manifestPath
  });
}

export async function readElectronProductionRecoveryCapsule(input) {
  assertExactKeys(input, ["binding", "capsulePath", "expectedCapsuleSha256"],
    "packed recovery capsule read input");
  const binding = assertRecoveryBinding(input.binding);
  const capsulePath = requiredAbsolutePath(input.capsulePath, "packed recovery capsule");
  assertEqual(
    path.basename(capsulePath),
    ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PACKAGE_NAME,
    "packed recovery capsule filename"
  );
  const file = await readStableFile(
    capsulePath,
    MAX_PACKAGE_BYTES,
    "packed recovery capsule"
  );
  assertEqual(
    file.sha256,
    requiredDigest(input.expectedCapsuleSha256, "packed recovery capsule SHA-256"),
    "packed recovery capsule SHA-256"
  );
  const capsule = parseCanonicalJson(file.source, "packed recovery capsule");
  const decoded = assertPackage(capsule);
  const manifestEntry = decoded.files[ELECTRON_PRODUCTION_RECOVERY_CAPSULE_MANIFEST_NAME];
  const manifest = parseCanonicalJson(
    manifestEntry.source,
    "packed recovery capsule manifest"
  );
  const payloadFiles = Object.fromEntries(
    ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PAYLOAD_PATHS.map((relativePath) => [
      relativePath,
      decoded.files[relativePath]
    ])
  );
  const verified = verifyPayloadBindings(payloadFiles, binding);
  verifyManifest(manifest, payloadFiles, verified, binding);
  assertEqual(capsule.manifest.bytes, manifestEntry.bytes,
    "packed recovery capsule manifest byte length");
  assertEqual(capsule.manifest.sha256, manifestEntry.sha256,
    "packed recovery capsule manifest digest");
  assertEqual(capsule.intent.bytes, decoded.files[FILES.intent].bytes,
    "packed recovery capsule intent byte length");
  assertEqual(capsule.intent.sha256, decoded.files[FILES.intent].sha256,
    "packed recovery capsule intent digest");
  assertEqual(capsule.intent.sha256, manifest.intentSha256,
    "manifest-bound publication intent digest");

  return deepFreeze({
    binding,
    capsule: stripDecodedSources(decoded),
    capsuleIdentity: {
      bytes: file.bytes,
      fileName: path.basename(capsulePath),
      sha256: file.sha256
    },
    capsulePath,
    files: identitiesOf(decoded.files),
    foundation: verified,
    manifest,
    manifestIdentity: {
      bytes: manifestEntry.bytes,
      fileName: ELECTRON_PRODUCTION_RECOVERY_CAPSULE_MANIFEST_NAME,
      sha256: manifestEntry.sha256
    },
    payloads: encodedPayloadsOf(decoded.files)
  });
}

export async function readElectronProductionRecoveryCapsuleSelfBound(input) {
  assertExactKeys(input, ["capsulePath", "expectedCapsuleSha256"],
    "self-bound packed recovery capsule read input");
  const capsulePath = requiredAbsolutePath(
    input.capsulePath,
    "self-bound packed recovery capsule"
  );
  assertEqual(
    path.basename(capsulePath),
    ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PACKAGE_NAME,
    "self-bound packed recovery capsule filename"
  );
  const file = await readStableFile(
    capsulePath,
    MAX_PACKAGE_BYTES,
    "self-bound packed recovery capsule"
  );
  const expectedCapsuleSha256 = requiredDigest(
    input.expectedCapsuleSha256,
    "self-bound packed recovery capsule SHA-256"
  );
  assertEqual(file.sha256, expectedCapsuleSha256,
    "self-bound packed recovery capsule SHA-256");
  const decoded = assertPackage(parseCanonicalJson(
    file.source,
    "self-bound packed recovery capsule"
  ));
  const manifest = parseCanonicalJson(
    decoded.files[ELECTRON_PRODUCTION_RECOVERY_CAPSULE_MANIFEST_NAME].source,
    "self-bound packed recovery capsule manifest"
  );
  const binding = assertRecoveryBinding({
    transaction: manifest.transaction,
    lease: {
      id: manifest.lease?.id,
      generation: manifest.lease?.generation,
      eventSha256: manifest.lease?.eventSha256
    },
    control: manifest.control,
    candidate: candidateBindingFromManifest(manifest.candidate),
    priorCandidate: candidateBindingFromManifest(manifest.priorCandidate)
  });
  const capsule = await readElectronProductionRecoveryCapsule({
    binding,
    capsulePath,
    expectedCapsuleSha256
  });
  return deepFreeze({ binding, capsule });
}

export async function readElectronProductionRecoveryCapsuleDirectory(input) {
  assertExactKeys(input, ["binding", "expectedManifestSha256", "sourceRoot"],
    "recovery capsule directory read input");
  const binding = assertRecoveryBinding(input.binding);
  const root = await requiredStableDirectory(input.sourceRoot, "recovery capsule root");
  const captured = await captureClosedTree({
    expectedPaths: ALL_CAPSULE_PATHS,
    maximumFileBytes: MAX_PAYLOAD_FILE_BYTES,
    maximumTotalBytes: MAX_TOTAL_PAYLOAD_BYTES + MAX_MANIFEST_BYTES,
    root
  });
  const manifestEntry = captured.files[ELECTRON_PRODUCTION_RECOVERY_CAPSULE_MANIFEST_NAME];
  assertEqual(
    manifestEntry.sha256,
    requiredDigest(input.expectedManifestSha256, "recovery capsule manifest SHA-256"),
    "recovery capsule manifest SHA-256"
  );
  const manifest = parseCanonicalJson(manifestEntry.source, "recovery capsule manifest");
  const payloadFiles = Object.fromEntries(
    ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PAYLOAD_PATHS.map((relativePath) => [
      relativePath,
      captured.files[relativePath]
    ])
  );
  const verified = verifyPayloadBindings(payloadFiles, binding);
  verifyManifest(manifest, payloadFiles, verified, binding);
  return deepFreeze({
    files: identitiesOf(captured.files),
    manifest,
    manifestIdentity: {
      bytes: manifestEntry.bytes,
      fileName: ELECTRON_PRODUCTION_RECOVERY_CAPSULE_MANIFEST_NAME,
      sha256: manifestEntry.sha256
    },
    sourceRoot: root.path
  });
}

export async function materializeElectronProductionRecoveryCapsule(
  input,
  dependencyOverrides = {}
) {
  assertExactKeys(input, [
    "binding",
    "capsulePath",
    "expectedCapsuleSha256",
    "expectedManifestSha256",
    "outputRoot"
  ], "recovery capsule materialization input");
  const dependencies = resolveMaterializationDependencies(dependencyOverrides);
  const binding = assertRecoveryBinding(input.binding);
  const capsule = await readElectronProductionRecoveryCapsule({
    binding,
    capsulePath: input.capsulePath,
    expectedCapsuleSha256: input.expectedCapsuleSha256
  });
  assertEqual(
    capsule.manifestIdentity.sha256,
    requiredDigest(
      input.expectedManifestSha256,
      "materialized recovery capsule manifest SHA-256"
    ),
    "materialized recovery capsule manifest SHA-256"
  );
  const sources = materializationSources(capsule);
  const output = await resolveCreateNewMaterializationRoot(input.outputRoot);
  await mkdir(output.path, { mode: 0o700 });
  let rootIdentity;
  try {
    rootIdentity = await captureCreatedDirectoryIdentity(
      output.path,
      "materialized recovery capsule root"
    );
    await assertDirectoryNodeIdentity(
      output.parentPath,
      output.parentIdentity,
      "materialized recovery capsule parent"
    );
    const directories = new Map([["", rootIdentity]]);
    for (const relativeDirectory of materializationDirectories()) {
      const parentRelative = path.posix.dirname(relativeDirectory);
      const normalizedParent = parentRelative === "." ? "" : parentRelative;
      await assertDirectoryNodeIdentity(
        materializedPath(output.path, normalizedParent),
        directories.get(normalizedParent),
        `materialized recovery capsule directory ${normalizedParent || "."}`
      );
      const directoryPath = materializedPath(output.path, relativeDirectory);
      await mkdir(directoryPath, { mode: 0o700 });
      directories.set(
        relativeDirectory,
        await captureCreatedDirectoryIdentity(
          directoryPath,
          `materialized recovery capsule directory ${relativeDirectory}`
        )
      );
    }
    for (const relativePath of ALL_CAPSULE_PATHS) {
      const parentRelative = path.posix.dirname(relativePath);
      const normalizedParent = parentRelative === "." ? "" : parentRelative;
      await assertDirectoryNodeIdentity(
        materializedPath(output.path, normalizedParent),
        directories.get(normalizedParent),
        `materialized recovery capsule directory ${normalizedParent || "."}`
      );
      await dependencies.writeFile(
        materializedPath(output.path, relativePath),
        sources[relativePath]
      );
    }
    const directory = await dependencies.readDirectory({
      binding,
      expectedManifestSha256: capsule.manifestIdentity.sha256,
      sourceRoot: output.path
    });
    assertDirectoryMatchesCapsule(capsule, directory);
    await assertDirectoryNodeIdentity(
      output.path,
      rootIdentity,
      "materialized recovery capsule root"
    );
    await assertDirectoryNodeIdentity(
      output.parentPath,
      output.parentIdentity,
      "materialized recovery capsule parent"
    );
    return deepFreeze({
      ...capsule,
      materializedRoot: directory.sourceRoot
    });
  } catch (error) {
    if (rootIdentity !== undefined) {
      await removeMaterializationRootIfSame(output.path, rootIdentity);
    }
    throw error;
  }
}

function materializationSources(capsule) {
  assertExactKeys(
    capsule.payloads,
    ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PAYLOAD_PATHS,
    "materialized recovery capsule payload inventory"
  );
  const sources = {};
  let totalBytes = 0;
  for (const relativePath of ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PAYLOAD_PATHS) {
    const entry = capsule.payloads[relativePath];
    assertExactKeys(entry, ["bytes", "contentBase64", "sha256"],
      `materialized recovery capsule payload ${relativePath}`);
    const source = decodeCanonicalBase64(
      entry.contentBase64,
      MAX_PAYLOAD_FILE_BYTES,
      relativePath
    );
    assertEqual(source.length, entry.bytes,
      `materialized recovery capsule payload ${relativePath} byte length`);
    assertEqual(sha256(source), entry.sha256,
      `materialized recovery capsule payload ${relativePath} SHA-256`);
    sources[relativePath] = source;
    totalBytes += source.length;
  }
  const manifestSource = serializeCanonicalJson(capsule.manifest);
  assertEqual(manifestSource.length, capsule.manifestIdentity.bytes,
    "materialized recovery capsule manifest byte length");
  assertEqual(sha256(manifestSource), capsule.manifestIdentity.sha256,
    "materialized recovery capsule manifest SHA-256");
  sources[ELECTRON_PRODUCTION_RECOVERY_CAPSULE_MANIFEST_NAME] = manifestSource;
  totalBytes += manifestSource.length;
  assertEqual(totalBytes, capsule.capsule.totalFileBytes,
    "materialized recovery capsule total byte length");
  assertExactKeys(sources, ALL_CAPSULE_PATHS,
    "materialized recovery capsule file inventory");
  return sources;
}

function materializationDirectories() {
  return [...buildExpectedTree(ALL_CAPSULE_PATHS).keys()]
    .filter((relativePath) => relativePath !== "")
    .sort((left, right) => {
      const depth = left.split("/").length - right.split("/").length;
      return depth === 0 ? compareStrings(left, right) : depth;
    });
}

function assertDirectoryMatchesCapsule(capsule, directory) {
  if (!isDeepStrictEqual(capsule.manifestIdentity, directory.manifestIdentity)) {
    throw new Error(
      "The materialized recovery capsule manifest identity differs from its package."
    );
  }
  if (!isDeepStrictEqual(capsule.manifest, directory.manifest)) {
    throw new Error(
      "The materialized recovery capsule manifest differs from its package."
    );
  }
  if (!isDeepStrictEqual(capsule.files, directory.files)) {
    throw new Error(
      "The materialized recovery capsule inventory differs from its package."
    );
  }
}

function resolveMaterializationDependencies(overrides) {
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new Error("Recovery capsule materialization dependencies must be an object.");
  }
  const allowed = new Set(["readDirectory", "writeFile"]);
  for (const name of Object.keys(overrides)) {
    if (!allowed.has(name)) {
      throw new Error(
        `Unknown recovery capsule materialization dependency ${name}.`
      );
    }
  }
  const dependencies = {
    readDirectory: overrides.readDirectory ??
      readElectronProductionRecoveryCapsuleDirectory,
    writeFile: overrides.writeFile ?? writeExclusive
  };
  if (Object.values(dependencies).some((dependency) =>
    typeof dependency !== "function"
  )) {
    throw new Error("Recovery capsule materialization dependencies are invalid.");
  }
  return Object.freeze(dependencies);
}

function buildManifest(payloads, verified, binding) {
  const files = identitiesOf(payloads.files);
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_RECOVERY_CAPSULE_KIND,
    status: MANIFEST_STATUS,
    terminal: false,
    publicationMutationOccurred: false,
    recoveryRequiredOnUnknownCompletion: true,
    transaction: { id: binding.transaction.id },
    lease: {
      id: binding.lease.id,
      generation: binding.lease.generation,
      status: "held",
      purpose: "electron-v23-provisional-publication",
      eventSha256: binding.lease.eventSha256,
      heldLeaseSha256: files[FILES.lease].sha256,
      acquireOperationSha256: files[FILES.leaseAcquireOperation].sha256,
      evidenceSha256: files[FILES.heldEvidence].sha256
    },
    control: { ...binding.control },
    candidate: {
      ...binding.candidate,
      receiptSha256: files[FILES.candidateReceipt].sha256,
      trustedControlReceiptSha256: files[FILES.candidateControl].sha256,
      verificationSha256: files[FILES.candidateVerification].sha256
    },
    priorCandidate: {
      ...binding.priorCandidate,
      receiptSha256: files[FILES.priorCandidateReceipt].sha256,
      trustedControlReceiptSha256: files[FILES.priorCandidateControl].sha256,
      verificationSha256: files[FILES.priorCandidateVerification].sha256
    },
    source: {
      runtime: "tauri-v22",
      version: verified.intent.baseline.version,
      stateSha256: verified.intent.baseline.stateSha256,
      snapshotSha256: files[FILES.sourceSnapshot].sha256,
      lineage: {
        "darwin-aarch64": files[FILES.lineageMacos].sha256,
        "windows-x86_64": files[FILES.lineageWindows].sha256
      }
    },
    target: {
      runtime: "electron-v23",
      sourceSha: binding.candidate.sourceSha,
      version: binding.candidate.version,
      stateSha256: verified.intent.target.stateSha256,
      stagedSnapshotSha256: files[FILES.stagedSnapshot].sha256,
      projectionSha256: files[FILES.targetProjection].sha256
    },
    stagingPlanSha256: files[FILES.plan].sha256,
    intentSha256: files[FILES.intent].sha256,
    payloadCount: ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PAYLOAD_PATHS.length,
    payloadBytes: payloads.totalBytes,
    files
  });
}

function buildPackage(complete, manifestFile, intentFile) {
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PACKAGE_KIND,
    encoding: PACKAGE_ENCODING,
    fileCount: ALL_CAPSULE_PATHS.length,
    totalFileBytes: complete.totalBytes,
    manifest: {
      path: ELECTRON_PRODUCTION_RECOVERY_CAPSULE_MANIFEST_NAME,
      bytes: manifestFile.bytes,
      sha256: manifestFile.sha256
    },
    intent: {
      path: FILES.intent,
      bytes: intentFile.bytes,
      sha256: intentFile.sha256
    },
    files: Object.fromEntries(ALL_CAPSULE_PATHS.map((relativePath) => {
      const file = complete.files[relativePath];
      return [relativePath, {
        bytes: file.bytes,
        contentBase64: file.source.toString("base64"),
        sha256: file.sha256
      }];
    }))
  });
}

function assertPackage(value) {
  assertExactKeys(value, [
    "encoding",
    "fileCount",
    "files",
    "intent",
    "kind",
    "manifest",
    "schemaVersion",
    "totalFileBytes"
  ], "packed recovery capsule");
  assertEqual(value.schemaVersion, 1, "packed recovery capsule schema version");
  assertEqual(value.kind, ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PACKAGE_KIND,
    "packed recovery capsule kind");
  assertEqual(value.encoding, PACKAGE_ENCODING, "packed recovery capsule encoding");
  assertEqual(value.fileCount, ALL_CAPSULE_PATHS.length,
    "packed recovery capsule file count");
  assertExactKeys(value.manifest, ["bytes", "path", "sha256"],
    "packed recovery capsule manifest identity");
  assertExactKeys(value.intent, ["bytes", "path", "sha256"],
    "packed recovery capsule intent identity");
  assertEqual(value.manifest.path, ELECTRON_PRODUCTION_RECOVERY_CAPSULE_MANIFEST_NAME,
    "packed recovery capsule manifest path");
  assertEqual(value.intent.path, FILES.intent,
    "packed recovery capsule intent path");
  assertExactKeys(value.files, ALL_CAPSULE_PATHS,
    "packed recovery capsule file inventory");

  const files = {};
  let totalBytes = 0;
  for (const relativePath of ALL_CAPSULE_PATHS) {
    assertSafeRelativePath(relativePath);
    const entry = value.files[relativePath];
    assertExactKeys(entry, ["bytes", "contentBase64", "sha256"],
      `packed recovery capsule file ${relativePath}`);
    const maximumBytes = relativePath === ELECTRON_PRODUCTION_RECOVERY_CAPSULE_MANIFEST_NAME
      ? MAX_MANIFEST_BYTES
      : MAX_PAYLOAD_FILE_BYTES;
    const bytes = requiredBoundedPositiveInteger(
      entry.bytes,
      maximumBytes,
      `packed recovery capsule file ${relativePath} byte length`
    );
    const source = decodeCanonicalBase64(entry.contentBase64, maximumBytes, relativePath);
    assertEqual(source.length, bytes,
      `packed recovery capsule file ${relativePath} decoded byte length`);
    const digest = requiredDigest(entry.sha256,
      `packed recovery capsule file ${relativePath} SHA-256`);
    assertEqual(sha256(source), digest,
      `packed recovery capsule file ${relativePath} SHA-256`);
    files[relativePath] = { bytes, sha256: digest, source };
    totalBytes += bytes;
  }
  assertEqual(
    requiredBoundedPositiveInteger(
      value.totalFileBytes,
      MAX_TOTAL_PAYLOAD_BYTES + MAX_MANIFEST_BYTES,
      "packed recovery capsule total file bytes"
    ),
    totalBytes,
    "packed recovery capsule total file bytes"
  );
  return { ...value, files };
}

function verifyManifest(value, payloadFiles, verified, binding) {
  assertExactKeys(value, [
    "candidate",
    "control",
    "files",
    "intentSha256",
    "kind",
    "lease",
    "payloadBytes",
    "payloadCount",
    "priorCandidate",
    "publicationMutationOccurred",
    "recoveryRequiredOnUnknownCompletion",
    "schemaVersion",
    "source",
    "stagingPlanSha256",
    "status",
    "target",
    "terminal",
    "transaction"
  ], "recovery capsule manifest");
  assertEqual(value.schemaVersion, 1, "recovery capsule manifest schema version");
  assertEqual(value.kind, ELECTRON_PRODUCTION_RECOVERY_CAPSULE_KIND,
    "recovery capsule manifest kind");
  assertEqual(value.status, MANIFEST_STATUS, "recovery capsule manifest status");
  assertEqual(value.terminal, false, "recovery capsule manifest terminality");
  assertEqual(value.publicationMutationOccurred, false,
    "recovery capsule pre-mutation status");
  assertEqual(value.recoveryRequiredOnUnknownCompletion, true,
    "recovery capsule unknown-completion policy");
  assertExactKeys(value.files, ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PAYLOAD_PATHS,
    "recovery capsule manifest file inventory");
  const expectedFiles = identitiesOf(payloadFiles);
  if (!isDeepStrictEqual(value.files, expectedFiles)) {
    throw new Error("The recovery capsule manifest file identities do not match.");
  }
  assertEqual(value.payloadCount, ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PAYLOAD_PATHS.length,
    "recovery capsule manifest payload count");
  assertEqual(value.payloadBytes, totalIdentityBytes(expectedFiles),
    "recovery capsule manifest payload bytes");

  assertExactKeys(value.transaction, ["id"], "recovery capsule transaction");
  assertEqual(value.transaction.id, binding.transaction.id,
    "recovery capsule transaction ID");
  assertLeaseManifest(value.lease, binding, expectedFiles);
  assertControl(value.control, binding.control, "recovery capsule control");
  assertCandidateManifest(
    value.candidate,
    binding.candidate,
    expectedFiles,
    false
  );
  assertCandidateManifest(
    value.priorCandidate,
    binding.priorCandidate,
    expectedFiles,
    true
  );
  assertSourceManifest(value.source, verified, expectedFiles);
  assertTargetManifest(value.target, verified, binding, expectedFiles);
  assertEqual(value.stagingPlanSha256, expectedFiles[FILES.plan].sha256,
    "recovery capsule staging-plan digest");
  assertEqual(value.intentSha256, expectedFiles[FILES.intent].sha256,
    "recovery capsule publication-intent digest");
  return value;
}

function verifyPayloadBindings(files, binding) {
  const values = Object.fromEntries(
    ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PAYLOAD_PATHS.map((relativePath) => [
      relativePath,
      parseCanonicalJson(files[relativePath].source, `recovery capsule payload ${relativePath}`)
    ])
  );
  const intent = assertElectronProductionPublicationReceipt(values[FILES.intent]);
  if (intent.phase !== "intent" || intent.terminal !== false || intent.revision !== 1) {
    throw new Error("The recovery capsule publication receipt is not an initial intent.");
  }
  assertEqual(intent.transactionId, binding.transaction.id,
    "recovery capsule intent transaction ID");
  assertEqual(intent.lease.id, binding.lease.id,
    "recovery capsule intent lease ID");
  assertEqual(intent.lease.generation, binding.lease.generation,
    "recovery capsule intent lease generation");
  assertEqual(intent.target.sourceSha, binding.candidate.sourceSha,
    "recovery capsule intent target source SHA");
  assertEqual(intent.target.version, binding.candidate.version,
    "recovery capsule intent target version");
  assertEqual(intent.target.candidateReceiptSha256, files[FILES.candidateReceipt].sha256,
    "recovery capsule intent candidate receipt digest");

  const lease = assertElectronProductionPublicLatestLease(values[FILES.lease]);
  assertHeldLease(lease, intent, binding);
  const sourceSnapshot = assertElectronProductionPublicLatestSnapshot(
    values[FILES.sourceSnapshot]
  );
  const stagedSnapshot = assertElectronProductionPublicLatestSnapshot(
    values[FILES.stagedSnapshot]
  );
  const targetProjection = assertElectronProductionPublicLatestSnapshot(
    values[FILES.targetProjection]
  );
  assertSnapshotBindings({ intent, sourceSnapshot, stagedSnapshot, targetProjection });

  assertCandidateReceipt(
    values[FILES.candidateReceipt],
    binding.candidate,
    "target candidate receipt"
  );
  assertCandidateReceipt(
    values[FILES.priorCandidateReceipt],
    binding.priorCandidate,
    "prior candidate receipt"
  );
  assertCandidateControl(
    values[FILES.candidateControl],
    binding.candidate,
    "target candidate trusted-control receipt"
  );
  assertCandidateControl(
    values[FILES.priorCandidateControl],
    binding.priorCandidate,
    "prior candidate trusted-control receipt"
  );
  assertCandidateVerification(
    values[FILES.candidateVerification],
    binding.candidate,
    files,
    false
  );
  assertCandidateVerification(
    values[FILES.priorCandidateVerification],
    binding.priorCandidate,
    files,
    true
  );
  assertStagingPlan(values[FILES.plan], binding, files, intent);
  assertSemanticVersionIsNewer(
    binding.candidate.version,
    binding.priorCandidate.version,
    "recovery capsule target relative to prior Electron candidate"
  );
  return { intent, lease, sourceSnapshot, stagedSnapshot, targetProjection };
}

function assertHeldLease(lease, intent, binding) {
  assertEqual(lease.transactionId, binding.transaction.id,
    "recovery capsule held-lease transaction ID");
  assertEqual(lease.leaseId, binding.lease.id,
    "recovery capsule held-lease ID");
  assertEqual(lease.generation, binding.lease.generation,
    "recovery capsule held-lease generation");
  assertEqual(lease.status, "held", "recovery capsule held-lease status");
  assertEqual(lease.purpose, "electron-v23-provisional-publication",
    "recovery capsule held-lease purpose");
  assertControl(lease.holder, binding.control, "recovery capsule held-lease holder");
  assertEqual(
    electronProductionPublicLatestLeaseEventSha256(lease),
    binding.lease.eventSha256,
    "recovery capsule held-lease event digest"
  );
  assertEqual(lease.source.runtime, "tauri-v22",
    "recovery capsule held-lease source runtime");
  assertEqual(lease.source.version, intent.baseline.version,
    "recovery capsule held-lease source version");
  assertEqual(lease.source.stateSha256, intent.baseline.stateSha256,
    "recovery capsule held-lease source state");
  assertEqual(lease.target.runtime, "electron-v23",
    "recovery capsule held-lease target runtime");
  assertEqual(lease.target.version, intent.target.version,
    "recovery capsule held-lease target version");
  assertEqual(lease.target.stateSha256, intent.target.stateSha256,
    "recovery capsule held-lease target state");
}

function assertSnapshotBindings(input) {
  const { intent, sourceSnapshot, stagedSnapshot, targetProjection } = input;
  if (sourceSnapshot.observationKind !== "observed-release" ||
      sourceSnapshot.release.isLatest !== true ||
      sourceSnapshot.candidateReceipt !== null) {
    throw new Error("The recovery capsule source snapshot is not the observed Tauri latest.");
  }
  if (stagedSnapshot.observationKind !== "observed-release" ||
      stagedSnapshot.release.isLatest !== false ||
      stagedSnapshot.candidateReceipt === null) {
    throw new Error("The recovery capsule staged target is not a non-latest Electron release.");
  }
  const expectedProjection = deriveElectronProductionExpectedLatestState(stagedSnapshot);
  if (!isDeepStrictEqual(expectedProjection, targetProjection)) {
    throw new Error("The recovery capsule target projection is not derived from its staged target.");
  }
  assertEqual(sourceSnapshot.latestJson.version, intent.baseline.version,
    "recovery capsule source snapshot version");
  assertEqual(sourceSnapshot.release.tag, intent.baseline.releaseTag,
    "recovery capsule source snapshot tag");
  assertEqual(sourceSnapshot.release.targetCommitish, intent.baseline.sourceSha,
    "recovery capsule source snapshot commit");
  assertEqual(sourceSnapshot.latestJson.sha256, intent.baseline.manifestSha256,
    "recovery capsule source manifest digest");
  assertEqual(sourceSnapshot.stateSha256, intent.baseline.stateSha256,
    "recovery capsule source state digest");
  assertEqual(targetProjection.latestJson.version, intent.target.version,
    "recovery capsule target projection version");
  assertEqual(targetProjection.release.tag, intent.target.releaseTag,
    "recovery capsule target projection tag");
  assertEqual(targetProjection.candidateReceipt?.sourceSha, intent.target.sourceSha,
    "recovery capsule target projection source SHA");
  assertEqual(targetProjection.candidateReceipt?.sha256,
    intent.target.candidateReceiptSha256,
    "recovery capsule target candidate digest");
  assertEqual(targetProjection.latestJson.sha256, intent.target.manifestSha256,
    "recovery capsule target manifest digest");
  assertEqual(targetProjection.stateSha256, intent.target.stateSha256,
    "recovery capsule target state digest");
}

function assertCandidateReceipt(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`The ${label} must be an object.`);
  }
  assertEqual(value.kind, "rion-electron-production-candidate", `${label} kind`);
  assertEqual(value.status, "verified-not-published", `${label} status`);
  assertEqual(value.sourceSha, expected.sourceSha, `${label} source SHA`);
  assertEqual(value.version, expected.version, `${label} version`);
  if (value.publication?.allowedByThisWorkflow !== false) {
    throw new Error(`The ${label} must not carry publication authority.`);
  }
}

function assertCandidateControl(value, expected, label) {
  assertExactKeys(value, [
    "candidate",
    "controlPlane",
    "kind",
    "ownerApproval",
    "producer",
    "schemaVersion",
    "updaterTrust"
  ], label);
  assertEqual(value.schemaVersion, 1, `${label} schema version`);
  assertEqual(value.kind, "rion-electron-production-candidate-trusted-control",
    `${label} kind`);
  assertEqual(value.candidate?.sourceSha, expected.sourceSha, `${label} source SHA`);
  assertEqual(value.candidate?.version, expected.version, `${label} version`);
  assertExactKeys(value.controlPlane, ["ref", "repository", "sha", "workflow"],
    `${label} control plane`);
  assertEqual(value.controlPlane.ref, "refs/heads/main", `${label} control ref`);
  assertEqual(value.controlPlane.repository, SOURCE_REPOSITORY,
    `${label} control repository`);
  assertEqual(value.controlPlane.workflow, CANDIDATE_WORKFLOW,
    `${label} control workflow`);
  assertEqual(value.controlPlane.sha, expected.controlSha, `${label} control SHA`);
  assertExactKeys(value.producer, ["event", "runAttempt", "runId"],
    `${label} producer`);
  assertEqual(value.producer.event, "workflow_dispatch", `${label} producer event`);
  assertEqual(value.producer.runId, expected.runId, `${label} producer run ID`);
  assertEqual(value.producer.runAttempt, expected.runAttempt,
    `${label} producer run attempt`);
}

function assertCandidateVerification(value, expected, files, prior) {
  const label = prior ? "prior candidate verification" : "target candidate verification";
  const receiptPath = prior ? FILES.priorCandidateReceipt : FILES.candidateReceipt;
  const controlPath = prior ? FILES.priorCandidateControl : FILES.candidateControl;
  assertExactKeys(value, [
    "candidate",
    "controlPlane",
    "kind",
    "producer",
    "schemaVersion",
    "trustedControlReceiptSha256"
  ], label);
  assertEqual(value.schemaVersion, 1, `${label} schema version`);
  assertEqual(
    value.kind,
    `rion-electron-production-${prior ? "prior" : "target"}-candidate-verification`,
    `${label} kind`
  );
  assertEqual(value.candidate?.receiptSha256, files[receiptPath].sha256,
    `${label} receipt digest`);
  assertEqual(value.candidate?.sourceSha, expected.sourceSha, `${label} source SHA`);
  assertEqual(value.candidate?.version, expected.version, `${label} version`);
  assertEqual(value.controlPlane?.ref, "refs/heads/main", `${label} control ref`);
  assertEqual(value.controlPlane?.repository, SOURCE_REPOSITORY,
    `${label} control repository`);
  assertEqual(value.controlPlane?.workflow, CANDIDATE_WORKFLOW,
    `${label} control workflow`);
  assertEqual(value.controlPlane?.sha, expected.controlSha, `${label} control SHA`);
  assertEqual(value.producer?.runId, expected.runId, `${label} run ID`);
  assertEqual(value.producer?.runAttempt, expected.runAttempt, `${label} run attempt`);
  assertEqual(value.trustedControlReceiptSha256, files[controlPath].sha256,
    `${label} trusted-control receipt digest`);
}

function assertStagingPlan(value, binding, files, intent) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The recovery capsule staging plan must be an object.");
  }
  assertEqual(value.kind, "rion-electron-production-publication-staging-plan",
    "recovery capsule staging-plan kind");
  assertEqual(value.status, "verified-pre-publication-staging-plan",
    "recovery capsule staging-plan status");
  assertEqual(value.terminal, false, "recovery capsule staging-plan terminality");
  assertEqual(value.publicationMutationAllowed, false,
    "recovery capsule staging-plan mutation policy");
  assertEqual(value.transaction?.id, binding.transaction.id,
    "recovery capsule staging-plan transaction ID");
  assertEqual(value.lease?.id, binding.lease.id,
    "recovery capsule staging-plan lease ID");
  assertEqual(value.lease?.generation, binding.lease.generation,
    "recovery capsule staging-plan lease generation");
  assertEqual(value.source?.runtime, "tauri-v22",
    "recovery capsule staging-plan source runtime");
  assertEqual(value.source?.version, intent.baseline.version,
    "recovery capsule staging-plan source version");
  assertEqual(value.source?.snapshot?.fileSha256, files[FILES.sourceSnapshot].sha256,
    "recovery capsule staging-plan source snapshot digest");
  assertEqual(value.source?.lineage?.receipts?.["darwin-aarch64"]?.sha256,
    files[FILES.lineageMacos].sha256,
    "recovery capsule staging-plan macOS lineage digest");
  assertEqual(value.source?.lineage?.receipts?.["windows-x86_64"]?.sha256,
    files[FILES.lineageWindows].sha256,
    "recovery capsule staging-plan Windows lineage digest");
  assertEqual(value.target?.runtime, "electron-v23",
    "recovery capsule staging-plan target runtime");
  assertEqual(value.target?.sourceSha, binding.candidate.sourceSha,
    "recovery capsule staging-plan target source SHA");
  assertEqual(value.target?.version, binding.candidate.version,
    "recovery capsule staging-plan target version");
  assertEqual(value.target?.candidateReceipt?.sha256, files[FILES.candidateReceipt].sha256,
    "recovery capsule staging-plan candidate digest");
  assertEqual(value.provenance?.candidate?.runId, binding.candidate.runId,
    "recovery capsule staging-plan candidate run ID");
  assertEqual(value.provenance?.candidate?.runAttempt, binding.candidate.runAttempt,
    "recovery capsule staging-plan candidate run attempt");
}

function assertLeaseManifest(value, binding, files) {
  assertExactKeys(value, [
    "acquireOperationSha256",
    "eventSha256",
    "evidenceSha256",
    "generation",
    "heldLeaseSha256",
    "id",
    "purpose",
    "status"
  ], "recovery capsule lease manifest");
  assertEqual(value.id, binding.lease.id, "recovery capsule lease-manifest ID");
  assertEqual(value.generation, binding.lease.generation,
    "recovery capsule lease-manifest generation");
  assertEqual(value.status, "held", "recovery capsule lease-manifest status");
  assertEqual(value.purpose, "electron-v23-provisional-publication",
    "recovery capsule lease-manifest purpose");
  assertEqual(value.eventSha256, binding.lease.eventSha256,
    "recovery capsule lease-manifest event digest");
  assertEqual(value.heldLeaseSha256, files[FILES.lease].sha256,
    "recovery capsule held-lease file digest");
  assertEqual(value.acquireOperationSha256, files[FILES.leaseAcquireOperation].sha256,
    "recovery capsule lease-acquire operation digest");
  assertEqual(value.evidenceSha256, files[FILES.heldEvidence].sha256,
    "recovery capsule held-lease evidence digest");
}

function assertCandidateManifest(value, expected, files, prior) {
  assertExactKeys(value, [
    "controlSha",
    "receiptSha256",
    "runAttempt",
    "runId",
    "sourceSha",
    "trustedControlReceiptSha256",
    "verificationSha256",
    "version"
  ], prior ? "recovery capsule prior candidate" : "recovery capsule candidate");
  const expectedValue = {
    ...expected,
    receiptSha256: files[
      prior ? FILES.priorCandidateReceipt : FILES.candidateReceipt
    ].sha256,
    trustedControlReceiptSha256: files[
      prior ? FILES.priorCandidateControl : FILES.candidateControl
    ].sha256,
    verificationSha256: files[
      prior ? FILES.priorCandidateVerification : FILES.candidateVerification
    ].sha256
  };
  if (!isDeepStrictEqual(value, expectedValue)) {
    throw new Error(`The recovery capsule ${prior ? "prior " : ""}candidate identity changed.`);
  }
}

function assertSourceManifest(value, verified, files) {
  assertExactKeys(value, [
    "lineage",
    "runtime",
    "snapshotSha256",
    "stateSha256",
    "version"
  ], "recovery capsule source manifest");
  assertEqual(value.runtime, "tauri-v22", "recovery capsule source runtime");
  assertEqual(value.version, verified.intent.baseline.version,
    "recovery capsule source version");
  assertEqual(value.stateSha256, verified.intent.baseline.stateSha256,
    "recovery capsule source state digest");
  assertEqual(value.snapshotSha256, files[FILES.sourceSnapshot].sha256,
    "recovery capsule source snapshot digest");
  assertExactKeys(value.lineage, ["darwin-aarch64", "windows-x86_64"],
    "recovery capsule lineage digest map");
  assertEqual(value.lineage["darwin-aarch64"], files[FILES.lineageMacos].sha256,
    "recovery capsule macOS lineage digest");
  assertEqual(value.lineage["windows-x86_64"], files[FILES.lineageWindows].sha256,
    "recovery capsule Windows lineage digest");
}

function assertTargetManifest(value, verified, binding, files) {
  assertExactKeys(value, [
    "projectionSha256",
    "runtime",
    "sourceSha",
    "stagedSnapshotSha256",
    "stateSha256",
    "version"
  ], "recovery capsule target manifest");
  assertEqual(value.runtime, "electron-v23", "recovery capsule target runtime");
  assertEqual(value.sourceSha, binding.candidate.sourceSha,
    "recovery capsule target source SHA");
  assertEqual(value.version, binding.candidate.version,
    "recovery capsule target version");
  assertEqual(value.stateSha256, verified.intent.target.stateSha256,
    "recovery capsule target state digest");
  assertEqual(value.stagedSnapshotSha256, files[FILES.stagedSnapshot].sha256,
    "recovery capsule staged snapshot digest");
  assertEqual(value.projectionSha256, files[FILES.targetProjection].sha256,
    "recovery capsule target projection digest");
}

function assertRecoveryBinding(value) {
  assertExactKeys(value, [
    "candidate",
    "control",
    "lease",
    "priorCandidate",
    "transaction"
  ], "recovery capsule identity binding");
  assertExactKeys(value.transaction, ["id"], "recovery capsule transaction binding");
  const transactionId = requiredUuid(value.transaction.id,
    "recovery capsule transaction ID");
  assertExactKeys(value.lease, ["eventSha256", "generation", "id"],
    "recovery capsule lease binding");
  const leaseId = requiredUuid(value.lease.id, "recovery capsule lease ID");
  if (transactionId === leaseId) {
    throw new Error("The recovery capsule transaction and lease IDs must differ.");
  }
  return deepFreeze({
    transaction: { id: transactionId },
    lease: {
      id: leaseId,
      generation: requiredPositiveInteger(
        value.lease.generation,
        "recovery capsule lease generation"
      ),
      eventSha256: requiredDigest(
        value.lease.eventSha256,
        "recovery capsule lease event SHA-256"
      )
    },
    control: normalizeControl(value.control),
    candidate: normalizeCandidate(value.candidate, "target candidate"),
    priorCandidate: normalizeCandidate(value.priorCandidate, "prior candidate")
  });
}

function normalizeControl(value) {
  assertExactKeys(value, [
    "event",
    "headSha",
    "repository",
    "runAttempt",
    "runId",
    "workflow"
  ], "recovery capsule control binding");
  assertEqual(value.repository, SOURCE_REPOSITORY,
    "recovery capsule control repository");
  assertEqual(value.workflow, PUBLISHER_WORKFLOW,
    "recovery capsule control workflow");
  assertEqual(value.event, "workflow_dispatch", "recovery capsule control event");
  return {
    repository: value.repository,
    workflow: value.workflow,
    event: value.event,
    runId: requiredPositiveIntegerString(value.runId, "recovery capsule control run ID"),
    runAttempt: requiredPositiveInteger(value.runAttempt,
      "recovery capsule control run attempt"),
    headSha: requiredCommitSha(value.headSha, "recovery capsule control SHA")
  };
}

function normalizeCandidate(value, label) {
  assertExactKeys(value, [
    "controlSha",
    "runAttempt",
    "runId",
    "sourceSha",
    "version"
  ], `recovery capsule ${label} binding`);
  return {
    sourceSha: requiredCommitSha(value.sourceSha, `recovery capsule ${label} source SHA`),
    version: requiredSemanticVersion(value.version, `recovery capsule ${label} version`),
    controlSha: requiredCommitSha(value.controlSha,
      `recovery capsule ${label} control SHA`),
    runId: requiredPositiveIntegerString(value.runId,
      `recovery capsule ${label} run ID`),
    runAttempt: requiredPositiveInteger(value.runAttempt,
      `recovery capsule ${label} run attempt`)
  };
}

function candidateBindingFromManifest(value) {
  return {
    controlSha: value?.controlSha,
    runAttempt: value?.runAttempt,
    runId: value?.runId,
    sourceSha: value?.sourceSha,
    version: value?.version
  };
}

function assertControl(actual, expected, label) {
  assertEqual(actual.repository, expected.repository, `${label} repository`);
  assertEqual(actual.workflow, expected.workflow, `${label} workflow`);
  assertEqual(actual.runId, expected.runId, `${label} run ID`);
  assertEqual(actual.runAttempt, expected.runAttempt, `${label} run attempt`);
  assertEqual(actual.headSha, expected.headSha, `${label} head SHA`);
  if (Object.hasOwn(actual, "event")) {
    assertEqual(actual.event, expected.event, `${label} event`);
  }
}

async function captureClosedTree(input) {
  const expectedTree = buildExpectedTree(input.expectedPaths);
  const directorySnapshots = [];
  const observedFiles = [];
  const queue = [""];
  while (queue.length > 0) {
    const relativeDirectory = queue.shift();
    const directoryPath = relativeDirectory === ""
      ? input.root.path
      : path.join(input.root.path, ...relativeDirectory.split("/"));
    const snapshot = await captureDirectorySnapshot(directoryPath, relativeDirectory);
    directorySnapshots.push(snapshot);
    const expectedChildren = expectedTree.get(relativeDirectory) ?? [];
    assertStringArrayEqual(
      snapshot.names,
      expectedChildren,
      `recovery capsule directory ${relativeDirectory || "."}`
    );
    for (const entry of snapshot.entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      if (expectedTree.has(relativePath)) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          throw new Error(`Recovery capsule directory ${relativePath} changed type.`);
        }
        queue.push(relativePath);
      } else {
        if (!entry.isFile() || entry.isSymbolicLink()) {
          throw new Error(
            `Recovery capsule payload ${relativePath} is not a regular file.`
          );
        }
        observedFiles.push(relativePath);
      }
    }
  }
  observedFiles.sort(compareStrings);
  assertStringArrayEqual(observedFiles, input.expectedPaths,
    "recovery capsule payload inventory");
  const files = {};
  let totalBytes = 0;
  for (const relativePath of input.expectedPaths) {
    const maximumBytes = relativePath ===
      ELECTRON_PRODUCTION_RECOVERY_CAPSULE_MANIFEST_NAME
      ? MAX_MANIFEST_BYTES
      : input.maximumFileBytes;
    const file = await captureStableRegularFile(
      path.join(input.root.path, ...relativePath.split("/")),
      maximumBytes,
      `recovery capsule payload ${relativePath}`
    );
    files[relativePath] = file;
    totalBytes += file.bytes;
    if (totalBytes > input.maximumTotalBytes) {
      throw new Error("The recovery capsule exceeds its total byte limit.");
    }
  }
  for (const snapshot of directorySnapshots.toReversed()) {
    await assertDirectorySnapshotUnchanged(snapshot);
  }
  return { files, totalBytes };
}

async function requiredStableDirectory(value, label) {
  const requested = requiredAbsolutePath(value, label);
  const metadata = await lstat(requested, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`The ${label} must be a real directory.`);
  }
  const canonical = await realpath(requested);
  const canonicalMetadata = await lstat(canonical, { bigint: true });
  assertSameMetadata(metadata, canonicalMetadata, label);
  return { path: canonical };
}

async function captureDirectorySnapshot(directoryPath, relativePath) {
  const before = await lstat(directoryPath, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error(`Recovery capsule path ${relativePath || "."} is not a real directory.`);
  }
  const entries = (await readdir(directoryPath, { withFileTypes: true }))
    .sort((left, right) => compareStrings(left.name, right.name));
  const names = entries.map((entry) => entry.name);
  for (const name of names) assertSafeSegment(name);
  const after = await lstat(directoryPath, { bigint: true });
  assertSameMetadata(before, after, `recovery capsule directory ${relativePath || "."}`);
  return { before, directoryPath, entries, names, relativePath };
}

async function assertDirectorySnapshotUnchanged(snapshot) {
  const after = await lstat(snapshot.directoryPath, { bigint: true });
  assertSameMetadata(
    snapshot.before,
    after,
    `recovery capsule directory ${snapshot.relativePath || "."}`
  );
  const names = (await readdir(snapshot.directoryPath)).sort(compareStrings);
  assertStringArrayEqual(
    names,
    snapshot.names,
    `recovery capsule directory ${snapshot.relativePath || "."}`
  );
}

async function captureStableRegularFile(filePath, maximumBytes, label) {
  const before = await lstat(filePath, { bigint: true });
  assertBoundedSingleLinkFile(before, maximumBytes, label);
  const handle = await open(filePath, READ_ONLY_NO_FOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    assertSameMetadata(before, opened, label);
    assertBoundedSingleLinkFile(opened, maximumBytes, label);
    const source = await handle.readFile();
    const completed = await handle.stat({ bigint: true });
    const completedPath = await lstat(filePath, { bigint: true });
    assertSameMetadata(opened, completed, label);
    assertSameMetadata(completed, completedPath, label);
    assertEqual(source.length, Number(opened.size), `${label} byte length`);
    return { bytes: source.length, sha256: sha256(source), source };
  } finally {
    await handle.close();
  }
}

function parseCanonicalJson(source, label) {
  let value;
  try {
    value = JSON.parse(source.toString("utf8"));
  } catch (error) {
    throw new Error(`The ${label} is invalid JSON.`, { cause: error });
  }
  assertBoundedJsonValue(value, label);
  if (!source.equals(serializeCanonicalJson(value))) {
    throw new Error(`The ${label} is not canonical JSON.`);
  }
  return value;
}

function assertBoundedJsonValue(value, label) {
  const pending = [{ depth: 0, value }];
  let nodeCount = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    nodeCount += 1;
    if (nodeCount > MAX_JSON_NODES) {
      throw new Error(`The ${label} exceeds its JSON node limit.`);
    }
    if (current.depth > MAX_JSON_DEPTH) {
      throw new Error(`The ${label} exceeds its JSON depth limit.`);
    }
    if (current.value && typeof current.value === "object") {
      for (const nested of Object.values(current.value)) {
        pending.push({ depth: current.depth + 1, value: nested });
      }
    }
  }
}

function buildExpectedTree(paths) {
  const tree = new Map([["", new Set()]]);
  for (const relativePath of paths) {
    assertSafeRelativePath(relativePath);
    const segments = relativePath.split("/");
    let directory = "";
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      tree.get(directory).add(segment);
      if (index < segments.length - 1) {
        directory = directory ? `${directory}/${segment}` : segment;
        if (!tree.has(directory)) tree.set(directory, new Set());
      }
    }
  }
  return new Map([...tree].map(([directory, children]) => [
    directory,
    [...children].sort(compareStrings)
  ]));
}

function decodeCanonicalBase64(value, maximumBytes, relativePath) {
  const maximumLength = 4 * Math.ceil(maximumBytes / 3);
  if (typeof value !== "string" || value.length === 0 ||
      value.length > maximumLength || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
        .test(value)) {
    throw new Error(`Recovery capsule file ${relativePath} has invalid base64.`);
  }
  const source = Buffer.from(value, "base64");
  if (source.toString("base64") !== value) {
    throw new Error(`Recovery capsule file ${relativePath} has noncanonical base64.`);
  }
  return source;
}

function identitiesOf(files) {
  return Object.fromEntries(Object.keys(files).sort(compareStrings).map((relativePath) => [
    relativePath,
    { bytes: files[relativePath].bytes, sha256: files[relativePath].sha256 }
  ]));
}

function encodedPayloadsOf(files) {
  return Object.fromEntries(
    ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PAYLOAD_PATHS.map((relativePath) => [
      relativePath,
      {
        bytes: files[relativePath].bytes,
        contentBase64: files[relativePath].source.toString("base64"),
        sha256: files[relativePath].sha256
      }
    ])
  );
}

function stripDecodedSources(decoded) {
  return {
    schemaVersion: decoded.schemaVersion,
    kind: decoded.kind,
    encoding: decoded.encoding,
    fileCount: decoded.fileCount,
    totalFileBytes: decoded.totalFileBytes,
    manifest: { ...decoded.manifest },
    intent: { ...decoded.intent }
  };
}

function totalIdentityBytes(files) {
  return Object.values(files).reduce((total, file) => total + file.bytes, 0);
}

function assertBoundedSingleLinkFile(metadata, maximumBytes, label) {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n ||
      metadata.size <= 0n || metadata.size > BigInt(maximumBytes)) {
    throw new Error(`The ${label} must be a bounded nonempty single-link regular file.`);
  }
}

function requiredUuid(value, label) {
  if (typeof value !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
        .test(value)) {
    throw new Error(`The ${label} must be a lowercase RFC 9562 UUID.`);
  }
  return value;
}

function requiredPositiveIntegerString(value, label) {
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value) ||
      !Number.isSafeInteger(Number(value))) {
    throw new Error(`The ${label} must be a positive safe integer string.`);
  }
  return value;
}

function requiredBoundedPositiveInteger(value, maximum, label) {
  const normalized = requiredPositiveInteger(value, label);
  if (normalized > maximum) throw new Error(`The ${label} exceeds its limit.`);
  return normalized;
}

function assertBoundedNonemptyBytes(bytes, maximum, label) {
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > maximum) {
    throw new Error(`The ${label} exceeds its byte limit.`);
  }
}

function assertPathOutsideRoot(filePath, rootPath, label) {
  const relative = path.relative(rootPath, filePath);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." && !path.isAbsolute(relative))) {
    throw new Error(`The ${label} must stay outside the recovery capsule source root.`);
  }
}

function assertStringArrayEqual(actual, expected, label) {
  if (!isDeepStrictEqual(actual, [...expected])) {
    throw new Error(`The ${label} is not exact.`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
