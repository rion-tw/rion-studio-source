import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { serializeCanonicalJson } from "../../scripts/canonicalJson.mjs";
import {
  ELECTRON_UPDATER_DARWIN_ISOLATION_RESULT_NAME,
  writeElectronUpdaterDarwinProcessIsolationResult
} from "../../scripts/electronUpdaterDarwinIsolationResultContract.mjs";
import {
  completeElectronUpdaterDarwinProcessIsolationEvidence,
  createElectronUpdaterDarwinProcessSupervisor,
  terminateElectronUpdaterDarwinProcessSupervisor,
  waitForElectronUpdaterDarwinProcessSupervisorAdmission
} from "../../scripts/electronUpdaterDarwinProcessSupervisor.mjs";
import {
  finalizeMacosElectronUpdaterCompatibilityTerminalReceipt,
  writeElectronUpdaterCompatibilityProvisionalReceipt
} from "../../scripts/electronUpdaterMacosCompatibilityReceiptFinalizer.mjs";
import { ELECTRON_UPDATER_PREPARED_INPUT_KIND } from
  "../../scripts/electronUpdaterPreparedProbeInput.mjs";
import type {
  DarwinPackagedProcessOperations,
  DarwinProcessInventoryRecord
} from "../../scripts/packagedElectronDarwinProcessOwnership.mjs";

export const MACOS_SOURCE_SHA = "3".repeat(40);
export const MACOS_TARGET_SHA = "4".repeat(40);
export const MACOS_TRUST_SHA256 = sha256("production macOS updater public key");
export const MACOS_COMMAND_SHA256 = sha256("parent macOS sandbox invocation");
export const MACOS_SANDBOX_SHA256 = sha256("exact seatbelt profile bytes");
export const MACOS_ATTEMPT_NONCE = "abcdef0123456789abcdef0123456789";
export const MACOS_HELPER_ATTEMPT =
  "update-install-12345678-1234-4234-8234-123456789abc";
export const MACOS_PROBE_COMPLETED_AT = "2026-09-01T02:02:03.000Z";
export const MACOS_FINALIZED_AT = "2026-09-01T02:02:04.000Z";
export const MACOS_TARGET_VERSION = "23.4.0";
const ISOLATION_COMPLETED_AT = "2026-09-01T02:02:02.000Z";
const LAUNCH_MILLISECONDS = 1_800_000_000_000;

export const MACOS_CASES = [
  {
    outcome: "applied",
    probe: "packaged-artifact-manifest-fail-closed",
    sourceRuntime: "electron-v23"
  },
  {
    outcome: "applied",
    probe: "macos-bundle-replacement",
    sourceRuntime: "electron-v23",
    sourceVersion: "22.8.0",
    targetVersion: MACOS_TARGET_VERSION
  },
  {
    outcome: "applied",
    probe: "macos-bundle-replacement",
    sourceRuntime: "electron-v23",
    sourceVersion: "23.0.0",
    targetVersion: MACOS_TARGET_VERSION
  },
  {
    outcome: "applied",
    probe: "macos-helper-handoff-and-relaunch",
    sourceRuntime: "tauri-v22",
    sourceVersion: "22.8.0",
    targetVersion: MACOS_TARGET_VERSION
  }
] as const;

export async function createMacosCompatibilityFinalizerFixture() {
  const requestedRoot = await mkdtemp(join(tmpdir(), "rion-updater-macos-finalizer-"));
  const root = await realpath(requestedRoot);
  const childOutputRoot = join(root, "child-output");
  const preparedRoot = join(root, "prepared-input");
  const v22Root = join(root, "tauri-v22-input");
  const lineageRoot = join(root, "lineage");
  await Promise.all([
    mkdir(childOutputRoot),
    mkdir(preparedRoot),
    mkdir(v22Root),
    mkdir(lineageRoot)
  ]);

  const targetArtifact = Buffer.from("production target macOS archive", "utf8");
  const targetSignature = Buffer.from("production target macOS signature", "utf8");
  const companion = Buffer.from("signed Windows companion", "utf8");
  const companionSignature = Buffer.from("Windows companion signature", "utf8");
  const targetManifest = Buffer.from('{"version":"23.4.0"}\n', "utf8");
  const preparedArtifactPath = join(preparedRoot, "Rion.Studio-mac.app.tar.gz");
  const preparedSignaturePath = `${preparedArtifactPath}.sig`;
  const companionPath = join(preparedRoot, "Rion.Studio-win.exe");
  const companionSignaturePath = `${companionPath}.sig`;
  const preparedManifestPath = join(preparedRoot, "latest-darwin.json");
  await Promise.all([
    writeFile(preparedArtifactPath, targetArtifact),
    writeFile(preparedSignaturePath, targetSignature),
    writeFile(companionPath, companion),
    writeFile(companionSignaturePath, companionSignature),
    writeFile(preparedManifestPath, targetManifest)
  ]);
  const preparedReceipt = {
    schemaVersion: 2,
    kind: ELECTRON_UPDATER_PREPARED_INPUT_KIND,
    architecture: "arm64",
    platform: "darwin",
    version: MACOS_TARGET_VERSION,
    artifact: fileIdentity(preparedArtifactPath, targetArtifact),
    artifactSignature: fileIdentity(preparedSignaturePath, targetSignature),
    companion: fileIdentity(companionPath, companion),
    companionSignature: fileIdentity(companionSignaturePath, companionSignature),
    macosPackageVerification: macosPackageVerification(targetArtifact),
    manifest: fileIdentity(preparedManifestPath, targetManifest)
  };
  const preparedReceiptPath = join(
    preparedRoot,
    "prepared-updater-probe-input.json"
  );
  const preparedReceiptSource = serializeCanonicalJson(preparedReceipt);
  await writeFile(preparedReceiptPath, preparedReceiptSource);
  const commandExecutable = Buffer.from("exact macOS node executable\n", "utf8");
  const commandHarness = Buffer.from("exact macOS updater probe harness\n", "utf8");
  const commandExecutablePath = join(root, "node");
  const commandHarnessPath = join(root, "runElectronUpdaterTransactionProbe.mjs");
  await Promise.all([
    writeFile(commandExecutablePath, commandExecutable, { mode: 0o700 }),
    writeFile(commandHarnessPath, commandHarness, { mode: 0o600 })
  ]);

  const v22Artifact = Buffer.from("published Tauri v22 macOS archive", "utf8");
  const v22Signature = Buffer.from("published Tauri v22 macOS signature", "utf8");
  const v22Manifest = Buffer.from('{"version":"22.8.0"}\n', "utf8");
  const v22Checksums = Buffer.from("published Tauri v22 checksums\n", "utf8");
  const v22ArtifactPath = join(v22Root, "Rion.Studio-mac.app.tar.gz");
  const v22SignaturePath = `${v22ArtifactPath}.sig`;
  const v22ManifestPath = join(v22Root, "latest.json");
  const v22ChecksumsPath = join(v22Root, "SHA256SUMS.txt");
  await Promise.all([
    writeFile(v22ArtifactPath, v22Artifact),
    writeFile(v22SignaturePath, v22Signature),
    writeFile(v22ManifestPath, v22Manifest),
    writeFile(v22ChecksumsPath, v22Checksums)
  ]);
  const inputReceipt = {
    schemaVersion: 2,
    evidenceKind: "tauri-v22-published-input",
    runtime: "tauri-v22",
    repository: "rion-tw/rion-studio",
    releaseTag: "v22.8.0",
    releaseVersion: "22.8.0",
    sourceSha: MACOS_SOURCE_SHA,
    targetSha: MACOS_TARGET_SHA,
    updaterPublicKeySha256: MACOS_TRUST_SHA256,
    platform: "darwin-aarch64",
    artifactName: "Rion.Studio-mac.app.tar.gz",
    artifactBytes: v22Artifact.length,
    artifactSha256: sha256(v22Artifact),
    signatureName: "Rion.Studio-mac.app.tar.gz.sig",
    signatureSha256: sha256(v22Signature),
    manifestName: "latest.json",
    manifestSha256: sha256(v22Manifest),
    checksumName: "SHA256SUMS.txt",
    checksumSha256: sha256(v22Checksums)
  } as const;
  const inputReceiptPath = join(v22Root, "verified-input-receipt.json");
  const inputReceiptSource = serializeCanonicalJson(inputReceipt);
  await writeFile(inputReceiptPath, inputReceiptSource);

  const lineageReceipt = createLineageReceipt({
    inputReceiptSource,
    v22Artifact,
    v22Checksums,
    v22Manifest,
    v22Signature
  });
  const lineageReceiptPath = join(
    lineageRoot,
    "tauri-v22-public-lineage-receipt.json"
  );
  const lineageReceiptSource = serializeCanonicalJson(lineageReceipt);
  await writeFile(lineageReceiptPath, lineageReceiptSource);

  const provisionalReceiptPath = join(
    childOutputRoot,
    "provisional-layout-probe-receipt.json"
  );
  await writeElectronUpdaterCompatibilityProvisionalReceipt({
    cases: MACOS_CASES,
    outputPath: provisionalReceiptPath,
    platform: "darwin",
    probeCompletedAt: MACOS_PROBE_COMPLETED_AT
  });
  const capability = await createIsolationCapability(childOutputRoot);
  const isolationResultPath = join(
    childOutputRoot,
    ELECTRON_UPDATER_DARWIN_ISOLATION_RESULT_NAME
  );
  const isolation = await writeElectronUpdaterDarwinProcessIsolationResult({
    attemptNonce: MACOS_ATTEMPT_NONCE,
    cargoProcessGroupId: 91_001,
    cargoProcessGroupOutcome: "active-zero",
    childOutputRoot,
    childSandbox: "seatbelt-v1",
    cleanupVerified: true,
    commandInvocationSha256: MACOS_COMMAND_SHA256,
    completedAt: ISOLATION_COMPLETED_AT,
    helperAttemptId: MACOS_HELPER_ATTEMPT,
    isolationEvidence: capability,
    outputPath: isolationResultPath,
    sandboxProfileSha256: MACOS_SANDBOX_SHA256
  });
  const expected = {
    isolationAttemptNonce: MACOS_ATTEMPT_NONCE,
    isolationCommandExecutablePath: commandExecutablePath,
    isolationCommandExecutableSha256: sha256(commandExecutable),
    isolationCommandHarnessPath: commandHarnessPath,
    isolationCommandHarnessSha256: sha256(commandHarness),
    isolationCommandInvocationSha256: MACOS_COMMAND_SHA256,
    isolationResultSha256: isolation.resultIdentity.sha256,
    preparedInputReceiptSha256: sha256(preparedReceiptSource),
    sandboxProfileSha256: MACOS_SANDBOX_SHA256,
    targetSourceSha: MACOS_TARGET_SHA,
    tauriV22InputReceiptSha256: sha256(inputReceiptSource),
    tauriV22LineageReceiptSha256: sha256(lineageReceiptSource),
    updaterPublicKeySha256: MACOS_TRUST_SHA256
  };
  return {
    childOutputRoot,
    cleanup: () => rm(root, { force: true, recursive: true }),
    commandExecutable,
    commandExecutablePath,
    commandHarness,
    commandHarnessPath,
    expected,
    inputReceiptPath,
    isolation,
    isolationResultPath,
    lineageReceiptPath,
    preparedArtifactPath,
    preparedReceiptPath,
    preparedRoot,
    provisionalReceiptPath,
    root,
    sealedOutputRoot: join(root, "parent-sealed-output"),
    targetArtifact,
    v22Root
  };
}

export function finalizeMacosCompatibilityFixture(
  fixture: Awaited<ReturnType<typeof createMacosCompatibilityFinalizerFixture>>
) {
  return finalizeMacosElectronUpdaterCompatibilityTerminalReceipt({
    childOutputRoot: fixture.childOutputRoot,
    expected: fixture.expected,
    finalizedAt: MACOS_FINALIZED_AT,
    isolationResultPath: fixture.isolationResultPath,
    preparedInput: {
      artifactPath: fixture.preparedArtifactPath,
      fixtureRoot: fixture.preparedRoot,
      receiptPath: fixture.preparedReceiptPath,
      version: MACOS_TARGET_VERSION
    },
    provisionalReceiptPath: fixture.provisionalReceiptPath,
    sealedOutputRoot: fixture.sealedOutputRoot,
    target: {
      priorV23Version: "23.0.0",
      updaterEndpoint: "https://updates.example.test/v23/latest.json",
      version: MACOS_TARGET_VERSION
    },
    tauriV22: {
      assetDirectory: fixture.v22Root,
      inputReceiptPath: fixture.inputReceiptPath,
      lineageReceiptPath: fixture.lineageReceiptPath
    }
  });
}

async function createIsolationCapability(childOutputRoot: string) {
  const applicationPath = join(
    childOutputRoot,
    "transaction",
    "installed",
    "Rion Studio.app"
  );
  const mainExecutablePath = join(
    applicationPath,
    "Contents",
    "MacOS",
    "Rion Studio"
  );
  const inventoryExecutablePath = join(childOutputRoot, "native", "inventory");
  await Promise.all([
    mkdir(join(applicationPath, "Contents", "MacOS"), { recursive: true }),
    mkdir(join(childOutputRoot, "native"), { recursive: true })
  ]);
  await Promise.all([
    writeFile(mainExecutablePath, "target Electron executable\n", { mode: 0o700 }),
    writeFile(inventoryExecutablePath, "process inventory executable\n", { mode: 0o700 })
  ]);
  await Promise.all([
    chmod(mainExecutablePath, 0o700),
    chmod(inventoryExecutablePath, 0o700)
  ]);
  const helper = processRecord(mainExecutablePath);
  const active = new Map([[helper.processUniqueId, helper]]);
  const operations = fakeOperations(active);
  const supervisor = await createElectronUpdaterDarwinProcessSupervisor({
    applicationPath,
    helperProcessId: helper.processId,
    inventoryExecutablePath,
    launchedAfterMilliseconds: LAUNCH_MILLISECONDS,
    platform: "darwin",
    runtimeRoot: childOutputRoot
  }, operations);
  await waitForElectronUpdaterDarwinProcessSupervisorAdmission(supervisor);
  active.clear();
  await terminateElectronUpdaterDarwinProcessSupervisor(supervisor);
  return completeElectronUpdaterDarwinProcessIsolationEvidence(supervisor);
}

function processRecord(executablePath: string): DarwinProcessInventoryRecord {
  const startSeconds = Math.floor(LAUNCH_MILLISECONDS / 1_000);
  return Object.freeze({
    auditToken: "ab".repeat(32),
    executablePath,
    parentProcessId: 1,
    parentProcessUniqueId: "9000",
    processGroupId: 90_001,
    processId: 90_001,
    processUniqueId: "9001",
    startMicroseconds: 0,
    startSeconds,
    userId: process.getuid?.() ?? 501
  });
}

function fakeOperations(
  active: Map<string, DarwinProcessInventoryRecord>
): DarwinPackagedProcessOperations {
  const clock = { now: 100 };
  return {
    epochMilliseconds: () => LAUNCH_MILLISECONDS + 10_000,
    now: () => clock.now,
    readInventory: async () => [...active.values()],
    signalAuditToken: async (_path, auditToken) => {
      const entry = [...active.values()].find(
        (candidate) => candidate.auditToken === auditToken
      );
      if (entry) active.delete(entry.processUniqueId);
    },
    sleep: async (milliseconds) => {
      clock.now += milliseconds;
    }
  };
}

function createLineageReceipt(input: {
  inputReceiptSource: Buffer;
  v22Artifact: Buffer;
  v22Checksums: Buffer;
  v22Manifest: Buffer;
  v22Signature: Buffer;
}) {
  return {
    schemaVersion: 1,
    kind: "rion-tauri-v22-public-source-lineage",
    status: "verified-public-source-lineage",
    cutoverEligible: false,
    runtime: "tauri-v22",
    platform: "darwin-aarch64",
    release: {
      repository: "rion-tw/rion-studio",
      id: "987654321",
      tag: "v22.8.0",
      version: "22.8.0",
      draft: false,
      prerelease: false,
      wasLatestAtCapture: true,
      publishedAt: "2026-08-01T00:00:00.000Z",
      observedAt: "2026-09-01T00:00:00.000Z"
    },
    sourceTag: {
      repository: "rion-tw/rion-studio-source",
      releaseTag: "v22.8.0",
      refObjectType: "commit",
      refObjectSha: MACOS_SOURCE_SHA,
      peeledCommitSha: MACOS_SOURCE_SHA,
      observedAt: "2026-09-01T00:00:01.000Z"
    },
    targetSourceSha: MACOS_TARGET_SHA,
    trust: { updaterPublicKeySha256: MACOS_TRUST_SHA256 },
    verifiedInputReceipt: {
      fileName: "verified-input-receipt.json",
      sha256: sha256(input.inputReceiptSource)
    },
    assets: {
      artifact: lineageAsset("201", "Rion.Studio-mac.app.tar.gz", input.v22Artifact),
      checksums: lineageAsset("204", "SHA256SUMS.txt", input.v22Checksums),
      manifest: lineageAsset("203", "latest.json", input.v22Manifest),
      signature: lineageAsset(
        "202",
        "Rion.Studio-mac.app.tar.gz.sig",
        input.v22Signature
      )
    },
    runningExecutable: {
      derivation: "macos-exact-archive-member",
      relativePath: "Rion Studio.app/Contents/MacOS/rion-tauri",
      fileName: "rion-tauri",
      bytes: 37,
      sha256: sha256("published Tauri v22 executable bytes"),
      derivedFromArtifactSha256: sha256(input.v22Artifact)
    },
    producer: {
      artifactName: "tauri-v22-public-lineage-darwin-aarch64-123456789-1",
      event: "workflow_dispatch",
      headSha: MACOS_TARGET_SHA,
      producedAt: "2026-09-01T00:00:02.000Z",
      repository: "rion-tw/rion-studio-source",
      runAttempt: 1,
      runId: "123456789",
      workflow: ".github/workflows/electron-updater-tauri-v22-compatibility.yml"
    },
    verifiedAt: "2026-09-01T00:00:02.000Z"
  } as const;
}

function lineageAsset(id: string, name: string, source: Buffer) {
  return { bytes: source.length, id, name, sha256: sha256(source) };
}

function fileIdentity(path: string, source: Buffer) {
  return { bytes: source.length, path, sha256: sha256(source) };
}

function macosPackageVerification(artifact: Buffer) {
  return {
    applicationBundle: "Rion Studio.app",
    artifact: {
      bytes: artifact.length,
      fileName: "Rion.Studio-mac.app.tar.gz",
      sha256: sha256(artifact)
    },
    expectedVersion: MACOS_TARGET_VERSION,
    kind: "rion-electron-updater-macos-package-verification",
    packageManifest: {
      directoryCount: 1,
      entryCount: 2,
      regularFileBytes: 42,
      regularFileCount: 1,
      schemaVersion: 1,
      sha256: sha256("prepared macOS package manifest"),
      symlinkCount: 0
    },
    schemaVersion: 1,
    verificationKind: "safe-tar-extraction-production-electron-package-v1"
  } as const;
}

export function sha256(source: string | Buffer) {
  return createHash("sha256").update(source).digest("hex");
}
