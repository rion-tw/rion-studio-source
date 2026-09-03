import { createHash } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  assertEqual,
  assertExactKeys,
  assertPathOutsideRoot,
  canonicalRegularFilePath,
  publicIdentity,
  readCanonicalJsonFile,
  readStableFile,
  requiredAbsolutePath,
  requiredCommitSha,
  requiredDigest,
  requiredRfc3339,
  requiredSemanticVersion,
  resolveCreateNewFile,
  writeExclusive
} from "./electronUpdaterCompatibilityReceiptIo.mjs";

export const ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_BEFORE_KIND =
  "rion-production-updater-data-preservation-before";
export const ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_OBSERVATION_KIND =
  "rion-production-updater-data-preservation-observation";
export const ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_BEFORE_FILE =
  "data-preservation-before.json";
export const ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_OBSERVATION_FILE =
  "data-preservation-observation.json";
export const ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_SENTINEL_FILE =
  ".rion-production-updater-evidence-challenge";

const MAX_DOCUMENT_BYTES = 1024 * 1024;
const CHALLENGE_NONCE_BYTES = 32;
const READ_ONLY_NO_FOLLOW = fileConstants.O_RDONLY |
  (fileConstants.O_NOFOLLOW ?? 0);
const PLATFORMS = Object.freeze(["darwin-aarch64", "windows-x86_64"]);
const TRANSITIONS = Object.freeze([
  "tauri-v22-to-electron-v23",
  "electron-v23-to-electron-v23"
]);
const PLATFORM_TARGETS = Object.freeze({
  "darwin-aarch64": Object.freeze({
    artifactName: "Rion.Studio-mac.app.tar.gz",
    signatureName: "Rion.Studio-mac.app.tar.gz.sig"
  }),
  "windows-x86_64": Object.freeze({
    artifactName: "Rion.Studio-win.exe",
    signatureName: "Rion.Studio-win.exe.sig"
  })
});
const TARGET_KEYS = Object.freeze([
  "artifactName",
  "artifactSha256",
  "candidateReceiptSha256",
  "embeddedUpdaterEndpoint",
  "manifestName",
  "runtime",
  "servedManifestSha256",
  "signatureName",
  "signatureSha256",
  "sourceSha",
  "version"
]);

export async function prepareElectronProductionUpdaterDataPreservation(input) {
  assertExactKeys(input, [
    "beforeReceiptPath",
    "challengeNoncePath",
    "expectedChallengeSha256",
    "userDataDirectory"
  ], "updater data-preservation prepare input");
  const nonce = await readStableFile(
    input.challengeNoncePath,
    CHALLENGE_NONCE_BYTES,
    "updater data-preservation challenge nonce"
  );
  if (nonce.bytes !== CHALLENGE_NONCE_BYTES) {
    throw new Error("The updater data-preservation challenge nonce must be exactly 32 bytes.");
  }
  const challengeNonceSha256 = requiredDigest(
    input.expectedChallengeSha256,
    "updater data-preservation challenge nonce SHA-256"
  );
  assertEqual(
    nonce.sha256,
    challengeNonceSha256,
    "updater data-preservation challenge nonce SHA-256"
  );
  const userData = await resolveStableRealDirectory(
    input.userDataDirectory,
    "updater user-data directory"
  );
  const beforeReceiptPath = await resolveCreateNewFile(
    input.beforeReceiptPath,
    ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_BEFORE_FILE,
    "updater data-preservation before receipt"
  );
  assertPathOutsideRoot(
    beforeReceiptPath,
    userData.path,
    "updater data-preservation before receipt"
  );
  const sentinelPath = path.join(
    userData.path,
    ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_SENTINEL_FILE
  );
  const sentinel = await createStableSentinel(sentinelPath, nonce.source);
  try {
    const before = assertElectronProductionUpdaterDataPreservationBefore({
      schemaVersion: 1,
      kind: ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_BEFORE_KIND,
      challengeNonceSha256,
      userDataDirectoryIdentity: userData.identity,
      sentinel: sentinelContractIdentity(sentinel)
    });
    const source = serializeCanonicalJson(before);
    await writeExclusive(beforeReceiptPath, source);
    const written = await readElectronProductionUpdaterDataPreservationBefore({
      beforeReceiptPath,
      expectedBeforeReceiptSha256: sha256(source)
    });
    await verifyStableOpenFile(sentinel);
    await assertDirectoryIdentityUnchanged(userData);
    return deepFreeze({
      ...written,
      sentinel: publicFileIdentity(sentinel)
    });
  } finally {
    await sentinel.handle.close();
  }
}

export async function finalizeElectronProductionUpdaterDataPreservation(
  input,
  dependencyOverrides = {}
) {
  assertExactKeys(input, [
    "beforeReceiptPath",
    "contextPath",
    "expectedBeforeReceiptSha256",
    "expectedContextSha256",
    "observationPath",
    "userDataDirectory"
  ], "updater data-preservation finalize input");
  assertExactKeys(
    dependencyOverrides,
    Object.hasOwn(dependencyOverrides, "now") ? ["now"] : [],
    "updater data-preservation finalize dependencies"
  );
  const now = dependencyOverrides.now ?? (() => new Date());
  if (typeof now !== "function") {
    throw new Error("The updater data-preservation clock must be a function.");
  }
  const userData = await resolveStableRealDirectory(
    input.userDataDirectory,
    "updater user-data directory"
  );
  const observationPath = await resolveCreateNewFile(
    input.observationPath,
    ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_OBSERVATION_FILE,
    "updater data-preservation observation"
  );
  assertPathOutsideRoot(
    observationPath,
    userData.path,
    "updater data-preservation observation"
  );
  const canonicalBeforePath = await canonicalRegularFilePath(
    input.beforeReceiptPath,
    MAX_DOCUMENT_BYTES,
    "updater data-preservation before receipt"
  );
  assertPathOutsideRoot(
    canonicalBeforePath,
    userData.path,
    "updater data-preservation before receipt"
  );
  const [beforeFile, contextFile] = await Promise.all([
    readElectronProductionUpdaterDataPreservationBefore({
      beforeReceiptPath: canonicalBeforePath,
      expectedBeforeReceiptSha256: input.expectedBeforeReceiptSha256
    }),
    readCanonicalContext({
      contextPath: input.contextPath,
      expectedContextSha256: input.expectedContextSha256
    })
  ]);
  const before = beforeFile.before;
  const context = contextFile.context;
  assertExactRecord(
    userData.identity,
    before.userDataDirectoryIdentity,
    "updater user-data directory identity"
  );
  assertEqual(
    context.challenge.nonceSha256,
    before.challengeNonceSha256,
    "updater data-preservation challenge binding"
  );
  const sentinelPath = path.join(
    userData.path,
    ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_SENTINEL_FILE
  );
  const sentinel = await openStableIdentityFile(
    sentinelPath,
    CHALLENGE_NONCE_BYTES,
    "updater data-preservation sentinel"
  );
  try {
    assertSentinelMatchesBefore(sentinel, before.sentinel);
    const observedAt = clockTimestamp(now);
    const observation = assertElectronProductionUpdaterDataPreservationObservation({
      schemaVersion: 1,
      kind: ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_OBSERVATION_KIND,
      challenge: context.challenge,
      evidenceAttemptId: context.evidenceAttemptId,
      platform: context.platform,
      transitionKind: context.transitionKind,
      sourceInstallAttemptId: context.sourceInstallAttemptId,
      target: context.target,
      observedAt,
      preservation: {
        beforeChallengeSha256: before.challengeNonceSha256,
        afterChallengeSha256: sentinel.sha256,
        preserved: true,
        userDataIdentitySha256: userDataIdentitySha256(userData.identity)
      }
    });
    const source = serializeCanonicalJson(observation);
    await writeExclusive(observationPath, source);
    const written = await readElectronProductionUpdaterDataPreservationObservation({
      expectedObservationSha256: sha256(source),
      observationPath
    });
    await verifyStableOpenFile(sentinel);
    await assertDirectoryIdentityUnchanged(userData);
    return written;
  } finally {
    await sentinel.handle.close();
  }
}

export function assertElectronProductionUpdaterDataPreservationBefore(value) {
  assertExactKeys(value, [
    "challengeNonceSha256",
    "kind",
    "schemaVersion",
    "sentinel",
    "userDataDirectoryIdentity"
  ], "updater data-preservation before receipt");
  assertEqual(value.schemaVersion, 1,
    "updater data-preservation before schema version");
  assertEqual(
    value.kind,
    ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_BEFORE_KIND,
    "updater data-preservation before kind"
  );
  const challengeNonceSha256 = requiredDigest(
    value.challengeNonceSha256,
    "updater data-preservation challenge nonce SHA-256"
  );
  const userDataDirectoryIdentity = assertFilesystemIdentity(
    value.userDataDirectoryIdentity,
    "updater user-data directory identity"
  );
  const sentinel = assertSentinelContract(value.sentinel, challengeNonceSha256);
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_BEFORE_KIND,
    challengeNonceSha256,
    userDataDirectoryIdentity,
    sentinel
  });
}

export function assertElectronProductionUpdaterDataPreservationObservation(value) {
  assertExactKeys(value, [
    "challenge",
    "evidenceAttemptId",
    "kind",
    "observedAt",
    "platform",
    "preservation",
    "schemaVersion",
    "sourceInstallAttemptId",
    "target",
    "transitionKind"
  ], "updater data-preservation observation");
  assertEqual(value.schemaVersion, 1,
    "updater data-preservation observation schema version");
  assertEqual(
    value.kind,
    ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_OBSERVATION_KIND,
    "updater data-preservation observation kind"
  );
  const context = assertContext({
    challenge: value.challenge,
    evidenceAttemptId: value.evidenceAttemptId,
    platform: value.platform,
    transitionKind: value.transitionKind,
    sourceInstallAttemptId: value.sourceInstallAttemptId,
    target: value.target
  });
  const observedAt = requiredRfc3339(
    value.observedAt,
    "updater data-preservation observation time"
  );
  const preservation = assertPreservation(value.preservation, context.challenge);
  return deepFreeze({
    schemaVersion: 1,
    kind: ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_OBSERVATION_KIND,
    ...context,
    observedAt,
    preservation
  });
}

export async function readElectronProductionUpdaterDataPreservationBefore(input) {
  assertExactKeys(input, [
    "beforeReceiptPath",
    "expectedBeforeReceiptSha256"
  ], "updater data-preservation before read input");
  const requestedBeforeReceiptPath = requiredAbsolutePath(
    input.beforeReceiptPath,
    "updater data-preservation before receipt"
  );
  assertEqual(
    path.basename(requestedBeforeReceiptPath),
    ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_BEFORE_FILE,
    "updater data-preservation before filename"
  );
  const beforeReceiptPath = await canonicalRegularFilePath(
    requestedBeforeReceiptPath,
    MAX_DOCUMENT_BYTES,
    "updater data-preservation before receipt"
  );
  const file = await readCanonicalJsonFile(
    beforeReceiptPath,
    MAX_DOCUMENT_BYTES,
    "updater data-preservation before receipt"
  );
  assertEqual(
    file.sha256,
    requiredDigest(
      input.expectedBeforeReceiptSha256,
      "updater data-preservation before receipt SHA-256"
    ),
    "updater data-preservation before receipt SHA-256"
  );
  return deepFreeze({
    before: assertElectronProductionUpdaterDataPreservationBefore(file.value),
    beforeIdentity: publicIdentity(beforeReceiptPath, file),
    beforePath: beforeReceiptPath
  });
}

export async function readElectronProductionUpdaterDataPreservationObservation(input) {
  assertExactKeys(input, [
    "expectedObservationSha256",
    "observationPath"
  ], "updater data-preservation observation read input");
  const requestedObservationPath = requiredAbsolutePath(
    input.observationPath,
    "updater data-preservation observation"
  );
  assertEqual(
    path.basename(requestedObservationPath),
    ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_OBSERVATION_FILE,
    "updater data-preservation observation filename"
  );
  const observationPath = await canonicalRegularFilePath(
    requestedObservationPath,
    MAX_DOCUMENT_BYTES,
    "updater data-preservation observation"
  );
  const file = await readCanonicalJsonFile(
    observationPath,
    MAX_DOCUMENT_BYTES,
    "updater data-preservation observation"
  );
  assertEqual(
    file.sha256,
    requiredDigest(
      input.expectedObservationSha256,
      "updater data-preservation observation SHA-256"
    ),
    "updater data-preservation observation SHA-256"
  );
  return deepFreeze({
    observation: assertElectronProductionUpdaterDataPreservationObservation(file.value),
    observationIdentity: publicIdentity(observationPath, file),
    observationPath
  });
}

async function readCanonicalContext(input) {
  const contextPath = requiredAbsolutePath(
    input.contextPath,
    "updater data-preservation context"
  );
  const file = await readCanonicalJsonFile(
    contextPath,
    MAX_DOCUMENT_BYTES,
    "updater data-preservation context"
  );
  assertEqual(
    file.sha256,
    requiredDigest(
      input.expectedContextSha256,
      "updater data-preservation context SHA-256"
    ),
    "updater data-preservation context SHA-256"
  );
  return deepFreeze({ context: assertContext(file.value), identity: publicIdentity(contextPath, file) });
}

function assertContext(value) {
  assertExactKeys(value, [
    "challenge",
    "evidenceAttemptId",
    "platform",
    "sourceInstallAttemptId",
    "target",
    "transitionKind"
  ], "updater data-preservation context");
  const challenge = assertChallenge(value.challenge);
  const evidenceAttemptId = requiredUuid(
    value.evidenceAttemptId,
    "updater evidence attempt ID"
  );
  const platform = requiredEnum(
    value.platform,
    PLATFORMS,
    "updater data-preservation platform"
  );
  const transitionKind = requiredEnum(
    value.transitionKind,
    TRANSITIONS,
    "updater data-preservation transition"
  );
  const sourceInstallAttemptId = requiredSourceInstallAttemptId(
    value.sourceInstallAttemptId,
    transitionKind
  );
  const target = assertTarget(value.target, platform);
  return deepFreeze({
    challenge,
    evidenceAttemptId,
    platform,
    transitionKind,
    sourceInstallAttemptId,
    target
  });
}

function assertChallenge(value) {
  assertExactKeys(value, ["expiresAt", "id", "issuedAt", "nonceSha256"],
    "updater data-preservation challenge");
  const id = requiredUuid(value.id, "updater data-preservation challenge ID");
  const nonceSha256 = requiredDigest(
    value.nonceSha256,
    "updater data-preservation challenge nonce SHA-256"
  );
  const issuedAt = requiredRfc3339(
    value.issuedAt,
    "updater data-preservation challenge issued-at"
  );
  const expiresAt = requiredRfc3339(
    value.expiresAt,
    "updater data-preservation challenge expires-at"
  );
  const lifetime = Date.parse(expiresAt) - Date.parse(issuedAt);
  if (lifetime <= 0 || lifetime > 24 * 60 * 60 * 1000) {
    throw new Error(
      "The updater data-preservation challenge lifetime must be positive and at most 24 hours."
    );
  }
  return { expiresAt, id, issuedAt, nonceSha256 };
}

function assertTarget(value, platform) {
  assertExactKeys(value, TARGET_KEYS, "updater data-preservation target");
  const expected = PLATFORM_TARGETS[platform];
  assertEqual(value.runtime, "electron-v23", "updater data-preservation target runtime");
  assertEqual(
    value.artifactName,
    expected.artifactName,
    "updater data-preservation target artifact name"
  );
  assertEqual(
    value.signatureName,
    expected.signatureName,
    "updater data-preservation target signature name"
  );
  assertEqual(value.manifestName, "latest.json",
    "updater data-preservation target manifest name");
  const target = {
    artifactName: value.artifactName,
    artifactSha256: requiredDigest(
      value.artifactSha256,
      "updater data-preservation target artifact SHA-256"
    ),
    candidateReceiptSha256: requiredDigest(
      value.candidateReceiptSha256,
      "updater data-preservation target candidate receipt SHA-256"
    ),
    embeddedUpdaterEndpoint: requiredHttpsLatestJson(
      value.embeddedUpdaterEndpoint,
      "updater data-preservation target endpoint"
    ),
    manifestName: "latest.json",
    runtime: "electron-v23",
    servedManifestSha256: requiredDigest(
      value.servedManifestSha256,
      "updater data-preservation served manifest SHA-256"
    ),
    signatureName: value.signatureName,
    signatureSha256: requiredDigest(
      value.signatureSha256,
      "updater data-preservation target signature SHA-256"
    ),
    sourceSha: requiredCommitSha(
      value.sourceSha,
      "updater data-preservation target source SHA"
    ),
    version: requiredSemanticVersion(
      value.version,
      "updater data-preservation target version"
    )
  };
  return deepFreeze(target);
}

function assertPreservation(value, challenge) {
  assertExactKeys(value, [
    "afterChallengeSha256",
    "beforeChallengeSha256",
    "preserved",
    "userDataIdentitySha256"
  ], "updater data-preservation result");
  const beforeChallengeSha256 = requiredDigest(
    value.beforeChallengeSha256,
    "updater data-preservation before challenge SHA-256"
  );
  const afterChallengeSha256 = requiredDigest(
    value.afterChallengeSha256,
    "updater data-preservation after challenge SHA-256"
  );
  assertEqual(
    beforeChallengeSha256,
    challenge.nonceSha256,
    "updater data-preservation before challenge SHA-256"
  );
  assertEqual(
    afterChallengeSha256,
    challenge.nonceSha256,
    "updater data-preservation after challenge SHA-256"
  );
  assertEqual(value.preserved, true, "updater data-preservation verdict");
  return {
    beforeChallengeSha256,
    afterChallengeSha256,
    preserved: true,
    userDataIdentitySha256: requiredDigest(
      value.userDataIdentitySha256,
      "updater user-data identity SHA-256"
    )
  };
}

function assertSentinelContract(value, challengeNonceSha256) {
  assertExactKeys(value, ["bytes", "dev", "fileName", "ino", "sha256"],
    "updater data-preservation sentinel identity");
  assertEqual(
    value.fileName,
    ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_SENTINEL_FILE,
    "updater data-preservation sentinel filename"
  );
  assertEqual(value.bytes, CHALLENGE_NONCE_BYTES,
    "updater data-preservation sentinel bytes");
  const sha256Value = requiredDigest(
    value.sha256,
    "updater data-preservation sentinel SHA-256"
  );
  assertEqual(
    sha256Value,
    challengeNonceSha256,
    "updater data-preservation sentinel challenge SHA-256"
  );
  return {
    bytes: CHALLENGE_NONCE_BYTES,
    dev: requiredFilesystemIdentifier(value.dev,
      "updater data-preservation sentinel device ID"),
    fileName: ELECTRON_PRODUCTION_UPDATER_DATA_PRESERVATION_SENTINEL_FILE,
    ino: requiredFilesystemIdentifier(value.ino,
      "updater data-preservation sentinel inode"),
    sha256: sha256Value
  };
}

function assertFilesystemIdentity(value, label) {
  assertExactKeys(value, ["dev", "ino"], label);
  return {
    dev: requiredFilesystemIdentifier(value.dev, `${label} device ID`),
    ino: requiredFilesystemIdentifier(value.ino, `${label} inode`)
  };
}

function assertSentinelMatchesBefore(sentinel, expected) {
  assertEqual(sentinel.bytes, expected.bytes,
    "updater data-preservation sentinel bytes");
  assertEqual(sentinel.sha256, expected.sha256,
    "updater data-preservation sentinel SHA-256");
  assertEqual(String(sentinel.metadata.dev), expected.dev,
    "updater data-preservation sentinel device ID");
  assertEqual(String(sentinel.metadata.ino), expected.ino,
    "updater data-preservation sentinel inode");
}

async function createStableSentinel(filePath, source) {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(source);
    await handle.sync();
    const metadata = await handle.stat({ bigint: true });
    assertBoundedSingleLinkFile(
      metadata,
      CHALLENGE_NONCE_BYTES,
      "updater data-preservation sentinel"
    );
    if (metadata.size !== BigInt(CHALLENGE_NONCE_BYTES)) {
      throw new Error("The updater data-preservation sentinel must be exactly 32 bytes.");
    }
    const session = {
      bytes: source.length,
      fileName: path.basename(filePath),
      handle,
      metadata,
      path: filePath,
      sha256: sha256(source)
    };
    await verifyStableOpenFile(session);
    return session;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function openStableIdentityFile(filePath, maximumBytes, label) {
  const requested = requiredAbsolutePath(filePath, label);
  const initial = await lstat(requested, { bigint: true });
  assertBoundedSingleLinkFile(initial, maximumBytes, label);
  const handle = await open(requested, READ_ONLY_NO_FOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    assertSameFile(initial, opened, label);
    assertBoundedSingleLinkFile(opened, maximumBytes, label);
    const source = await handle.readFile();
    const completed = await handle.stat({ bigint: true });
    assertSameFile(opened, completed, label);
    const session = {
      bytes: source.length,
      fileName: path.basename(requested),
      handle,
      metadata: completed,
      path: requested,
      sha256: sha256(source)
    };
    await verifyStableOpenFile(session);
    return session;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function verifyStableOpenFile(session) {
  const opened = await session.handle.stat({ bigint: true });
  assertSameFile(session.metadata, opened, session.fileName);
  const observedPath = await lstat(session.path, { bigint: true });
  assertSameFile(opened, observedPath, session.fileName);
}

async function resolveStableRealDirectory(value, label) {
  const requestedPath = requiredAbsolutePath(value, label);
  const requested = await lstat(requestedPath, { bigint: true });
  if (!requested.isDirectory() || requested.isSymbolicLink()) {
    throw new Error(`The ${label} must be a real directory.`);
  }
  const canonicalPath = await realpath(requestedPath);
  const canonical = await lstat(canonicalPath, { bigint: true });
  assertSameDirectoryIdentity(requested, canonical, label);
  return {
    identity: {
      dev: String(canonical.dev),
      ino: String(canonical.ino)
    },
    label,
    metadata: canonical,
    path: canonicalPath
  };
}

async function assertDirectoryIdentityUnchanged(directory) {
  const observed = await lstat(directory.path, { bigint: true });
  assertSameDirectoryIdentity(directory.metadata, observed, directory.label);
}

function assertSameDirectoryIdentity(expected, observed, label) {
  if (!observed.isDirectory() || observed.isSymbolicLink() ||
      expected.dev !== observed.dev || expected.ino !== observed.ino) {
    throw new Error(`The ${label} identity changed.`);
  }
}

function assertBoundedSingleLinkFile(metadata, maximumBytes, label) {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n ||
      metadata.size <= 0n || metadata.size > BigInt(maximumBytes)) {
    throw new Error(`The ${label} must be a bounded, nonempty, single-link regular file.`);
  }
}

function assertSameFile(expected, observed, label) {
  if (!observed.isFile() || expected.dev !== observed.dev ||
      expected.ino !== observed.ino || expected.mode !== observed.mode ||
      expected.nlink !== observed.nlink || expected.size !== observed.size ||
      expected.mtimeNs !== observed.mtimeNs || expected.ctimeNs !== observed.ctimeNs) {
    throw new Error(`The ${label} changed while it was observed.`);
  }
}

function requiredSourceInstallAttemptId(value, transitionKind) {
  if (typeof value !== "string") {
    throw new Error("The updater data-preservation source install attempt ID is required.");
  }
  if (transitionKind === "tauri-v22-to-electron-v23") {
    const match = /^update-install-([1-9][0-9]*)$/u.exec(value);
    const maximum = "18446744073709551615";
    if (!match || match[1].length > maximum.length ||
        (match[1].length === maximum.length && match[1] > maximum)) {
      throw new Error(
        "The Tauri v22 data-preservation attempt ID must be update-install-<u64>."
      );
    }
    return value;
  }
  const prefix = "update-install-";
  if (!value.startsWith(prefix)) {
    throw new Error(
      "The Electron v23 data-preservation attempt ID must contain an RFC 9562 UUID."
    );
  }
  requiredUuid(value.slice(prefix.length),
    "Electron v23 data-preservation attempt ID");
  return value;
}

function requiredUuid(value, label) {
  if (typeof value !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
        .test(value)) {
    throw new Error(`The ${label} must be a lowercase RFC 9562 UUID.`);
  }
  return value;
}

function requiredFilesystemIdentifier(value, label) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,39})$/u.test(value)) {
    throw new Error(`The ${label} must be a bounded decimal identifier.`);
  }
  return value;
}

function requiredHttpsLatestJson(value, label) {
  if (typeof value !== "string") {
    throw new Error(`The ${label} must be an exact HTTPS latest.json URL.`);
  }
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`The ${label} must be an exact HTTPS latest.json URL.`, {
      cause: error
    });
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search ||
      url.hash || !url.pathname.endsWith("/latest.json") || url.href !== value) {
    throw new Error(`The ${label} must be an exact HTTPS latest.json URL.`);
  }
  return value;
}

function requiredEnum(value, choices, label) {
  if (!choices.includes(value)) throw new Error(`The ${label} is unsupported.`);
  return value;
}

function clockTimestamp(now) {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("The updater data-preservation clock returned an invalid Date.");
  }
  return value.toISOString();
}

function sentinelContractIdentity(sentinel) {
  return {
    bytes: sentinel.bytes,
    dev: String(sentinel.metadata.dev),
    fileName: sentinel.fileName,
    ino: String(sentinel.metadata.ino),
    sha256: sentinel.sha256
  };
}

function publicFileIdentity(file) {
  return {
    bytes: file.bytes,
    fileName: file.fileName,
    sha256: file.sha256
  };
}

function userDataIdentitySha256(identity) {
  return sha256(serializeCanonicalJson(assertFilesystemIdentity(
    identity,
    "updater user-data directory identity"
  )));
}

function assertExactRecord(actual, expected, label) {
  assertExactKeys(actual, Object.keys(expected), label);
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`The ${label} does not match.`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
