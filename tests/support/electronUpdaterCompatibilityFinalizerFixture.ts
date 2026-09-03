import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serializeCanonicalJson } from
  "../../scripts/canonicalJson.mjs";
import {
  ELECTRON_UPDATER_COMPATIBILITY_PROVISIONAL_RECEIPT_NAME,
  finalizeWindowsElectronUpdaterCompatibilityTerminalReceipt,
  writeElectronUpdaterCompatibilityProvisionalReceipt
} from "../../scripts/electronUpdaterCompatibilityReceiptFinalizer.mjs";
import { ELECTRON_UPDATER_PREPARED_INPUT_KIND } from
  "../../scripts/electronUpdaterPreparedProbeInput.mjs";
import {
  WINDOWS_ISOLATED_PROFILE_RESULT_KIND,
  WINDOWS_ISOLATED_PROFILE_RESULT_NAME
} from "../../scripts/windowsIsolatedProfileResultContract.mjs";

export const SOURCE_SHA = "1".repeat(40);
export const TARGET_SHA = "2".repeat(40);
export const TRUST_SHA256 = sha256("production updater public key");
export const COMMAND_SHA256 = sha256("parent command invocation");
export const ATTEMPT_NONCE = "0123456789abcdef0123456789abcdef";
export const PROBE_COMPLETED_AT = "2026-09-01T01:02:03.000Z";
export const FINALIZED_AT = "2026-09-01T01:02:04.000Z";
export const TARGET_VERSION = "23.4.0";

export const WINDOWS_CASES = [
  {
    outcome: "applied",
    probe: "packaged-artifact-manifest-fail-closed",
    sourceRuntime: "electron-v23"
  },
  {
    outcome: "applied",
    probe: "windows-installed-layout-replacement-and-relaunch",
    sourceRuntime: "tauri-v22"
  },
  {
    outcome: "applied",
    probe: "windows-installed-layout-replacement-and-relaunch",
    sourceRuntime: "electron-v23"
  }
] as const;

export async function createCompatibilityFinalizerFixture() {
  const requestedRoot = await mkdtemp(join(tmpdir(), "rion-updater-finalizer-"));
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

  const targetArtifact = Buffer.from("production target NSIS bytes", "utf8");
  const targetSignature = Buffer.from("production target signature", "utf8");
  const companion = Buffer.from("signed macOS companion", "utf8");
  const companionSignature = Buffer.from("macOS companion signature", "utf8");
  const targetManifest = Buffer.from('{"version":"23.4.0"}\n', "utf8");
  const preparedArtifactPath = join(preparedRoot, "Rion.Studio-win.exe");
  const preparedSignaturePath = `${preparedArtifactPath}.sig`;
  const companionPath = join(preparedRoot, "Rion.Studio-mac.app.tar.gz");
  const companionSignaturePath = `${companionPath}.sig`;
  const preparedManifestPath = join(preparedRoot, "latest-win32.json");
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
    architecture: "x64",
    platform: "win32",
    version: TARGET_VERSION,
    artifact: fileIdentity(preparedArtifactPath, targetArtifact),
    artifactSignature: fileIdentity(preparedSignaturePath, targetSignature),
    companion: fileIdentity(companionPath, companion),
    companionSignature: fileIdentity(
      companionSignaturePath,
      companionSignature
    ),
    macosPackageVerification: null,
    manifest: fileIdentity(preparedManifestPath, targetManifest)
  };
  const preparedReceiptPath = join(
    preparedRoot,
    "prepared-updater-probe-input.json"
  );
  const preparedReceiptSource = serializeCanonicalJson(preparedReceipt);
  await writeFile(preparedReceiptPath, preparedReceiptSource);
  const commandExecutable = Buffer.from("exact pnpm command executable\n", "utf8");
  const commandHarness = Buffer.from("exact updater probe harness\n", "utf8");
  const commandExecutablePath = join(root, "pnpm.cmd");
  const commandHarnessPath = join(root, "runElectronUpdaterTransactionProbe.mjs");
  await Promise.all([
    writeFile(commandExecutablePath, commandExecutable),
    writeFile(commandHarnessPath, commandHarness)
  ]);

  const v22Artifact = Buffer.from("published Tauri v22 NSIS bytes", "utf8");
  const v22Signature = Buffer.from("published v22 signature", "utf8");
  const v22Manifest = Buffer.from('{"version":"22.8.0"}\n', "utf8");
  const v22Checksums = Buffer.from("published v22 checksums\n", "utf8");
  const v22ArtifactPath = join(v22Root, "Rion.Studio-win.exe");
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
    sourceSha: SOURCE_SHA,
    targetSha: TARGET_SHA,
    updaterPublicKeySha256: TRUST_SHA256,
    platform: "windows-x86_64",
    artifactName: "Rion.Studio-win.exe",
    artifactBytes: v22Artifact.length,
    artifactSha256: sha256(v22Artifact),
    signatureName: "Rion.Studio-win.exe.sig",
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
    ELECTRON_UPDATER_COMPATIBILITY_PROVISIONAL_RECEIPT_NAME
  );
  await writeElectronUpdaterCompatibilityProvisionalReceipt({
    cases: WINDOWS_CASES,
    outputPath: provisionalReceiptPath,
    platform: "win32",
    probeCompletedAt: PROBE_COMPLETED_AT
  });
  const isolationResult = successfulIsolationResult(
    preparedArtifactPath,
    targetArtifact,
    commandExecutablePath,
    commandExecutable,
    commandHarnessPath,
    commandHarness,
    preparedReceiptSource
  );
  const isolationResultPath = join(root, WINDOWS_ISOLATED_PROFILE_RESULT_NAME);
  await writeFile(
    isolationResultPath,
    serializeCanonicalJson(isolationResult)
  );
  const expected = {
    isolationAttemptNonce: ATTEMPT_NONCE,
    isolationCommandExecutablePath: commandExecutablePath,
    isolationCommandExecutableSha256: sha256(commandExecutable),
    isolationCommandHarnessPath: commandHarnessPath,
    isolationCommandHarnessSha256: sha256(commandHarness),
    isolationCommandInvocationSha256: COMMAND_SHA256,
    preparedInputReceiptSha256: sha256(preparedReceiptSource),
    targetSourceSha: TARGET_SHA,
    tauriV22InputReceiptSha256: sha256(inputReceiptSource),
    tauriV22LineageReceiptSha256: sha256(lineageReceiptSource),
    updaterPublicKeySha256: TRUST_SHA256
  };
  return {
    root,
    childOutputRoot,
    commandExecutablePath,
    commandHarnessPath,
    expected,
    inputReceiptPath,
    isolationResult,
    isolationResultPath,
    lineageReceiptPath,
    preparedArtifactPath,
    preparedReceiptPath,
    preparedRoot,
    provisionalReceiptPath,
    sealedOutputRoot: join(root, "parent-sealed-output"),
    targetArtifact,
    v22Root,
    cleanup: () => rm(root, { force: true, recursive: true })
  };
}

export function finalizeCompatibilityFixture(
  fixture: Awaited<ReturnType<typeof createCompatibilityFinalizerFixture>>
) {
  return finalizeWindowsElectronUpdaterCompatibilityTerminalReceipt({
    childOutputRoot: fixture.childOutputRoot,
    expected: fixture.expected,
    finalizedAt: FINALIZED_AT,
    isolationResultPath: fixture.isolationResultPath,
    preparedInput: {
      artifactPath: fixture.preparedArtifactPath,
      fixtureRoot: fixture.preparedRoot,
      receiptPath: fixture.preparedReceiptPath,
      version: TARGET_VERSION
    },
    provisionalReceiptPath: fixture.provisionalReceiptPath,
    sealedOutputRoot: fixture.sealedOutputRoot,
    target: {
      priorV23Version: "23.0.0",
      updaterEndpoint: "https://updates.example.test/v23/latest.json",
      version: TARGET_VERSION
    },
    tauriV22: {
      assetDirectory: fixture.v22Root,
      inputReceiptPath: fixture.inputReceiptPath,
      lineageReceiptPath: fixture.lineageReceiptPath
    }
  });
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
    platform: "windows-x86_64",
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
      refObjectSha: SOURCE_SHA,
      peeledCommitSha: SOURCE_SHA,
      observedAt: "2026-09-01T00:00:01.000Z"
    },
    targetSourceSha: TARGET_SHA,
    trust: { updaterPublicKeySha256: TRUST_SHA256 },
    verifiedInputReceipt: {
      fileName: "verified-input-receipt.json",
      sha256: sha256(input.inputReceiptSource)
    },
    assets: {
      artifact: lineageAsset("101", "Rion.Studio-win.exe", input.v22Artifact),
      checksums: lineageAsset("104", "SHA256SUMS.txt", input.v22Checksums),
      manifest: lineageAsset("103", "latest.json", input.v22Manifest),
      signature: lineageAsset(
        "102",
        "Rion.Studio-win.exe.sig",
        input.v22Signature
      )
    },
    runningExecutable: {
      derivation: "windows-isolated-current-user-nsis-install",
      relativePath: "rion-tauri.exe",
      fileName: "rion-tauri.exe",
      bytes: 31,
      sha256: sha256("published v22 executable bytes"),
      derivedFromArtifactSha256: sha256(input.v22Artifact)
    },
    producer: {
      artifactName:
        "tauri-v22-public-lineage-windows-x86_64-123456789-1",
      event: "workflow_dispatch",
      headSha: TARGET_SHA,
      producedAt: "2026-09-01T00:00:02.000Z",
      repository: "rion-tw/rion-studio-source",
      runAttempt: 1,
      runId: "123456789",
      workflow:
        ".github/workflows/electron-updater-tauri-v22-compatibility.yml"
    },
    verifiedAt: "2026-09-01T00:00:02.000Z"
  } as const;
}

function successfulIsolationResult(
  preparedArtifactPath: string,
  targetArtifact: Buffer,
  commandExecutablePath: string,
  commandExecutable: Buffer,
  commandHarnessPath: string,
  commandHarness: Buffer,
  preparedReceiptSource: Buffer
) {
  return {
    activeProcessesAfterRootExit: 0,
    attemptNonce: ATTEMPT_NONCE,
    attestedInputs: {
      commandExecutable: isolatedIdentity(
        commandExecutablePath.split(/[\\/]/u).at(-1)!,
        commandExecutable
      ),
      commandHarness: isolatedIdentity(
        commandHarnessPath.split(/[\\/]/u).at(-1)!,
        commandHarness
      ),
      forbiddenSourceList: isolatedIdentity(
        "prepared-updater-probe-input.json",
        preparedReceiptSource
      ),
      installer: {
        bytes: targetArtifact.length,
        fileName: preparedArtifactPath.split(/[\\/]/u).at(-1)!,
        sha256: sha256(targetArtifact)
      }
    },
    cleanupVerified: true,
    commandExitCode: 0,
    commandInvocationSha256: COMMAND_SHA256,
    expectedTotalProcesses: 3,
    isolationKind: "temporary-local-windows-user-profile-v1",
    kind: WINDOWS_ISOLATED_PROFILE_RESULT_KIND,
    schemaVersion: 1,
    totalProcesses: 3
  } as const;
}

function isolatedIdentity(fileName: string, source: string | Buffer) {
  return { bytes: Buffer.byteLength(source), fileName, sha256: sha256(source) };
}

function lineageAsset(id: string, name: string, source: Buffer) {
  return { bytes: source.length, id, name, sha256: sha256(source) };
}

function fileIdentity(path: string, source: Buffer) {
  return { bytes: source.length, path, sha256: sha256(source) };
}

export function sha256(source: string | Buffer) {
  return createHash("sha256").update(source).digest("hex");
}
