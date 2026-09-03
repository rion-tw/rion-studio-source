import { isDeepStrictEqual } from "node:util";

import { serializeCanonicalJson } from "./canonicalJson.mjs";
import {
  assertPortablePackagedElectronPackageManifest,
  removeExactPortablePackagedElectronPackageManifestEntry
} from "./packagedElectronPackageManifest.mjs";
import { assertWindowsIsolatedProfileResult } from
  "./windowsIsolatedProfileResultContract.mjs";

export const WINDOWS_ELECTRON_INSTALLER_PAYLOAD_PROOF_NAME =
  "windows-installer-payload-proof.json";
export const WINDOWS_ELECTRON_INSTALLER_PAYLOAD_PROOF_KIND =
  "rion-electron-windows-installer-payload-proof";
export const WINDOWS_ELECTRON_INSTALLER_PAYLOAD_PROOF_ISOLATION_KIND =
  "temporary-local-windows-user-profile-v1";
export const WINDOWS_ELECTRON_INSTALLER_PAYLOAD_PROOF_INSTALL_MODE =
  "nsis-silent-current-user-explicit-directory-v1";
export const WINDOWS_ELECTRON_INSTALLER_PAYLOAD_POLICY =
  "exact-source-tree-plus-single-root-nsis-uninstaller-v1";
export const WINDOWS_ELECTRON_INSTALLER_NAME = "Rion.Studio-win.exe";
export const WINDOWS_ELECTRON_MAIN_EXECUTABLE_PATH = "Rion Studio.exe";
export const WINDOWS_ELECTRON_UNINSTALLER_PATH = "Uninstall Rion Studio.exe";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SOURCE_SHA_PATTERN = /^[a-f0-9]{40}$/u;
const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const REQUIRED_PAYLOAD_FILES = Object.freeze([
  WINDOWS_ELECTRON_MAIN_EXECUTABLE_PATH,
  "resources/app.asar",
  "resources/native/rion-core.node"
]);

export function assertWindowsElectronInstallerPayloadProof(value) {
  assertObject(value, [
    "comparison",
    "installedPackage",
    "installer",
    "isolation",
    "kind",
    "platform",
    "schemaVersion",
    "sourcePackage",
    "sourceSha",
    "verdict",
    "version"
  ], "Windows installer payload proof");
  assertEqual(value.schemaVersion, 1, "proof schema version");
  assertEqual(
    value.kind,
    WINDOWS_ELECTRON_INSTALLER_PAYLOAD_PROOF_KIND,
    "proof kind"
  );
  assertEqual(value.verdict, "passed", "proof verdict");
  assertEqual(value.platform, "windows-x86_64", "proof platform");
  if (typeof value.sourceSha !== "string" || !SOURCE_SHA_PATTERN.test(value.sourceSha)) {
    throw new Error("The Windows installer payload proof source SHA is invalid.");
  }
  if (typeof value.version !== "string" || !isStrictSemanticVersion(value.version)) {
    throw new Error("The Windows installer payload proof version is invalid.");
  }

  assertObject(value.isolation, [
    "applicationLaunchRequested",
    "installMode",
    "kind",
    "runnerResult"
  ], "Windows installer payload proof isolation");
  assertEqual(
    value.isolation.kind,
    WINDOWS_ELECTRON_INSTALLER_PAYLOAD_PROOF_ISOLATION_KIND,
    "proof isolation kind"
  );
  assertEqual(
    value.isolation.installMode,
    WINDOWS_ELECTRON_INSTALLER_PAYLOAD_PROOF_INSTALL_MODE,
    "proof install mode"
  );
  assertEqual(
    value.isolation.applicationLaunchRequested,
    false,
    "proof application-launch request"
  );
  const runnerResult = assertWindowsIsolatedProfileResult(
    value.isolation.runnerResult
  );
  assertEqual(
    runnerResult.expectedTotalProcesses,
    3,
    "proof expected total process count"
  );
  assertEqual(runnerResult.totalProcesses, 3, "proof total process count");

  assertArtifact(value.installer, WINDOWS_ELECTRON_INSTALLER_NAME, "installer");
  assertArtifactIdentity(
    runnerResult.attestedInputs.installer,
    value.installer,
    "isolated installer"
  );
  assertObject(value.sourcePackage, ["appVersion", "manifest"], "source package");
  assertEqual(value.sourcePackage.appVersion, value.version, "source package version");
  const sourceManifest = assertPortablePackagedElectronPackageManifest(
    value.sourcePackage.manifest
  );
  assertWindowsManifest(sourceManifest, "source package manifest");

  assertObject(
    value.installedPackage,
    ["appVersion", "executable", "manifest", "uninstaller"],
    "installed package"
  );
  assertEqual(value.installedPackage.appVersion, value.version, "installed package version");
  const installedManifest = assertPortablePackagedElectronPackageManifest(
    value.installedPackage.manifest
  );
  assertWindowsManifest(installedManifest, "installed package manifest");
  assertArtifact(
    value.installedPackage.executable,
    WINDOWS_ELECTRON_MAIN_EXECUTABLE_PATH,
    "installed executable",
    "relativePath"
  );
  assertArtifact(
    value.installedPackage.uninstaller,
    WINDOWS_ELECTRON_UNINSTALLER_PATH,
    "installed uninstaller",
    "relativePath"
  );

  assertObject(value.comparison, [
    "addedPaths",
    "changedPaths",
    "normalizedInstalledManifest",
    "policy",
    "removedPaths",
    "verdict"
  ], "Windows installer payload comparison");
  assertEqual(
    value.comparison.policy,
    WINDOWS_ELECTRON_INSTALLER_PAYLOAD_POLICY,
    "payload comparison policy"
  );
  assertExactStringArray(
    value.comparison.addedPaths,
    [WINDOWS_ELECTRON_UNINSTALLER_PATH],
    "payload added paths"
  );
  assertExactStringArray(value.comparison.changedPaths, [], "payload changed paths");
  assertExactStringArray(value.comparison.removedPaths, [], "payload removed paths");
  assertEqual(value.comparison.verdict, "identical", "payload comparison verdict");
  const normalizedInstalledManifest = assertPortablePackagedElectronPackageManifest(
    value.comparison.normalizedInstalledManifest
  );
  assertWindowsManifest(normalizedInstalledManifest, "normalized installed manifest");

  const recomputedNormalizedManifest =
    removeExactPortablePackagedElectronPackageManifestEntry(
      installedManifest,
      WINDOWS_ELECTRON_UNINSTALLER_PATH
    );
  if (!isDeepStrictEqual(recomputedNormalizedManifest, normalizedInstalledManifest)) {
    throw new Error(
      "The Windows installer payload proof normalized manifest is not reproducible."
    );
  }
  if (!isDeepStrictEqual(normalizedInstalledManifest, sourceManifest)) {
    throw new Error(
      "The Windows installer payload proof installed payload differs from its source package."
    );
  }

  for (const relativePath of REQUIRED_PAYLOAD_FILES) {
    requireRegularEntry(sourceManifest, relativePath, "source package manifest");
    requireRegularEntry(installedManifest, relativePath, "installed package manifest");
  }
  const installedExecutable = requireRegularEntry(
    installedManifest,
    WINDOWS_ELECTRON_MAIN_EXECUTABLE_PATH,
    "installed package manifest"
  );
  const installedUninstaller = requireRegularEntry(
    installedManifest,
    WINDOWS_ELECTRON_UNINSTALLER_PATH,
    "installed package manifest"
  );
  assertArtifactEntry(
    value.installedPackage.executable,
    installedExecutable,
    "installed executable"
  );
  assertArtifactEntry(
    value.installedPackage.uninstaller,
    installedUninstaller,
    "installed uninstaller"
  );
  return deepFreeze(cloneJson(value));
}

export function serializeWindowsElectronInstallerPayloadProof(proof) {
  return serializeCanonicalJson(assertWindowsElectronInstallerPayloadProof(proof));
}

function assertWindowsManifest(manifest, label) {
  if (manifest.symlinkCount !== 0) {
    throw new Error(`The Windows installer payload proof ${label} must not contain symlinks.`);
  }
}

function assertArtifact(value, expectedName, label, nameField = "fileName") {
  assertObject(
    value,
    ["authenticodeStatus", "bytes", nameField, "sha256"],
    `Windows installer payload proof ${label}`
  );
  assertEqual(value.authenticodeStatus, "NotSigned", `${label} Authenticode status`);
  assertPositiveInteger(value.bytes, `${label} bytes`);
  assertEqual(value[nameField], expectedName, `${label} name`);
  requiredDigest(value.sha256, `${label} SHA-256`);
}

function assertArtifactEntry(artifact, entry, label) {
  assertEqual(artifact.bytes, entry.bytes, `${label} byte length`);
  assertEqual(artifact.sha256, entry.sha256, `${label} SHA-256`);
}

function assertArtifactIdentity(observed, expected, label) {
  assertEqual(observed.bytes, expected.bytes, `${label} byte length`);
  assertEqual(observed.fileName, expected.fileName, `${label} filename`);
  assertEqual(observed.sha256, expected.sha256, `${label} SHA-256`);
}

function requireRegularEntry(manifest, relativePath, label) {
  const entry = manifest.entries.find((candidate) => candidate.path === relativePath);
  if (entry?.type !== "regular-file" || entry.bytes <= 0) {
    throw new Error(
      `The Windows installer payload proof ${label} lacks nonempty regular file ${JSON.stringify(relativePath)}.`
    );
  }
  return entry;
}

function assertObject(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`The ${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`The ${label} has an unexpected schema.`);
  }
}

function assertExactStringArray(value, expected, label) {
  if (!Array.isArray(value) || !isDeepStrictEqual(value, expected)) {
    throw new Error(`The Windows installer payload proof ${label} is invalid.`);
  }
}

function requiredDigest(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`The Windows installer payload proof ${label} is invalid.`);
  }
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`The Windows installer payload proof ${label} is invalid.`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`The Windows installer payload proof ${label} is invalid.`);
  }
}

function isStrictSemanticVersion(value) {
  const match = VERSION_PATTERN.exec(value);
  if (!match) return false;
  return !(match[4]?.split(".").some((part) =>
    /^\d+$/u.test(part) && part.length > 1 && part.startsWith("0")));
}

function cloneJson(value) {
  if (Array.isArray(value)) return value.map(cloneJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, cloneJson(child)])
    );
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
