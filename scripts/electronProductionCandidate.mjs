import { spawn } from "node:child_process";
import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify as verifyEd25519
} from "node:crypto";
import { constants as fileConstants, createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { createUpdaterManifest } from "./createUpdaterManifest.mjs";
import {
  verifyReleaseAssets,
  writeReleaseChecksums
} from "./releaseArtifacts.mjs";
import { validatePackagedPngArtifact } from "./packagedElectronBlackBox.mjs";
import {
  PACKAGED_ELECTRON_BLACK_BOX_FIELDS,
  PACKAGED_ELECTRON_BLACK_BOX_KIND,
  PACKAGED_ELECTRON_BLACK_BOX_REPORT_NAME,
  PACKAGED_ELECTRON_BLACK_BOX_SCREENSHOT_NAME,
  serializePackagedElectronBlackBoxReport
} from "./packagedElectronBlackBoxReportContract.mjs";
import {
  assertPackagedElectronPackageManifestSummary,
  capturePackagedElectronPackageManifest,
  summarizePackagedElectronPackageManifest
} from "./packagedElectronPackageManifest.mjs";
import { sanitizeUpdaterRuntimeEnvironment } from
  "./runtimeEnvironmentPolicy.mjs";
import { signUpdaterArtifact } from "./updaterSignerEnvironment.mjs";
import { serializeElectronProductionPlatformReceipt } from
  "./electronProductionPlatformReceiptContract.mjs";
import {
  assertCandidateAssetDigestsMatchPlatformReceipts,
  assertCopiedPlatformAssetsMatchReceipts,
  captureStableBoundedFileIdentity,
  MAX_ELECTRON_CANDIDATE_ARTIFACT_BYTES as MAX_ARTIFACT_BYTES,
  MAX_ELECTRON_CANDIDATE_SIGNATURE_BYTES as MAX_SIGNATURE_BYTES
} from "./electronProductionCandidateAssetBinding.mjs";
import {
  readAndVerifyWindowsElectronInstallerPayloadProof
} from "./windowsElectronInstallerPayloadProof.mjs";
import {
  WINDOWS_ELECTRON_INSTALLER_PAYLOAD_PROOF_NAME
} from "./windowsElectronInstallerPayloadProofContract.mjs";
import {
  assertMacosPackageBindingEvidence,
  assertPackagedApplicationVersion,
  createVerifiedMacosPackageBinding,
  verifyMacosDistributionPackage,
  verifyMacosUpdaterArchive
} from "./electronProductionMacosPackageBinding.mjs";

export {
  createMacosPackageBindingEvidence,
  ELECTRON_MACOS_PACKAGE_BINDING_KIND
} from "./electronProductionMacosPackageBinding.mjs";

export const ELECTRON_PRODUCTION_CANDIDATE_APPROVAL =
  "BUILD ELECTRON PRODUCTION CANDIDATE";
export const ELECTRON_PRODUCTION_ENVIRONMENT = "electron-production-release";
export const ELECTRON_PLATFORM_RECEIPT_NAME = "platform-receipt.json";
export const ELECTRON_CANDIDATE_RECEIPT_NAME =
  "electron-production-candidate-receipt.json";
export const ELECTRON_PACKAGED_BLACK_BOX_REPORT_NAME =
  PACKAGED_ELECTRON_BLACK_BOX_REPORT_NAME;
export const ELECTRON_PACKAGED_BLACK_BOX_SCREENSHOT_NAME =
  PACKAGED_ELECTRON_BLACK_BOX_SCREENSHOT_NAME;
export const ELECTRON_WINDOWS_INSTALLER_PAYLOAD_PROOF_NAME =
  WINDOWS_ELECTRON_INSTALLER_PAYLOAD_PROOF_NAME;

const MAX_BLACK_BOX_REPORT_BYTES = 1024 * 1024;
const PUBLIC_KEY_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const PLATFORM_CONTRACTS = Object.freeze({
  "darwin-aarch64": Object.freeze({
    applicationKind: "retained-appkit-chromium",
    artifactName: "Rion.Studio-mac.app.tar.gz",
    distributionName: "Rion.Studio-mac.dmg",
    os: "darwin",
    policy: Object.freeze({
      architecture: "arm64",
      codeSignature: "adhoc",
      notarization: "disabled"
    }),
    blackBox: Object.freeze({
      executableName: "Rion Studio",
      isolationKind: "fixed-macos-home",
      nativeHostKind: "appkit-chromium",
      platform: "darwin",
      runtimeTarget: "chromium-v23-macos-appkit"
    })
  }),
  "windows-x86_64": Object.freeze({
    applicationKind: "bundled-chromium",
    artifactName: "Rion.Studio-win.exe",
    distributionName: undefined,
    installerPayloadProofName: WINDOWS_ELECTRON_INSTALLER_PAYLOAD_PROOF_NAME,
    os: "win32",
    policy: Object.freeze({
      architecture: "x86_64",
      authenticode: "unsigned"
    }),
    blackBox: Object.freeze({
      executableName: "Rion Studio.exe",
      isolationKind: "temporary-local-windows-user-profile-v1",
      nativeHostKind: "bundled-chromium",
      platform: "win32",
      runtimeTarget: "chromium-v23-windows"
    })
  })
});

export function validateElectronProductionCandidateInputs(input) {
  const sourceSha = requiredString(input.sourceSha, "source SHA");
  if (!/^[0-9a-f]{40}$/u.test(sourceSha)) {
    throw new Error("The production candidate source SHA must be 40 lowercase hexadecimal characters.");
  }
  const version = requiredString(input.version, "version");
  if (!isSupportedStrictSemanticVersion(version)) {
    throw new Error("The production candidate version must be semantic without a leading v.");
  }
  const publishedAt = requiredString(input.publishedAt, "published-at");
  if (!isStrictRfc3339Timestamp(publishedAt)) {
    throw new Error("The production candidate published-at value must be RFC 3339.");
  }
  if (input.ownerApproval !== ELECTRON_PRODUCTION_CANDIDATE_APPROVAL) {
    throw new Error(
      `Owner approval must be exactly ${JSON.stringify(ELECTRON_PRODUCTION_CANDIDATE_APPROVAL)}.`
    );
  }
  const baseUrl = normalizeUpdaterBaseUrl(input.updaterBaseUrl);
  const updaterEndpoint = new URL("latest.json", baseUrl).href;
  const publicKey = normalizeUpdaterPublicKey(input.publicKey);
  return {
    baseUrl: baseUrl.href,
    publicKeySha256: publicKey.sha256,
    publishedAt,
    sourceSha,
    updaterEndpoint,
    version
  };
}

function isSupportedStrictSemanticVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u.exec(value);
  if (!match) return false;
  return !(match[4]?.split(".").some((part) => /^\d+$/u.test(part) && part.startsWith("0") && part.length > 1));
}

function isStrictRfc3339Timestamp(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = Number(match[8] ?? 0);
  const offsetMinute = Number(match[9] ?? 0);
  if (
    month < 1 || month > 12 ||
    hour > 23 || minute > 59 || second > 59 ||
    offsetHour > 23 || offsetMinute > 59
  ) return false;
  const monthLengths = [31, isGregorianLeapYear(year) ? 29 : 28, 31, 30, 31, 30,
    31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= monthLengths[month - 1];
}

function isGregorianLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function normalizeUpdaterPublicKey(value) {
  const source = requiredString(value, "RION_STUDIO_UPDATER_PUBLIC_KEY");
  const rawKey = decodePublicKeySource(source);
  if (rawKey.length !== 42) {
    throw new Error("The production updater public key must decode to a 42-byte Minisign key.");
  }
  if (!rawKey.subarray(0, 2).equals(Buffer.from("Ed")) &&
      !rawKey.subarray(0, 2).equals(Buffer.from("ED"))) {
    throw new Error("The production updater public key uses an unsupported Minisign algorithm.");
  }
  return Object.freeze({
    canonicalBase64: rawKey.toString("base64"),
    keyBytes: Buffer.from(rawKey.subarray(10, 42)),
    keyId: Buffer.from(rawKey.subarray(2, 10)),
    sha256: createHash("sha256").update(rawKey).digest("hex")
  });
}

export async function verifyPackagedBlackBoxReport(input) {
  const platform = requiredString(input.platform, "black-box platform");
  const contract = requiredPlatformContract(platform);
  const version = requiredString(input.version, "black-box app version");
  const applicationPath = path.resolve(
    requiredString(input.applicationPath, "black-box application path")
  );
  const applicationMetadata = await lstat(applicationPath);
  if (!applicationMetadata.isDirectory() || applicationMetadata.isSymbolicLink()) {
    throw new Error("The black-box application must be a real package directory.");
  }
  const reportPath = path.resolve(
    requiredString(input.reportPath, "packaged black-box report path")
  );
  const { resolveElectronPackageLayout } = await import("./verifyElectronPackage.mjs");
  const { executablePath, resourcesPath } = resolveElectronPackageLayout(applicationPath);
  const componentPaths = {
    appAsar: path.join(resourcesPath, "app.asar"),
    executable: executablePath,
    nativeAddon: path.join(resourcesPath, "native", "rion-core.node")
  };
  const parsed = await readPackagedBlackBoxReport(reportPath, contract, version);
  const pathChecks = [
    [parsed.report.application.path, applicationPath, "application path"],
    [parsed.report.executable.path, componentPaths.executable, "executable path"],
    [parsed.report.appAsar.path, componentPaths.appAsar, "app.asar path"],
    [parsed.report.nativeAddon.path, componentPaths.nativeAddon, "native addon path"]
  ];
  for (const [actual, expected, field] of pathChecks) {
    if (actual !== expected) {
      throw new Error(`The packaged black-box report ${field} does not match the candidate.`);
    }
  }
  const observedPackageManifest =
    await capturePackagedElectronPackageManifest(applicationPath);
  const observedPackageManifestSummary = summarizePackagedElectronPackageManifest(
    observedPackageManifest
  );
  const componentHashes = componentHashesFromPackageManifest(
    applicationPath,
    componentPaths,
    observedPackageManifest
  );
  for (const [name, sha256] of Object.entries(componentHashes)) {
    if (parsed.report[name].sha256 !== sha256) {
      throw new Error(
        `The packaged black-box report ${blackBoxComponentLabel(name)} SHA-256 does not match the candidate.`
      );
    }
  }
  if (
    JSON.stringify(parsed.packageManifest) !==
    JSON.stringify(observedPackageManifestSummary)
  ) {
    throw new Error(
      "The packaged black-box report package manifest does not match the candidate."
    );
  }
  return {
    evidence: summarizePackagedBlackBoxReport(parsed, componentHashes),
    reportSource: parsed.source,
    screenshotSourcePath: parsed.screenshot.path
  };
}

function componentHashesFromPackageManifest(
  applicationPath,
  componentPaths,
  manifest
) {
  const entriesByPath = new Map(
    manifest.entries.map((entry) => [entry.path, entry])
  );
  const hashes = {};
  for (const [name, componentPath] of Object.entries(componentPaths)) {
    const relativePath = path.relative(applicationPath, componentPath);
    if (
      !relativePath ||
      path.isAbsolute(relativePath) ||
      relativePath === ".." ||
      relativePath.startsWith(`..${path.sep}`)
    ) {
      throw new Error(
        `The packaged black-box ${blackBoxComponentLabel(name)} path is outside the package.`
      );
    }
    const manifestPath = relativePath.split(path.sep).join("/");
    const entry = entriesByPath.get(manifestPath);
    if (entry?.type !== "regular-file") {
      throw new Error(
        `The packaged black-box ${blackBoxComponentLabel(name)} is absent from the package manifest.`
      );
    }
    hashes[name] = entry.sha256;
  }
  return hashes;
}

export async function verifyMinisignArtifact(artifactPath, signaturePath, publicKeySource) {
  const [artifact, signatureMetadata, signatureSource] = await Promise.all([
    requiredRegularFile(artifactPath, MAX_ARTIFACT_BYTES),
    requiredRegularFile(signaturePath, MAX_SIGNATURE_BYTES),
    readFile(signaturePath, "utf8")
  ]);
  const publicKey = normalizeUpdaterPublicKey(publicKeySource);
  const signature = decodeMinisignSignature(signatureSource);
  if (!timingSafeEqual(publicKey.keyId, signature.keyId)) {
    throw new Error("The updater signature key ID does not match the production public key.");
  }
  const { blake2b512, sha256 } = await hashArtifact(artifactPath);
  const key = createPublicKey({
    format: "der",
    key: Buffer.concat([PUBLIC_KEY_SPKI_PREFIX, publicKey.keyBytes]),
    type: "spki"
  });
  if (!verifyEd25519(null, blake2b512, key, signature.signature)) {
    throw new Error(`The updater signature is invalid for ${path.basename(artifactPath)}.`);
  }
  const globalMessage = Buffer.concat([
    signature.signature,
    Buffer.from(signature.trustedComment, "utf8")
  ]);
  if (!verifyEd25519(null, globalMessage, key, signature.globalSignature)) {
    throw new Error(`The updater trusted-comment signature is invalid for ${path.basename(artifactPath)}.`);
  }
  return Object.freeze({
    artifactBytes: artifact.size,
    artifactSha256: sha256,
    publicKeySha256: publicKey.sha256,
    signatureBytes: signatureMetadata.size,
    signatureSha256: createHash("sha256").update(signatureSource).digest("hex")
  });
}

export async function stageElectronProductionPlatformCandidate(input) {
  const validated = validateElectronProductionCandidateInputs(input);
  const contract = requiredPlatformContract(input.platform);
  const blackBox = await verifyPackagedBlackBoxReport({
    applicationPath: input.applicationPath,
    platform: input.platform,
    reportPath: input.blackBoxReportPath,
    version: validated.version
  });
  const artifactPath = path.resolve(requiredString(input.artifactPath, "artifact path"));
  const signaturePath = `${artifactPath}.sig`;
  if (path.basename(artifactPath) !== contract.artifactName) {
    throw new Error(
      `${input.platform} updater artifact must be named ${contract.artifactName}.`
    );
  }
  let windowsInstallerPayloadProof;
  let macosPackageBinding;
  if (contract.installerPayloadProofName) {
    windowsInstallerPayloadProof =
      await readAndVerifyWindowsElectronInstallerPayloadProof({
        blackBoxEvidence: blackBox.evidence,
        installerPath: artifactPath,
        proofPath: requiredString(
          input.windowsInstallerPayloadProofPath,
          "Windows installer payload proof path"
        ),
        sourceApplicationPath: input.applicationPath,
        sourceSha: validated.sourceSha,
        version: validated.version
      });
  } else if (input.windowsInstallerPayloadProofPath !== undefined) {
    throw new Error("The macOS candidate must not provide a Windows installer payload proof.");
  }
  const verification = await verifyMinisignArtifact(
    artifactPath,
    signaturePath,
    input.publicKey
  );
  const distributionPath = contract.distributionName
    ? path.resolve(requiredString(input.distributionPath, "macOS distribution path"))
    : undefined;
  if (!contract.distributionName && input.distributionPath) {
    throw new Error("The Windows candidate must not provide a secondary distribution artifact.");
  }
  let distribution;
  if (distributionPath) {
    if (path.basename(distributionPath) !== contract.distributionName) {
      throw new Error(`The macOS distribution must be named ${contract.distributionName}.`);
    }
    const metadata = await requiredRegularFile(distributionPath, MAX_ARTIFACT_BYTES);
    distribution = {
      bytes: metadata.size,
      fileName: contract.distributionName,
      sha256: await sha256File(distributionPath)
    };
    if (input.macosPackageBinding === undefined) {
      throw new Error("The macOS package binding is required.");
    }
    macosPackageBinding = assertMacosPackageBindingEvidence(
      input.macosPackageBinding,
      blackBox.evidence,
      {
        bytes: verification.artifactBytes,
        fileName: contract.artifactName,
        sha256: verification.artifactSha256
      },
      distribution
    );
  } else if (input.macosPackageBinding !== undefined) {
    throw new Error("The Windows candidate must not provide a macOS package binding.");
  }
  const outputDirectory = path.resolve(requiredString(input.outputDirectory, "output directory"));
  await mkdir(outputDirectory);
  const stagedScreenshotPath = path.join(
    outputDirectory,
    ELECTRON_PACKAGED_BLACK_BOX_SCREENSHOT_NAME
  );
  await Promise.all([
    copyFile(artifactPath, path.join(outputDirectory, contract.artifactName), fileConstants.COPYFILE_EXCL),
    copyFile(
      signaturePath,
      path.join(outputDirectory, `${contract.artifactName}.sig`),
      fileConstants.COPYFILE_EXCL
    ),
    ...(distributionPath
      ? [copyFile(
        distributionPath,
        path.join(outputDirectory, contract.distributionName),
        fileConstants.COPYFILE_EXCL
      )]
      : []),
    copyFile(
      blackBox.screenshotSourcePath,
      stagedScreenshotPath,
      fileConstants.COPYFILE_EXCL
    ),
    writeFile(
      path.join(outputDirectory, ELECTRON_PACKAGED_BLACK_BOX_REPORT_NAME),
      blackBox.reportSource,
      { flag: "wx", mode: 0o600 }
    ),
    ...(windowsInstallerPayloadProof
      ? [writeFile(
        path.join(outputDirectory, contract.installerPayloadProofName),
        windowsInstallerPayloadProof.source,
        { flag: "wx", mode: 0o600 }
      )]
      : [])
  ]);
  const stagedScreenshot = await validatePackagedPngArtifact(stagedScreenshotPath);
  if (
    stagedScreenshot.byteLength !== blackBox.evidence.screenshot.bytes ||
    stagedScreenshot.sha256 !== blackBox.evidence.screenshot.sha256
  ) {
    throw new Error("The staged packaged black-box screenshot does not match its report.");
  }
  const stagedArtifactPath = path.join(outputDirectory, contract.artifactName);
  const stagedVerification = await verifyMinisignArtifact(
    stagedArtifactPath,
    `${stagedArtifactPath}.sig`,
    input.publicKey
  );
  if (!isDeepStrictEqual(stagedVerification, verification)) {
    throw new Error("The staged updater artifact or signature does not match its source.");
  }
  if (macosPackageBinding) {
    const stagedDistribution = await captureStableBoundedFileIdentity(
      path.join(outputDirectory, contract.distributionName),
      MAX_ARTIFACT_BYTES,
      "staged macOS distribution"
    );
    assertMacosPackageBindingEvidence(
      macosPackageBinding,
      blackBox.evidence,
      {
        bytes: stagedVerification.artifactBytes,
        fileName: contract.artifactName,
        sha256: stagedVerification.artifactSha256
      },
      {
        ...stagedDistribution,
        fileName: contract.distributionName
      }
    );
  }
  if (windowsInstallerPayloadProof) {
    const stagedProof = await readAndVerifyWindowsElectronInstallerPayloadProof({
      blackBoxEvidence: blackBox.evidence,
      installerPath: stagedArtifactPath,
      proofPath: path.join(outputDirectory, contract.installerPayloadProofName),
      sourceSha: validated.sourceSha,
      version: validated.version
    });
    if (!isDeepStrictEqual(stagedProof.identity, windowsInstallerPayloadProof.identity)) {
      throw new Error("The staged Windows installer payload proof does not match its source.");
    }
  }
  const receipt = {
    schemaVersion: 1,
    kind: "rion-electron-production-platform-candidate",
    status: "verified-not-published",
    sourceSha: validated.sourceSha,
    version: validated.version,
    publishedAt: validated.publishedAt,
    platform: input.platform,
    applicationKind: contract.applicationKind,
    updaterBaseUrl: validated.baseUrl,
    updaterEndpoint: validated.updaterEndpoint,
    updaterEndpointPolicy: {
      redirects: "forbidden",
      requiredStatus: 200
    },
    publicKeySha256: validated.publicKeySha256,
    blackBox: blackBox.evidence,
    ...(macosPackageBinding ? { macosPackageBinding } : {}),
    ...(windowsInstallerPayloadProof
      ? { windowsInstallerPayloadProof: windowsInstallerPayloadProof.identity }
      : {}),
    artifact: {
      bytes: verification.artifactBytes,
      fileName: contract.artifactName,
      sha256: verification.artifactSha256,
      signatureBytes: verification.signatureBytes,
      signatureFileName: `${contract.artifactName}.sig`,
      signatureSha256: verification.signatureSha256
    },
    ...(distribution ? { distribution } : {}),
    distributionPolicy: contract.policy
  };
  await writeFile(
    path.join(outputDirectory, ELECTRON_PLATFORM_RECEIPT_NAME),
    serializeElectronProductionPlatformReceipt(receipt),
    { flag: "wx", mode: 0o600 }
  );
  return receipt;
}

export async function assembleElectronProductionCandidate(input) {
  const validated = validateElectronProductionCandidateInputs(input);
  const macDirectory = path.resolve(requiredString(input.macDirectory, "macOS candidate directory"));
  const windowsDirectory = path.resolve(
    requiredString(input.windowsDirectory, "Windows candidate directory")
  );
  const outputDirectory = path.resolve(requiredString(input.outputDirectory, "output directory"));
  const receiptPath = path.resolve(requiredString(input.receiptPath, "candidate receipt path"));
  const receiptRelation = path.relative(outputDirectory, receiptPath);
  if (
    !receiptRelation ||
    (receiptRelation !== ".." &&
      !receiptRelation.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(receiptRelation))
  ) {
    throw new Error("The candidate receipt must remain outside the immutable release asset directory.");
  }
  const [macReceipt, windowsReceipt] = await Promise.all([
    readAndVerifyPlatformCandidate(macDirectory, "darwin-aarch64", validated, input.publicKey),
    readAndVerifyPlatformCandidate(
      windowsDirectory,
      "windows-x86_64",
      validated,
      input.publicKey
    )
  ]);
  await mkdir(outputDirectory);
  const sourceAssets = [
    [macDirectory, "Rion.Studio-mac.dmg"],
    [macDirectory, "Rion.Studio-mac.app.tar.gz"],
    [macDirectory, "Rion.Studio-mac.app.tar.gz.sig"],
    [windowsDirectory, "Rion.Studio-win.exe"],
    [windowsDirectory, "Rion.Studio-win.exe.sig"]
  ];
  await Promise.all(sourceAssets.map(([directory, name]) => copyFile(
    path.join(directory, name),
    path.join(outputDirectory, name),
    fileConstants.COPYFILE_EXCL
  )));
  await assertCopiedPlatformAssetsMatchReceipts(
    outputDirectory,
    macReceipt,
    windowsReceipt
  );
  await createUpdaterManifest([
    "--version", validated.version,
    "--base-url", validated.baseUrl,
    "--mac-archive", path.join(outputDirectory, "Rion.Studio-mac.app.tar.gz"),
    "--windows-installer", path.join(outputDirectory, "Rion.Studio-win.exe"),
    "--published-at", validated.publishedAt,
    "--output", path.join(outputDirectory, "latest.json")
  ]);
  await verifyReleaseAssets(outputDirectory, validated.version);
  await writeReleaseChecksums(outputDirectory);
  const assetNames = await verifyReleaseAssets(outputDirectory, validated.version, {
    allowChecksums: true
  });
  const assetSha256 = {};
  for (const name of assetNames) {
    const identity = await captureStableBoundedFileIdentity(
      path.join(outputDirectory, name),
      MAX_ARTIFACT_BYTES,
      `assembled candidate asset ${name}`
    );
    assetSha256[name] = identity.sha256;
  }
  assertCandidateAssetDigestsMatchPlatformReceipts(
    assetSha256,
    macReceipt,
    windowsReceipt
  );
  const receipt = {
    schemaVersion: 1,
    kind: "rion-electron-production-candidate",
    status: "verified-not-published",
    publication: {
      allowedByThisWorkflow: false,
      status: "candidate-only"
    },
    ownerGate: {
      approval: ELECTRON_PRODUCTION_CANDIDATE_APPROVAL,
      environment: ELECTRON_PRODUCTION_ENVIRONMENT
    },
    sourceSha: validated.sourceSha,
    version: validated.version,
    publishedAt: validated.publishedAt,
    updaterBaseUrl: validated.baseUrl,
    updaterEndpoint: validated.updaterEndpoint,
    updaterEndpointPolicy: {
      redirects: "forbidden",
      requiredStatus: 200
    },
    publicKeySha256: validated.publicKeySha256,
    platforms: {
      "darwin-aarch64": summarizedPlatformReceipt(macReceipt),
      "windows-x86_64": summarizedPlatformReceipt(windowsReceipt)
    },
    assets: assetSha256,
    compatibility: {
      stableTauriReleasePath: "preserved",
      tauriV22CutoverEvidence: "separate-required-gate"
    }
  };
  await writeJsonExclusive(receiptPath, receipt);
  return receipt;
}

async function signPlatformCommand(options, environment) {
  const platform = requiredOption(options, "platform");
  const contract = requiredPlatformContract(platform);
  if (process.platform !== contract.os) {
    throw new Error(`${platform} production candidates must be staged on ${contract.os}.`);
  }
  const applicationPath = path.resolve(requiredOption(options, "application"));
  const {
    assertWindowsAuthenticodeStatus,
    verifyPackagedElectron
  } = await import("./verifyElectronPackage.mjs");
  const expectedVersion = requiredOption(options, "version");
  const applicationLayout = await verifyPackagedElectron(applicationPath);
  await assertPackagedApplicationVersion(applicationLayout.resourcesPath, expectedVersion);
  const blackBoxReportPath = path.resolve(requiredOption(options, "black-box-report"));
  const blackBox = await verifyPackagedBlackBoxReport({
    applicationPath,
    platform,
    reportPath: blackBoxReportPath,
    version: expectedVersion
  });
  const artifactPath = path.resolve(requiredOption(options, "artifact"));
  await assertPathMissing(`${artifactPath}.sig`, "updater signature");
  requiredString(environment.TAURI_SIGNING_PRIVATE_KEY, "TAURI_SIGNING_PRIVATE_KEY");
  requiredString(
    environment.TAURI_SIGNING_PRIVATE_KEY_PASSWORD,
    "TAURI_SIGNING_PRIVATE_KEY_PASSWORD"
  );
  requiredString(environment.RION_STUDIO_UPDATER_PUBLIC_KEY, "RION_STUDIO_UPDATER_PUBLIC_KEY");
  const verificationEnvironment = sanitizeUpdaterRuntimeEnvironment(environment);
  let macosPackageBinding;
  if (platform === "darwin-aarch64") {
    if (options.has("windows-installer-payload-proof")) {
      throw new Error("The macOS candidate must not provide a Windows installer payload proof.");
    }
    await verifyMacosUpdaterArchive({
      artifactPath,
      environment: verificationEnvironment,
      expectedPackageManifest: blackBox.evidence.packageManifest,
      expectedVersion,
      packageVerifier: verifyPackagedElectron
    });
    await verifyMacosDistributionPackage({
      distributionPath: path.resolve(requiredOption(options, "distribution")),
      environment: verificationEnvironment,
      expectedPackageManifest: blackBox.evidence.packageManifest,
      expectedVersion,
      packageVerifier: verifyPackagedElectron
    });
  } else {
    await readAndVerifyWindowsElectronInstallerPayloadProof({
      blackBoxEvidence: blackBox.evidence,
      installerPath: artifactPath,
      proofPath: path.resolve(requiredOption(options, "windows-installer-payload-proof")),
      sourceApplicationPath: applicationPath,
      sourceSha: requiredOption(options, "source-sha"),
      version: expectedVersion
    });
    const status = await windowsAuthenticodeStatus(
      artifactPath,
      verificationEnvironment
    );
    assertWindowsAuthenticodeStatus(status);
  }
  await signUpdaterArtifact({
    artifactPath,
    environment,
    workingDirectory: path.resolve(".")
  });
  if (platform === "darwin-aarch64") {
    macosPackageBinding = await createVerifiedMacosPackageBinding({
      artifactPath,
      distributionPath: path.resolve(requiredOption(options, "distribution")),
      expectedPackageManifest: blackBox.evidence.packageManifest,
      expectedVersion,
      packageVerifier: verifyPackagedElectron,
      environment: verificationEnvironment
    });
  }
  return stageElectronProductionPlatformCandidate({
    applicationPath,
    artifactPath,
    blackBoxReportPath,
    distributionPath: options.get("distribution"),
    macosPackageBinding,
    outputDirectory: requiredOption(options, "output"),
    ownerApproval: requiredOption(options, "owner-approval"),
    platform,
    publicKey: environment.RION_STUDIO_UPDATER_PUBLIC_KEY,
    publishedAt: requiredOption(options, "published-at"),
    sourceSha: requiredOption(options, "source-sha"),
    updaterBaseUrl: requiredOption(options, "updater-base-url"),
    version: expectedVersion,
    windowsInstallerPayloadProofPath: options.get("windows-installer-payload-proof")
  });
}

async function readPackagedBlackBoxReport(
  reportPath,
  contract,
  expectedVersion,
  screenshotPathOverride
) {
  const source = await readStableBoundedRegularFile(
    reportPath,
    MAX_BLACK_BOX_REPORT_BYTES,
    "packaged black-box report"
  );
  let report;
  try {
    report = JSON.parse(source.toString("utf8"));
  } catch (error) {
    throw new Error("The packaged black-box report is invalid JSON.", { cause: error });
  }
  assertExactBlackBoxFields(
    report,
    PACKAGED_ELECTRON_BLACK_BOX_FIELDS,
    "report"
  );
  assertExactBlackBoxFields(report.application, ["path"], "application");
  assertExactBlackBoxFields(
    report.screenshot,
    ["byteLength", "path", "sha256"],
    "screenshot"
  );
  const packageManifest = assertPackagedElectronPackageManifestSummary(
    report.packageManifest
  );
  for (const name of ["executable", "appAsar", "nativeAddon"]) {
    assertExactBlackBoxFields(report[name], ["path", "sha256"], name);
    if (!/^[0-9a-f]{64}$/u.test(report[name].sha256 ?? "")) {
      throw new Error(`The packaged black-box report ${blackBoxComponentLabel(name)} SHA-256 is invalid.`);
    }
  }
  if (!source.equals(serializePackagedElectronBlackBoxReport(report))) {
    throw new Error("The packaged black-box report is not canonical JSON.");
  }
  const checks = [
    [report.schemaVersion, 1, "schema version"],
    [report.kind, PACKAGED_ELECTRON_BLACK_BOX_KIND, "kind"],
    [report.verdict, "passed", "verdict"],
    [report.platform, contract.blackBox.platform, "platform"],
    [report.runtimeTarget, contract.blackBox.runtimeTarget, "runtime target"],
    [report.isolationKind, contract.blackBox.isolationKind, "profile isolation kind"],
    [report.nativeHostKind, contract.blackBox.nativeHostKind, "native host kind"],
    [report.appVersion, expectedVersion, "app version"],
    [report.fixtureInteraction, "visible-os-accessibility-click", "fixture interaction"],
    [report.remoteDebugging, false, "remote-debugging verdict"],
    [report.exitCode, 0, "exit code"]
  ];
  for (const [actual, expected, field] of checks) {
    if (actual !== expected) {
      throw new Error(`The packaged black-box report ${field} does not match the candidate.`);
    }
  }
  for (const [value, field] of [
    [report.application.path, "application path"],
    [report.executable.path, "executable path"],
    [report.appAsar.path, "app.asar path"],
    [report.nativeAddon.path, "native addon path"],
    [report.gameId, "game ID"],
    [report.roleId, "role ID"],
    [report.runtimeHomeDirectory, "runtime home directory"],
    [report.userDataDirectory, "user-data directory"]
  ]) {
    requiredString(value, `packaged black-box ${field}`);
  }
  if (!Number.isSafeInteger(report.screenshot.byteLength) || report.screenshot.byteLength <= 0) {
    throw new Error("The packaged black-box screenshot byte length is invalid.");
  }
  requiredString(report.screenshot.path, "packaged black-box screenshot path");
  if (!/^[0-9a-f]{64}$/u.test(report.screenshot.sha256 ?? "")) {
    throw new Error("The packaged black-box screenshot SHA-256 is invalid.");
  }
  const resolvedReportPath = path.resolve(reportPath);
  const expectedSiblingPath = path.join(
    path.dirname(resolvedReportPath),
    ELECTRON_PACKAGED_BLACK_BOX_SCREENSHOT_NAME
  );
  const screenshotPath = screenshotPathOverride === undefined
    ? expectedSiblingPath
    : path.resolve(screenshotPathOverride);
  if (screenshotPath !== expectedSiblingPath) {
    throw new Error("The staged packaged black-box screenshot is not the exact report sibling.");
  }
  if (
    screenshotPathOverride === undefined &&
    report.screenshot.path !== expectedSiblingPath
  ) {
    throw new Error("The packaged black-box screenshot is not the exact report sibling.");
  }
  const screenshot = await validatePackagedPngArtifact(screenshotPath);
  if (
    screenshot.byteLength !== report.screenshot.byteLength ||
    screenshot.sha256 !== report.screenshot.sha256
  ) {
    throw new Error("The packaged black-box screenshot does not match its report.");
  }
  return {
    contract,
    report,
    reportSha256: createHash("sha256").update(source).digest("hex"),
    packageManifest,
    screenshot,
    source
  };
}

function summarizePackagedBlackBoxReport(parsed, verifiedHashes) {
  const report = parsed.report;
  return {
    schemaVersion: report.schemaVersion,
    kind: report.kind,
    verdict: report.verdict,
    runtimePlatform: report.platform,
    runtimeTarget: report.runtimeTarget,
    isolationKind: report.isolationKind,
    nativeHostKind: report.nativeHostKind,
    appVersion: report.appVersion,
    application: {
      path: report.application.path
    },
    executable: {
      fileName: parsed.contract.blackBox.executableName,
      sha256: verifiedHashes?.executable ?? report.executable.sha256
    },
    appAsar: {
      fileName: "app.asar",
      sha256: verifiedHashes?.appAsar ?? report.appAsar.sha256
    },
    nativeAddon: {
      fileName: "rion-core.node",
      sha256: verifiedHashes?.nativeAddon ?? report.nativeAddon.sha256
    },
    packageManifest: parsed.packageManifest,
    screenshot: {
      bytes: parsed.screenshot.byteLength,
      fileName: ELECTRON_PACKAGED_BLACK_BOX_SCREENSHOT_NAME,
      sha256: parsed.screenshot.sha256
    },
    remoteDebugging: report.remoteDebugging,
    exitCode: report.exitCode,
    report: {
      bytes: parsed.source.length,
      fileName: ELECTRON_PACKAGED_BLACK_BOX_REPORT_NAME,
      sha256: parsed.reportSha256
    }
  };
}

function assertExactBlackBoxFields(value, expectedFields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`The packaged black-box ${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedFields].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`The packaged black-box ${label} has an unexpected schema.`);
  }
}

function blackBoxComponentLabel(name) {
  if (name === "appAsar") return "app.asar";
  if (name === "nativeAddon") return "native addon";
  return name;
}

async function readAndVerifyPlatformCandidate(directory, platform, expected, publicKey) {
  const contract = requiredPlatformContract(platform);
  const expectedNames = [
    contract.artifactName,
    `${contract.artifactName}.sig`,
    ELECTRON_PACKAGED_BLACK_BOX_REPORT_NAME,
    ELECTRON_PACKAGED_BLACK_BOX_SCREENSHOT_NAME,
    ELECTRON_PLATFORM_RECEIPT_NAME,
    ...(contract.installerPayloadProofName
      ? [contract.installerPayloadProofName]
      : []),
    ...(contract.distributionName ? [contract.distributionName] : [])
  ].sort();
  const names = (await readdir(directory)).sort();
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
    throw new Error(`${platform} candidate inventory must be exactly ${expectedNames.join(", ")}.`);
  }
  const receiptPath = path.join(directory, ELECTRON_PLATFORM_RECEIPT_NAME);
  const receiptSource = await readStableBoundedRegularFile(
    receiptPath,
    1024 * 1024,
    `${platform} platform receipt`
  );
  let receipt;
  try {
    receipt = JSON.parse(receiptSource.toString("utf8"));
  } catch (error) {
    throw new Error(`${platform} platform receipt is invalid JSON.`, {
      cause: error
    });
  }
  assertPlatformReceipt(receipt, platform, contract, expected);
  if (!receiptSource.equals(serializeElectronProductionPlatformReceipt(receipt))) {
    throw new Error(`${platform} platform receipt is not canonical JSON.`);
  }
  const blackBox = await readPackagedBlackBoxReport(
    path.join(directory, ELECTRON_PACKAGED_BLACK_BOX_REPORT_NAME),
    contract,
    expected.version,
    path.join(directory, ELECTRON_PACKAGED_BLACK_BOX_SCREENSHOT_NAME)
  );
  const blackBoxEvidence = summarizePackagedBlackBoxReport(blackBox);
  if (!isDeepStrictEqual(receipt.blackBox, blackBoxEvidence)) {
    throw new Error(`${platform} packaged black-box evidence does not match its report.`);
  }
  const artifactPath = path.join(directory, contract.artifactName);
  const verification = await verifyMinisignArtifact(
    artifactPath,
    `${artifactPath}.sig`,
    publicKey
  );
  assertEqual(receipt.artifact.bytes, verification.artifactBytes, platform, "artifact bytes");
  assertEqual(receipt.artifact.sha256, verification.artifactSha256, platform, "artifact SHA-256");
  assertEqual(
    receipt.artifact.signatureBytes,
    verification.signatureBytes,
    platform,
    "signature bytes"
  );
  assertEqual(
    receipt.artifact.signatureSha256,
    verification.signatureSha256,
    platform,
    "signature SHA-256"
  );
  if (contract.installerPayloadProofName) {
    const payloadProof = await readAndVerifyWindowsElectronInstallerPayloadProof({
      blackBoxEvidence,
      installerPath: artifactPath,
      proofPath: path.join(directory, contract.installerPayloadProofName),
      sourceSha: expected.sourceSha,
      version: expected.version
    });
    assertProofIdentity(
      receipt.windowsInstallerPayloadProof,
      payloadProof.identity,
      platform
    );
  }
  if (contract.distributionName) {
    const distributionPath = path.join(directory, contract.distributionName);
    const metadata = await requiredRegularFile(distributionPath, MAX_ARTIFACT_BYTES);
    const observedDistribution = {
      bytes: metadata.size,
      fileName: contract.distributionName,
      sha256: await sha256File(distributionPath)
    };
    assertEqual(receipt.distribution.bytes, metadata.size, platform, "distribution bytes");
    assertEqual(
      receipt.distribution.sha256,
      observedDistribution.sha256,
      platform,
      "distribution SHA-256"
    );
    assertMacosPackageBindingEvidence(
      receipt.macosPackageBinding,
      blackBoxEvidence,
      {
        bytes: verification.artifactBytes,
        fileName: contract.artifactName,
        sha256: verification.artifactSha256
      },
      observedDistribution
    );
  }
  receipt.platformReceiptSha256 = createHash("sha256")
    .update(receiptSource)
    .digest("hex");
  return receipt;
}

function assertPlatformReceipt(receipt, platform, contract, expected) {
  assertExactPlatformReceiptFields(receipt, [
    "applicationKind",
    "artifact",
    "blackBox",
    ...(contract.installerPayloadProofName
      ? ["windowsInstallerPayloadProof"]
      : []),
    ...(contract.distributionName
      ? ["distribution", "macosPackageBinding"]
      : []),
    "distributionPolicy",
    "kind",
    "platform",
    "publicKeySha256",
    "publishedAt",
    "schemaVersion",
    "sourceSha",
    "status",
    "updaterBaseUrl",
    "updaterEndpoint",
    "updaterEndpointPolicy",
    "version"
  ], platform);
  assertArtifactReceiptShape(receipt?.artifact, contract.artifactName, platform);
  const checks = [
    [receipt?.schemaVersion, 1, "schema version"],
    [receipt?.kind, "rion-electron-production-platform-candidate", "kind"],
    [receipt?.status, "verified-not-published", "status"],
    [receipt?.sourceSha, expected.sourceSha, "source SHA"],
    [receipt?.version, expected.version, "version"],
    [receipt?.publishedAt, expected.publishedAt, "published-at"],
    [receipt?.platform, platform, "platform"],
    [receipt?.applicationKind, contract.applicationKind, "application kind"],
    [receipt?.updaterBaseUrl, expected.baseUrl, "updater base URL"],
    [receipt?.updaterEndpoint, expected.updaterEndpoint, "updater endpoint"],
    [receipt?.publicKeySha256, expected.publicKeySha256, "public-key digest"],
    [receipt?.artifact?.fileName, contract.artifactName, "artifact name"],
    [receipt?.artifact?.signatureFileName, `${contract.artifactName}.sig`, "signature name"]
  ];
  if (contract.distributionName) {
    assertDistributionReceiptShape(
      receipt?.distribution,
      contract.distributionName,
      platform
    );
    checks.push([
      receipt?.distribution?.fileName,
      contract.distributionName,
      "distribution name"
    ]);
    assertMacosPackageBindingEvidence(
      receipt?.macosPackageBinding,
      receipt?.blackBox,
      {
        bytes: receipt?.artifact?.bytes,
        fileName: receipt?.artifact?.fileName,
        sha256: receipt?.artifact?.sha256
      },
      receipt?.distribution
    );
  } else if (receipt?.distribution !== undefined) {
    throw new Error(`${platform} platform receipt contains an unexpected distribution.`);
  } else if (receipt?.macosPackageBinding !== undefined) {
    throw new Error(`${platform} platform receipt contains an unexpected macOS package binding.`);
  }
  if (contract.installerPayloadProofName) {
    assertProofIdentityShape(receipt?.windowsInstallerPayloadProof, platform);
  } else if (receipt?.windowsInstallerPayloadProof !== undefined) {
    throw new Error(`${platform} platform receipt contains an unexpected installer payload proof.`);
  }
  for (const [actual, wanted, field] of checks) {
    assertEqual(actual, wanted, platform, field);
  }
  if (JSON.stringify(receipt?.distributionPolicy) !== JSON.stringify(contract.policy)) {
    throw new Error(`${platform} platform receipt has the wrong distribution policy.`);
  }
  if (JSON.stringify(receipt?.updaterEndpointPolicy) !== JSON.stringify({
    redirects: "forbidden",
    requiredStatus: 200
  })) {
    throw new Error(`${platform} platform receipt has the wrong updater endpoint policy.`);
  }
}

function assertArtifactReceiptShape(artifact, artifactName, platform) {
  assertExactNestedReceiptFields(artifact, [
    "bytes",
    "fileName",
    "sha256",
    "signatureBytes",
    "signatureFileName",
    "signatureSha256"
  ], platform, "artifact");
  assertPositiveReceiptInteger(artifact.bytes, platform, "artifact bytes");
  assertReceiptDigest(artifact.sha256, platform, "artifact SHA-256");
  assertPositiveReceiptInteger(artifact.signatureBytes, platform, "signature bytes");
  assertReceiptDigest(artifact.signatureSha256, platform, "signature SHA-256");
  if (
    artifact.fileName !== artifactName ||
    artifact.signatureFileName !== `${artifactName}.sig`
  ) {
    throw new Error(`${platform} platform receipt has the wrong artifact filenames.`);
  }
}

function assertDistributionReceiptShape(distribution, distributionName, platform) {
  assertExactNestedReceiptFields(
    distribution,
    ["bytes", "fileName", "sha256"],
    platform,
    "distribution"
  );
  assertPositiveReceiptInteger(distribution.bytes, platform, "distribution bytes");
  assertReceiptDigest(distribution.sha256, platform, "distribution SHA-256");
  if (distribution.fileName !== distributionName) {
    throw new Error(`${platform} platform receipt has the wrong distribution filename.`);
  }
}

function assertExactNestedReceiptFields(value, expectedFields, platform, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${platform} platform receipt ${label} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedFields].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${platform} platform receipt ${label} has an unexpected schema.`);
  }
}

function assertPositiveReceiptInteger(value, platform, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${platform} platform receipt has invalid ${label}.`);
  }
}

function assertReceiptDigest(value, platform, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${platform} platform receipt has invalid ${label}.`);
  }
}

function assertExactPlatformReceiptFields(receipt, expectedFields, platform) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new Error(`${platform} platform receipt must be an object.`);
  }
  const actual = Object.keys(receipt).sort();
  const expected = [...expectedFields].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${platform} platform receipt has an unexpected schema.`);
  }
}

function summarizedPlatformReceipt(receipt) {
  return {
    applicationKind: receipt.applicationKind,
    artifact: receipt.artifact,
    blackBox: receipt.blackBox,
    ...(receipt.windowsInstallerPayloadProof
      ? { windowsInstallerPayloadProof: receipt.windowsInstallerPayloadProof }
      : {}),
    ...(receipt.macosPackageBinding
      ? { macosPackageBinding: receipt.macosPackageBinding }
      : {}),
    ...(receipt.distribution ? { distribution: receipt.distribution } : {}),
    distributionPolicy: receipt.distributionPolicy,
    platformReceiptSha256: receipt.platformReceiptSha256
  };
}

function assertProofIdentityShape(identity, platform) {
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) {
    throw new Error(`${platform} installer payload proof identity must be an object.`);
  }
  const actual = Object.keys(identity).sort();
  const expected = ["bytes", "fileName", "sha256"];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${platform} installer payload proof identity has an unexpected schema.`);
  }
  if (!Number.isSafeInteger(identity.bytes) || identity.bytes <= 0) {
    throw new Error(`${platform} installer payload proof identity has invalid bytes.`);
  }
  if (identity.fileName !== WINDOWS_ELECTRON_INSTALLER_PAYLOAD_PROOF_NAME) {
    throw new Error(`${platform} installer payload proof identity has the wrong filename.`);
  }
  if (typeof identity.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(identity.sha256)) {
    throw new Error(`${platform} installer payload proof identity has an invalid SHA-256.`);
  }
}

function assertProofIdentity(actual, expected, platform) {
  assertProofIdentityShape(actual, platform);
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`${platform} installer payload proof identity does not match its proof.`);
  }
}

function normalizeUpdaterBaseUrl(value) {
  let baseUrl;
  try {
    baseUrl = new URL(requiredString(value, "updater base URL"));
  } catch (error) {
    throw new Error("The production updater base URL is invalid.", { cause: error });
  }
  if (
    baseUrl.protocol !== "https:" ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash ||
    /%2f|%5c/iu.test(baseUrl.pathname)
  ) {
    throw new Error(
      "The production updater base URL must use public HTTPS without credentials, query, fragment, or encoded separators."
    );
  }
  if (!baseUrl.pathname.endsWith("/")) baseUrl.pathname += "/";
  return baseUrl;
}

function decodePublicKeySource(source) {
  const direct = decodePublicKeyDocument(source);
  if (direct) return direct;
  const outer = decodeBase64(source);
  if (outer) {
    const decodedDocument = outer.toString("utf8").trim();
    const decoded = decodePublicKeyDocument(decodedDocument);
    if (decoded) return decoded;
  }
  throw new Error("RION_STUDIO_UPDATER_PUBLIC_KEY is not a valid Minisign public key.");
}

function decodePublicKeyDocument(source) {
  const lines = source.split(/\r?\n/u);
  const raw = lines.length === 1
    ? decodeBase64(lines[0])
    : lines.length === 2 && lines[0].startsWith("untrusted comment:")
      ? decodeBase64(lines[1])
      : undefined;
  return raw?.length === 42 ? raw : undefined;
}

function decodeMinisignSignature(source) {
  const normalized = source.trim();
  const direct = decodeMinisignSignatureDocument(normalized);
  if (direct) return direct;
  const outer = decodeBase64(normalized);
  if (outer) {
    const decoded = decodeMinisignSignatureDocument(outer.toString("utf8").trim());
    if (decoded) return decoded;
  }
  throw new Error("The updater signature must contain a four-line Minisign signature.");
}

function decodeMinisignSignatureDocument(source) {
  const lines = source.split(/\r?\n/u);
  if (
    lines.length !== 4 ||
    !lines[0].startsWith("untrusted comment:") ||
    !lines[2].startsWith("trusted comment: ")
  ) {
    return undefined;
  }
  const primary = decodeBase64(lines[1]);
  const globalSignature = decodeBase64(lines[3]);
  if (!primary || primary.length !== 74 || !globalSignature || globalSignature.length !== 64) {
    return undefined;
  }
  if (!primary.subarray(0, 2).equals(Buffer.from("ED"))) {
    throw new Error("The updater signature must use Minisign prehashed mode.");
  }
  return {
    globalSignature,
    keyId: Buffer.from(primary.subarray(2, 10)),
    signature: Buffer.from(primary.subarray(10, 74)),
    trustedComment: lines[2].slice("trusted comment: ".length)
  };
}

function decodeBase64(value) {
  if (!value || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value) || value.length % 4 !== 0) {
    return undefined;
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) return undefined;
  return decoded;
}

async function hashArtifact(filePath) {
  const sha256 = createHash("sha256");
  const blake2b512 = createHash("blake2b512");
  for await (const chunk of createReadStream(filePath)) {
    sha256.update(chunk);
    blake2b512.update(chunk);
  }
  return {
    blake2b512: blake2b512.digest(),
    sha256: sha256.digest("hex")
  };
}

async function sha256File(filePath) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest("hex");
}

async function requiredRegularFile(filePath, maximumBytes) {
  const metadata = await lstat(filePath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size === 0 ||
    metadata.size > maximumBytes
  ) {
    throw new Error(`${filePath} is not a bounded, nonempty regular file.`);
  }
  return metadata;
}

async function readStableBoundedRegularFile(filePath, maximumBytes, label) {
  const pathMetadata = await lstat(filePath, { bigint: true });
  assertBoundedRegularFile(pathMetadata, maximumBytes, label);
  const noFollow = typeof fileConstants.O_NOFOLLOW === "number"
    ? fileConstants.O_NOFOLLOW
    : 0;
  const handle = await open(filePath, fileConstants.O_RDONLY | noFollow);
  try {
    const openedMetadata = await handle.stat({ bigint: true });
    assertSameRegularFile(pathMetadata, openedMetadata, label);
    assertBoundedRegularFile(openedMetadata, maximumBytes, label);
    const source = await readExactFileBytes(
      handle,
      openedMetadata.size,
      label
    );
    const completedMetadata = await handle.stat({ bigint: true });
    assertSameRegularFile(openedMetadata, completedMetadata, label);
    const completedPathMetadata = await lstat(filePath, { bigint: true });
    assertSameRegularFile(completedMetadata, completedPathMetadata, label);
    return source;
  } finally {
    await handle.close();
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

async function readExactFileBytes(handle, expectedSize, label) {
  const length = Number(expectedSize);
  const bytes = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(bytes, offset, length - offset, offset);
    if (result.bytesRead === 0) {
      throw new Error(`${label} changed while it was being read.`);
    }
    offset += result.bytesRead;
  }
  const sentinel = Buffer.allocUnsafe(1);
  const result = await handle.read(sentinel, 0, 1, length);
  if (result.bytesRead !== 0) {
    throw new Error(`${label} exceeded its safe byte bound while it was being read.`);
  }
  return bytes;
}

async function writeJsonExclusive(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
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

async function windowsAuthenticodeStatus(filePath, environment) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$signature = Get-AuthenticodeSignature -LiteralPath '${filePath.replaceAll("'", "''")}'`,
    "[Console]::Out.Write($signature.Status.ToString())"
  ].join("; ");
  return runCommand(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    sanitizeUpdaterRuntimeEnvironment(environment),
    true
  );
}

async function runCommand(command, argumentsList, environment = process.env, capture = false) {
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

function requiredPlatformContract(platform) {
  const contract = PLATFORM_CONTRACTS[platform];
  if (!contract) {
    throw new Error("--platform must be darwin-aarch64 or windows-x86_64.");
  }
  return contract;
}

function requiredString(value, name) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`${name} is required.`);
  return normalized;
}

function assertEqual(actual, expected, platform, field) {
  if (actual !== expected) {
    throw new Error(`${platform} platform receipt ${field} does not match the candidate.`);
  }
}

function parseArguments(argumentsList) {
  const options = new Map();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const name = argumentsList[index];
    const value = argumentsList[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid production candidate argument near ${name ?? "<end>"}.`);
    }
    const key = name.slice(2);
    if (options.has(key)) throw new Error(`Duplicate option --${key}.`);
    options.set(key, value);
  }
  return options;
}

function requiredOption(options, name) {
  return requiredString(options.get(name), `--${name}`);
}

function inputFromOptions(options, environment) {
  return {
    ownerApproval: requiredOption(options, "owner-approval"),
    publicKey: requiredString(
      environment.RION_STUDIO_UPDATER_PUBLIC_KEY,
      "RION_STUDIO_UPDATER_PUBLIC_KEY"
    ),
    publishedAt: requiredOption(options, "published-at"),
    sourceSha: requiredOption(options, "source-sha"),
    updaterBaseUrl: requiredOption(options, "updater-base-url"),
    version: requiredOption(options, "version")
  };
}

async function runCli(argumentsList = process.argv.slice(2), environment = process.env) {
  const normalizedArguments = argumentsList[0] === "--" ? argumentsList.slice(1) : argumentsList;
  const [command, ...optionArguments] = normalizedArguments;
  const options = parseArguments(optionArguments);
  if (command === "validate-inputs") {
    const result = validateElectronProductionCandidateInputs(inputFromOptions(options, environment));
    console.log(JSON.stringify(result));
    return result;
  }
  if (command === "sign-platform") return signPlatformCommand(options, environment);
  if (command === "assemble") {
    return assembleElectronProductionCandidate({
      ...inputFromOptions(options, environment),
      macDirectory: requiredOption(options, "mac-directory"),
      outputDirectory: requiredOption(options, "output"),
      receiptPath: requiredOption(options, "receipt"),
      windowsDirectory: requiredOption(options, "windows-directory")
    });
  }
  throw new Error("Usage: electronProductionCandidate.mjs <validate-inputs|sign-platform|assemble> [options]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
