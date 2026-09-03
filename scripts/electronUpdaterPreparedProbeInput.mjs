import { createHash } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import { copyFile, lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import { createUpdaterManifest } from "./createUpdaterManifest.mjs";
import { captureStableBoundedFileIdentity } from
  "./electronProductionCandidateAssetBinding.mjs";
import {
  assertElectronUpdaterMacosPackageVerification,
  verifyElectronUpdaterMacosPackage
} from "./electronUpdaterMacosPackageVerification.mjs";
import { isUpdaterPrivateEnvironmentName } from
  "./runtimeEnvironmentPolicy.mjs";
import { signUpdaterArtifact } from "./updaterSignerEnvironment.mjs";

export const ELECTRON_UPDATER_PREPARED_INPUT_KIND =
  "rion-electron-updater-prepared-probe-input";
export const ELECTRON_UPDATER_PREPARED_INPUT_NAME =
  "prepared-updater-probe-input.json";

const PLATFORM_ARTIFACTS = Object.freeze({
  darwin: Object.freeze({
    artifactName: "Rion.Studio-mac.app.tar.gz",
    companionName: "Rion.Studio-win.exe",
    manifestName: "latest-darwin.json"
  }),
  win32: Object.freeze({
    artifactName: "Rion.Studio-win.exe",
    companionName: "Rion.Studio-mac.app.tar.gz",
    manifestName: "latest-win32.json"
  })
});

export async function prepareElectronUpdaterProbeInput(input) {
  const platform = requiredPlatform(input.platform);
  const architecture = requiredArchitecture(platform, input.architecture);
  const contract = PLATFORM_ARTIFACTS[platform];
  const fixtureRoot = requiredAbsolutePath(input.fixtureRoot, "fixture root");
  await assertRealDirectory(fixtureRoot, "fixture root");
  const sourceArtifactPath = requiredAbsolutePath(
    input.artifactPath,
    "artifact path"
  );
  const referenceApplicationPath = requiredReferenceApplicationPath(
    platform,
    input.referenceApplicationPath
  );
  if (isPathInside(fixtureRoot, sourceArtifactPath, platform)) {
    throw new Error(
      "The source updater artifact must stay outside the prepared-input root."
    );
  }
  const version = requiredSemanticVersion(input.version);
  const environment = input.environment ?? {};
  let privateKeyPath = environment.TAURI_SIGNING_PRIVATE_KEY_PATH
    ? requiredAbsolutePath(
        environment.TAURI_SIGNING_PRIVATE_KEY_PATH,
        "TAURI_SIGNING_PRIVATE_KEY_PATH"
      )
    : null;
  if (
    privateKeyPath &&
    !isPathInside(fixtureRoot, privateKeyPath, platform)
  ) {
    throw new Error(
      "The updater probe signing key must stay inside its ephemeral fixture root."
    );
  }
  if (privateKeyPath) {
    privateKeyPath = await assertPrivateKeyPath(
      fixtureRoot,
      privateKeyPath,
      platform
    );
  }
  if (!privateKeyPath) {
    requiredValue(
      environment.TAURI_SIGNING_PRIVATE_KEY,
      "TAURI_SIGNING_PRIVATE_KEY"
    );
  }
  requiredValue(
    environment.TAURI_SIGNING_PRIVATE_KEY_PASSWORD,
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD"
  );
  await assertBoundedRegularFile(sourceArtifactPath, 1024 * 1024 * 1024);

  const paths = preparedPaths(fixtureRoot, contract);
  await Promise.all([
    assertPathMissing(paths.artifact, "staged artifact"),
    assertPathMissing(paths.artifactSignature, "artifact signature"),
    assertPathMissing(paths.companion, "companion artifact"),
    assertPathMissing(paths.companionSignature, "companion signature"),
    assertPathMissing(paths.manifest, "prepared manifest"),
    assertPathMissing(paths.receipt, "prepared-input receipt")
  ]);
  const sourceArtifact = await captureFileIdentity(
    sourceArtifactPath,
    1024 * 1024 * 1024
  );
  await copyFile(
    sourceArtifactPath,
    paths.artifact,
    fileConstants.COPYFILE_EXCL
  );
  const stagedArtifact = await captureFileIdentity(
    paths.artifact,
    1024 * 1024 * 1024
  );
  if (
    sourceArtifact.bytes !== stagedArtifact.bytes ||
    sourceArtifact.sha256 !== stagedArtifact.sha256
  ) {
    throw new Error("The staged updater artifact changed while copied.");
  }
  await writeExclusive(
    paths.companion,
    Buffer.from("signed foreign-platform fixture\n", "utf8")
  );
  const signingEnvironment = privateKeyPath
    ? {
        ...environment,
        TAURI_SIGNING_PRIVATE_KEY_PATH: privateKeyPath
      }
    : environment;
  await signUpdaterArtifact({
    artifactPath: paths.artifact,
    environment: signingEnvironment,
    workingDirectory: input.workingDirectory
  });
  await signUpdaterArtifact({
    artifactPath: paths.companion,
    environment: signingEnvironment,
    workingDirectory: input.workingDirectory
  });
  await Promise.all([
    assertBoundedRegularFile(paths.artifactSignature, 64 * 1024),
    assertBoundedRegularFile(paths.companionSignature, 64 * 1024)
  ]);
  const macArtifact = platform === "darwin" ? paths.artifact : paths.companion;
  const windowsArtifact = platform === "win32" ? paths.artifact : paths.companion;
  await createUpdaterManifest([
    "--version", version,
    "--base-url", "https://updates.invalid/ci-fixture/",
    "--published-at", "2026-08-30T00:00:00Z",
    "--mac-archive", macArtifact,
    "--windows-installer", windowsArtifact,
    "--output", paths.manifest
  ]);
  await assertBoundedRegularFile(paths.manifest, 1024 * 1024);

  const artifact = await captureFileIdentity(
    paths.artifact,
    1024 * 1024 * 1024
  );
  const macosPackageVerification = platform === "darwin"
    ? await verifyElectronUpdaterMacosPackage({
        artifactPath: paths.artifact,
        expectedArtifact: artifact,
        expectedVersion: version,
        referenceApplicationPath
      })
    : null;
  const receipt = {
    schemaVersion: 2,
    kind: ELECTRON_UPDATER_PREPARED_INPUT_KIND,
    architecture,
    platform,
    version,
    artifact,
    artifactSignature: await captureFileIdentity(
      paths.artifactSignature,
      64 * 1024
    ),
    companion: await captureFileIdentity(paths.companion, 1024 * 1024),
    companionSignature: await captureFileIdentity(
      paths.companionSignature,
      64 * 1024
    ),
    macosPackageVerification,
    manifest: await captureFileIdentity(paths.manifest, 1024 * 1024)
  };
  await writeExclusive(paths.receipt, serializeCanonicalJson(receipt));
  const receiptIdentity = await captureFileIdentity(paths.receipt, 1024 * 1024);
  return Object.freeze({
    ...paths,
    receipt: Object.freeze(receipt),
    receiptIdentity,
    receiptPath: paths.receipt
  });
}

export async function readElectronUpdaterPreparedProbeInput(input) {
  const platform = requiredPlatform(input.platform);
  const architecture = requiredArchitecture(platform, input.architecture);
  const contract = PLATFORM_ARTIFACTS[platform];
  const fixtureRoot = requiredAbsolutePath(input.fixtureRoot, "fixture root");
  await assertRealDirectory(fixtureRoot, "fixture root");
  const artifactPath = requiredAbsolutePath(input.artifactPath, "artifact path");
  const version = requiredSemanticVersion(input.version);
  assertUpdaterPrivateEnvironmentAbsent(input.environment ?? {});
  const paths = preparedPaths(fixtureRoot, contract);
  if (artifactPath !== paths.artifact) {
    throw new Error(
      "The prepared updater artifact must use the fixed fixture-root path."
    );
  }
  const receiptPath = requiredAbsolutePath(input.receiptPath, "prepared-input receipt");
  if (receiptPath !== paths.receipt) {
    throw new Error(
      "The prepared updater input receipt must use the fixed fixture-root path."
    );
  }
  const source = await readBoundedRegularFile(receiptPath, 1024 * 1024);
  let receipt;
  try {
    receipt = JSON.parse(source.toString("utf8"));
  } catch (error) {
    throw new Error("The prepared updater input receipt is invalid JSON.", {
      cause: error
    });
  }
  assertExactKeys(receipt, [
    "architecture",
    "artifact",
    "artifactSignature",
    "companion",
    "companionSignature",
    "kind",
    "macosPackageVerification",
    "manifest",
    "platform",
    "schemaVersion",
    "version"
  ]);
  if (!source.equals(serializeCanonicalJson(receipt))) {
    throw new Error("The prepared updater input receipt is not canonical JSON.");
  }
  if (
    receipt.schemaVersion !== 2 ||
    receipt.kind !== ELECTRON_UPDATER_PREPARED_INPUT_KIND ||
    receipt.architecture !== architecture ||
    receipt.platform !== platform ||
    receipt.version !== version
  ) {
    throw new Error(
      "The prepared updater input receipt does not bind this platform and version."
    );
  }
  const expected = {
    artifact: artifactPath,
    artifactSignature: paths.artifactSignature,
    companion: paths.companion,
    companionSignature: paths.companionSignature,
    manifest: paths.manifest
  };
  for (const [name, expectedPath] of Object.entries(expected)) {
    assertFileIdentity(receipt[name], expectedPath, name);
    const maximumBytes = name.includes("Signature")
      ? 64 * 1024
      : name === "artifact"
        ? 1024 * 1024 * 1024
        : 1024 * 1024;
    const observed = await captureFileIdentity(expectedPath, maximumBytes);
    if (
      observed.bytes !== receipt[name].bytes ||
      observed.sha256 !== receipt[name].sha256
    ) {
      throw new Error(`The prepared updater ${name} changed after signing.`);
    }
  }
  const macosPackageVerification = platform === "darwin"
    ? assertElectronUpdaterMacosPackageVerification(
        receipt.macosPackageVerification,
        { artifact: receipt.artifact, version: receipt.version }
      )
    : requiredWindowsPackageVerification(receipt.macosPackageVerification);
  const verifiedReceipt = Object.freeze({
    ...receipt,
    macosPackageVerification
  });
  return Object.freeze({
    ...paths,
    receipt: verifiedReceipt,
    receiptIdentity: Object.freeze({
      path: receiptPath,
      bytes: source.length,
      sha256: createHash("sha256").update(source).digest("hex")
    }),
    receiptPath: paths.receipt
  });
}

export function assertUpdaterPrivateEnvironmentAbsent(environment) {
  const privateNames = Object.keys(environment)
    .filter(isUpdaterPrivateEnvironmentName)
    .sort();
  if (privateNames.length > 0) {
    throw new Error(
      `The updater runtime probe must not receive private signing environment: ${privateNames.join(", ")}.`
    );
  }
}

function preparedPaths(fixtureRoot, contract) {
  const artifact = path.join(fixtureRoot, contract.artifactName);
  const companion = path.join(fixtureRoot, contract.companionName);
  return Object.freeze({
    artifact,
    artifactSignature: `${artifact}.sig`,
    companion,
    companionSignature: `${companion}.sig`,
    manifest: path.join(fixtureRoot, contract.manifestName),
    receipt: path.join(fixtureRoot, ELECTRON_UPDATER_PREPARED_INPUT_NAME)
  });
}

async function captureFileIdentity(filePath, maximumBytes) {
  const identity = await captureStableBoundedFileIdentity(
    filePath,
    maximumBytes,
    "prepared updater probe input"
  );
  return Object.freeze({
    path: filePath,
    bytes: identity.bytes,
    sha256: identity.sha256
  });
}

function assertFileIdentity(identity, expectedPath, label) {
  assertExactKeys(identity, ["bytes", "path", "sha256"]);
  if (
    identity.path !== expectedPath ||
    !Number.isSafeInteger(identity.bytes) ||
    identity.bytes <= 0 ||
    !/^[0-9a-f]{64}$/u.test(identity.sha256 ?? "")
  ) {
    throw new Error(`The prepared updater ${label} identity is invalid.`);
  }
}

function assertExactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The prepared updater input receipt has an invalid schema.");
  }
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error("The prepared updater input receipt has an unexpected schema.");
  }
}

async function assertBoundedRegularFile(filePath, maximumBytes) {
  const metadata = await lstat(filePath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size <= 0 ||
    metadata.size > maximumBytes ||
    metadata.nlink !== 1
  ) {
    throw new Error(`Expected a bounded single-link regular file: ${filePath}`);
  }
  return metadata;
}

async function assertRealDirectory(directoryPath, label) {
  const metadata = await lstat(directoryPath);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`The prepared updater ${label} must be a real directory.`);
  }
}

async function assertPrivateKeyPath(fixtureRoot, privateKeyPath, platform) {
  const [realFixtureRoot, realPrivateKeyPath] = await Promise.all([
    realpath(fixtureRoot),
    realpath(privateKeyPath)
  ]);
  if (!isPathInside(realFixtureRoot, realPrivateKeyPath, platform)) {
    throw new Error(
      "The updater probe signing key resolved outside its ephemeral fixture root."
    );
  }
  await assertBoundedRegularFile(privateKeyPath, 1024 * 1024);
  return realPrivateKeyPath;
}

async function readBoundedRegularFile(filePath, maximumBytes) {
  const before = await captureStableBoundedFileIdentity(
    filePath,
    maximumBytes,
    "prepared updater receipt"
  );
  const handle = await open(filePath, "r");
  try {
    const source = await handle.readFile();
    const sourceSha256 = createHash("sha256").update(source).digest("hex");
    const after = await captureStableBoundedFileIdentity(
      filePath,
      maximumBytes,
      "prepared updater receipt"
    );
    if (
      source.length !== before.bytes ||
      sourceSha256 !== before.sha256 ||
      after.bytes !== before.bytes ||
      after.sha256 !== before.sha256
    ) {
      throw new Error(`The prepared updater file changed while read: ${filePath}`);
    }
    return source;
  } finally {
    await handle.close();
  }
}

async function assertPathMissing(filePath, label) {
  try {
    await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`The ${label} path must be create-new: ${filePath}`);
}

async function writeExclusive(filePath, source) {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(source);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isPathInside(root, candidate, platform) {
  const relative = path.relative(root, candidate);
  const comparison = platform === "win32"
    ? relative.toLowerCase()
    : relative;
  return comparison !== "" && comparison !== ".." &&
    !comparison.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function requiredPlatform(value) {
  if (value !== "darwin" && value !== "win32") {
    throw new Error("The prepared updater input requires macOS or Windows.");
  }
  return value;
}

function requiredArchitecture(platform, value) {
  const expected = platform === "darwin" ? "arm64" : "x64";
  if (value !== expected) {
    throw new Error(
      `The prepared updater input requires ${platform}-${expected}.`
    );
  }
  return expected;
}

function requiredReferenceApplicationPath(platform, value) {
  if (platform === "win32") {
    if (value !== undefined) {
      throw new Error(
        "The Windows prepared updater input must not specify a macOS application."
      );
    }
    return null;
  }
  const applicationPath = requiredAbsolutePath(
    value,
    "macOS reference application"
  );
  if (path.basename(applicationPath) !== "Rion Studio.app") {
    throw new Error(
      "The macOS reference application must be an absolute Rion Studio.app path."
    );
  }
  return applicationPath;
}

function requiredWindowsPackageVerification(value) {
  if (value !== null) {
    throw new Error(
      "The Windows prepared updater input macOS package verification must be null."
    );
  }
  return null;
}

function requiredAbsolutePath(value, label) {
  if (!value || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path.`);
  }
  return path.resolve(value);
}

function requiredSemanticVersion(value) {
  const normalized = requiredValue(value, "version");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(normalized)) {
    throw new Error("The prepared updater input version must be semantic.");
  }
  return normalized;
}

function requiredValue(value, label) {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}
