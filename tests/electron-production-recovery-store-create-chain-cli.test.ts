import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { serializeCanonicalJson } from "../scripts/canonicalJson.mjs";
import {
  acquireElectronProductionPublicLatestLease
} from "../scripts/electronProductionPublicLatestLease.mjs";
import {
  ELECTRON_PRODUCTION_PUBLIC_RELEASE_ASSET_NAMES,
  assertElectronProductionPublicLatestSnapshot,
  deriveElectronProductionExpectedLatestState
} from "../scripts/electronProductionPublicLatestSnapshot.mjs";
import {
  createElectronProductionPublicationRecoveryStoreSeal,
  writeElectronProductionPublicationRecoveryStoreSeal
} from "../scripts/electronProductionPublicationRecovery.mjs";
import {
  createElectronProductionPublicationIntent
} from "../scripts/electronProductionPublicationReceipt.mjs";
import {
  ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PACKAGE_NAME
} from "../scripts/electronProductionRecoveryCapsule.mjs";
import {
  ELECTRON_PRODUCTION_RECOVERY_STORE_CREATE_CHAIN_VERIFICATION_KIND,
  runElectronProductionRecoveryStoreCreateChainCli
} from "../scripts/electronProductionRecoveryStoreCreateChainCli.mjs";
import {
  ELECTRON_PRODUCTION_RECOVERY_STORE_READBACK_FOUNDATION_KIND,
  runElectronProductionRecoveryStoreReadbackFoundationCli
} from "../scripts/electronProductionRecoveryStoreReadbackFoundationCli.mjs";
import {
  ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_OPERATION_RECEIPT_FILE,
  ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_READ_OPERATION_RECEIPT_FILE,
  createElectronProductionRecoveryStoreRemoteOperationReceipt,
  createElectronProductionRecoveryStoreRemoteReadOperationReceipt,
  createElectronProductionRecoveryStoreRemoteReadRequest,
  createElectronProductionRecoveryStoreRemoteRequest,
  writeElectronProductionRecoveryStoreRemoteOperationReceipt,
  writeElectronProductionRecoveryStoreRemoteReadOperationReceipt
} from "../scripts/electronProductionRecoveryStoreRemoteOperation.mjs";
import {
  electronProductionRecoveryStoreTransactionPaths
} from "../scripts/electronProductionRecoveryStoreTransactionPaths.mjs";

const RECOVERY_FIXTURE_TRANSACTION_ID =
  "018f47a0-2d3e-7abc-8def-1234567890ab";
const LEASE_ID = "018f47a0-2d3e-7abc-8def-1234567890ac";
const PUBLIC_BASE =
  "https://github.com/rion-tw/rion-studio/releases/latest/download/";
const OWNER = "alternate-owner";
const REPO = "recovery-vault";
const REF = "recovery-capsules";
const CAPSULE_PARENT = "7".repeat(40);
const CAPSULE_COMMIT = "4".repeat(40);
const CAPSULE_TREE = "6".repeat(40);
const SEAL_COMMIT = "9".repeat(40);
const SEAL_TREE = "8".repeat(40);
const SECRET_TOKEN = "ghp_create_chain_must_not_appear";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("Electron production recovery-store create-chain CLI", () => {
  it("verifies two exact create requests and emits one canonical redacted chain", async () => {
    const fixture = await createChainFixture();
    const outputs: Buffer[] = [];

    const summary = await runElectronProductionRecoveryStoreCreateChainCli(
      createChainArguments(fixture),
      {
        writeStdout: (source) => {
          outputs.push(Buffer.from(source));
        }
      }
    );

    expect(summary).toMatchObject({
      schemaVersion: 1,
      kind: ELECTRON_PRODUCTION_RECOVERY_STORE_CREATE_CHAIN_VERIFICATION_KIND,
      status: "verified",
      transactionId: RECOVERY_FIXTURE_TRANSACTION_ID,
      target: {
        repository: `${OWNER}/${REPO}`,
        ref: REF,
        repositoryPolicy: { defaultBranch: REF, visibility: "private" }
      },
      paths: fixture.transactionPaths,
      capsule: {
        file: {
          fileName: ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PACKAGE_NAME,
          byteLength: fixture.capsuleSource.length,
          sha256: sha256(fixture.capsuleSource)
        },
        operationReceiptSha256: fixture.capsuleOperationSha256,
        applied: {
          parentCommitSha: CAPSULE_PARENT,
          commitSha: CAPSULE_COMMIT,
          treeSha: CAPSULE_TREE,
          blobSha: gitBlobSha(fixture.capsuleSource),
          byteLength: fixture.capsuleSource.length
        }
      },
      storeSeal: {
        operationReceiptSha256: fixture.sealOperationSha256,
        applied: {
          parentCommitSha: CAPSULE_COMMIT,
          commitSha: SEAL_COMMIT,
          treeSha: SEAL_TREE
        }
      }
    });
    expect(outputs).toEqual([serializeCanonicalJson(summary)]);
    const emitted = outputs[0]?.toString("utf8") ?? "";
    expect(emitted).not.toContain(fixture.root);
    expect(emitted).not.toContain(fixture.capsuleSource.toString("base64"));
    expect(emitted).not.toContain(SECRET_TOKEN);
    expect(emitted).not.toContain("contentBase64");
    expect(Object.isFrozen(summary)).toBe(true);
  });

  it("rejects capsule byte and fixed transaction-path tampering", async () => {
    const changedBytes = await createChainFixture();
    await writeFile(changedBytes.capsulePath, "changed canonical bytes\n");
    await expect(runElectronProductionRecoveryStoreCreateChainCli(
      createChainArguments(changedBytes),
      { writeStdout: () => undefined }
    )).rejects.toThrow("capsule applied blob SHA does not match");

    const foreignPath = await createChainFixture({
      capsuleTargetPath:
        `transactions/${RECOVERY_FIXTURE_TRANSACTION_ID}/foreign/` +
        ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PACKAGE_NAME
    });
    await expect(runElectronProductionRecoveryStoreCreateChainCli(
      createChainArguments(foreignPath),
      { writeStdout: () => undefined }
    )).rejects.toThrow("request identity does not match");
  });

  it("rejects a seal operation that does not extend the capsule commit", async () => {
    const fixture = await createChainFixture({ sealParentSha: "a".repeat(40) });

    await expect(runElectronProductionRecoveryStoreCreateChainCli(
      createChainArguments(fixture),
      { writeStdout: () => undefined }
    )).rejects.toThrow("request identity does not match");
  });

  it("recomputes applied Git blob identities from the exact local bytes", async () => {
    const capsuleBlobTamper = await createChainFixture({
      durableBlobSha: "b".repeat(40)
    });
    await expect(runElectronProductionRecoveryStoreCreateChainCli(
      createChainArguments(capsuleBlobTamper),
      { writeStdout: () => undefined }
    )).rejects.toThrow("capsule applied blob SHA does not match");

    const sealBlobTamper = await createChainFixture({
      sealBlobSha: "c".repeat(40)
    });
    await expect(runElectronProductionRecoveryStoreCreateChainCli(
      createChainArguments(sealBlobTamper),
      { writeStdout: () => undefined }
    )).rejects.toThrow("seal applied blob SHA does not match");
  });

  it("rejects operation receipt digest and store-seal durable binding tampering", async () => {
    const digestTamper = await createChainFixture();
    await expect(runElectronProductionRecoveryStoreCreateChainCli(
      replaceOption(
        createChainArguments(digestTamper),
        "capsule-operation-sha256",
        "f".repeat(64)
      ),
      { writeStdout: () => undefined }
    )).rejects.toThrow("SHA-256 does not match");

    const repositoryTamper = await createChainFixture({
      durableRepository: "foreign-owner/foreign-repo"
    });
    await expect(runElectronProductionRecoveryStoreCreateChainCli(
      createChainArguments(repositoryTamper),
      { writeStdout: () => undefined }
    )).rejects.toThrow("store-seal repository does not match");
  });

  it("has no token or remote dependency surface and validates strict syntax", async () => {
    const fixture = await createChainFixture();
    await expect(runElectronProductionRecoveryStoreCreateChainCli([
      ...createChainArguments(fixture),
      "--token", SECRET_TOKEN
    ])).rejects.toThrow("Unknown verify-create-chain option --token");
    await expect(runElectronProductionRecoveryStoreCreateChainCli(
      createChainArguments(fixture),
      { fetchImpl: () => Promise.reject(new Error(SECRET_TOKEN)) } as never
    )).rejects.toThrow("unexpected schema");
  });
});

describe("Electron production recovery-store readback-foundation CLI", () => {
  it("verifies coherent current readback without historical create artifacts", async () => {
    const fixture = await createReadbackFixture();
    await Promise.all([
      rm(fixture.capsuleOperationPath),
      rm(fixture.sealOperationPath)
    ]);
    const outputs: Buffer[] = [];

    const summary =
      await runElectronProductionRecoveryStoreReadbackFoundationCli(
        readbackArguments(fixture),
        {
          writeStdout: (source) => {
            outputs.push(Buffer.from(source));
          }
        }
      );

    expect(summary).toMatchObject({
      schemaVersion: 1,
      kind: ELECTRON_PRODUCTION_RECOVERY_STORE_READBACK_FOUNDATION_KIND,
      status: "verified-current-readback",
      transactionId: RECOVERY_FIXTURE_TRANSACTION_ID,
      target: {
        repository: `${OWNER}/${REPO}`,
        ref: REF,
        repositoryPolicy: { defaultBranch: REF, visibility: "private" }
      },
      currentObservation: {
        headCommitSha: SEAL_COMMIT,
        treeSha: SEAL_TREE,
        parentCommitShas: [CAPSULE_COMMIT]
      },
      capsule: {
        file: {
          byteLength: fixture.capsuleSource.length,
          sha256: sha256(fixture.capsuleSource)
        },
        blobSha: gitBlobSha(fixture.capsuleSource),
        readReceiptSha256: fixture.capsuleReadSha256
      },
      storeSeal: {
        blobSha: gitBlobSha(fixture.sealSource),
        readReceiptSha256: fixture.sealReadSha256
      },
      historicalCapsuleCreate: {
        authority: "seal-recorded-not-reproved",
        parentCommitSha: CAPSULE_PARENT,
        commitSha: CAPSULE_COMMIT,
        treeSha: CAPSULE_TREE,
        operationReceiptSha256: fixture.capsuleOperationSha256
      }
    });
    expect(outputs).toEqual([serializeCanonicalJson(summary)]);
    const emitted = outputs[0]?.toString("utf8") ?? "";
    expect(emitted).not.toContain(fixture.root);
    expect(emitted).not.toContain(fixture.capsuleSource.toString("base64"));
    expect(emitted).not.toContain(fixture.sealSource.toString("base64"));
    expect(emitted).not.toContain("contentBase64");
  });

  it("rejects incoherent heads and local content tampering", async () => {
    const headMismatch = await createReadbackFixture({
      sealHeadSha: "a".repeat(40)
    });
    await expect(runElectronProductionRecoveryStoreReadbackFoundationCli(
      readbackArguments(headMismatch),
      { writeStdout: () => undefined }
    )).rejects.toThrow("readback head commit does not match");

    const contentMismatch = await createReadbackFixture();
    await writeFile(contentMismatch.capsulePath, "changed readback bytes\n");
    await expect(runElectronProductionRecoveryStoreReadbackFoundationCli(
      readbackArguments(contentMismatch),
      { writeStdout: () => undefined }
    )).rejects.toThrow("capsule readback byte length does not match");
  });

  it("rejects a seal-recorded capsule blob that current readback does not prove", async () => {
    const fixture = await createReadbackFixture({
      durableBlobSha: "b".repeat(40)
    });

    await expect(runElectronProductionRecoveryStoreReadbackFoundationCli(
      readbackArguments(fixture),
      { writeStdout: () => undefined }
    )).rejects.toThrow("stored blob SHA does not match");
  });

  it("recomputes current readback Git blob identities from local bytes", async () => {
    const capsuleBlobTamper = await createReadbackFixture({
      capsuleReadBlobSha: "b".repeat(40)
    });
    await expect(runElectronProductionRecoveryStoreReadbackFoundationCli(
      readbackArguments(capsuleBlobTamper),
      { writeStdout: () => undefined }
    )).rejects.toThrow("capsule readback blob SHA does not match");

    const sealBlobTamper = await createReadbackFixture({
      sealReadBlobSha: "c".repeat(40)
    });
    await expect(runElectronProductionRecoveryStoreReadbackFoundationCli(
      readbackArguments(sealBlobTamper),
      { writeStdout: () => undefined }
    )).rejects.toThrow("seal readback blob SHA does not match");
  });

  it("rejects read receipt digest tampering and exposes no token option", async () => {
    const fixture = await createReadbackFixture();
    await expect(runElectronProductionRecoveryStoreReadbackFoundationCli(
      replaceOption(
        readbackArguments(fixture),
        "capsule-read-operation-sha256",
        "f".repeat(64)
      ),
      { writeStdout: () => undefined }
    )).rejects.toThrow("SHA-256 does not match");
    await expect(runElectronProductionRecoveryStoreReadbackFoundationCli([
      ...readbackArguments(fixture),
      "--token", SECRET_TOKEN
    ])).rejects.toThrow("Unknown verify-readback-foundation option --token");
  });
});

interface ChainFixture {
  readonly capsuleOperationPath: string;
  readonly capsuleOperationSha256: string;
  readonly capsulePath: string;
  readonly capsuleSource: Buffer;
  readonly root: string;
  readonly sealSource: Buffer;
  readonly sealOperationPath: string;
  readonly sealOperationSha256: string;
  readonly storeSealPath: string;
  readonly transactionPaths: Readonly<{
    capsule: string;
    storeSeal: string;
  }>;
}

async function createChainFixture(options: Readonly<{
  capsuleTargetPath?: string;
  durableBlobSha?: string;
  durableRepository?: string;
  sealBlobSha?: string;
  sealParentSha?: string;
}> = {}): Promise<ChainFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "rion-create-chain-cli-"));
  temporaryDirectories.push(root);
  const paths = electronProductionRecoveryStoreTransactionPaths({
    transactionId: RECOVERY_FIXTURE_TRANSACTION_ID
  });
  const capsuleSource = serializeCanonicalJson({
    schemaVersion: 1,
    kind: "test-recovery-capsule",
    transactionId: RECOVERY_FIXTURE_TRANSACTION_ID,
    payload: "bounded canonical fixture"
  });
  const capsulePath = path.join(
    root,
    ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PACKAGE_NAME
  );
  await writeFile(capsulePath, capsuleSource, { flag: "wx", mode: 0o600 });
  const remoteTarget = (storePath: string) => ({
    owner: OWNER,
    repo: REPO,
    ref: REF,
    path: storePath,
    repositoryPolicy: { defaultBranch: REF, visibility: "private" as const }
  });
  const capsuleRequest = createElectronProductionRecoveryStoreRemoteRequest({
    expectedHeadSha: CAPSULE_PARENT,
    packageIdentity: {
      fileName: ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PACKAGE_NAME,
      byteLength: capsuleSource.length,
      sha256: sha256(capsuleSource)
    },
    target: remoteTarget(options.capsuleTargetPath ?? paths.capsulePath)
  });
  const capsuleReceipt = createElectronProductionRecoveryStoreRemoteOperationReceipt({
    request: capsuleRequest,
    result: {
      outcome: "applied",
      blobSha: options.durableBlobSha ?? gitBlobSha(capsuleSource),
      byteLength: capsuleSource.length,
      commitSha: CAPSULE_COMMIT,
      parentSha: CAPSULE_PARENT,
      treeSha: CAPSULE_TREE
    }
  });
  const capsuleOperationDirectory = path.join(root, "capsule-operation");
  const sealOperationDirectory = path.join(root, "seal-operation");
  await Promise.all([
    mkdir(capsuleOperationDirectory, { mode: 0o700 }),
    mkdir(sealOperationDirectory, { mode: 0o700 })
  ]);
  const capsuleOperationPath = path.join(
    capsuleOperationDirectory,
    ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_OPERATION_RECEIPT_FILE
  );
  const capsuleOperation =
    await writeElectronProductionRecoveryStoreRemoteOperationReceipt({
      outputPath: capsuleOperationPath,
      receipt: capsuleReceipt
    });
  const sourceSnapshot = makeObservedSnapshot({
    candidate: null,
    idBase: 100,
    isLatest: true,
    version: "8.4.2"
  });
  const stagedTarget = makeObservedSnapshot({
    candidate: candidateSummary("8.6.0"),
    idBase: 200,
    isLatest: false,
    version: "8.6.0"
  });
  const targetSnapshot = deriveElectronProductionExpectedLatestState(stagedTarget);
  if (!targetSnapshot.candidateReceipt) {
    throw new Error("Expected target candidate fixture.");
  }
  const heldLease = acquireElectronProductionPublicLatestLease({
    holder: {
      repository: "rion-tw/rion-studio-source",
      workflow: ".github/workflows/electron-production-provisional-publish.yml",
      runId: "7001",
      runAttempt: 2,
      headSha: "2".repeat(40)
    },
    leaseId: LEASE_ID,
    previous: null,
    purpose: "electron-v23-provisional-publication",
    recordedAt: "2026-09-01T00:00:00Z",
    source: {
      runtime: "tauri-v22",
      version: sourceSnapshot.latestJson.version,
      stateSha256: sourceSnapshot.stateSha256
    },
    target: {
      runtime: "electron-v23",
      version: targetSnapshot.latestJson.version,
      stateSha256: targetSnapshot.stateSha256
    },
    transactionId: RECOVERY_FIXTURE_TRANSACTION_ID,
    vacantGeneration: 0
  });
  const publicationIntent = createElectronProductionPublicationIntent({
    transactionId: RECOVERY_FIXTURE_TRANSACTION_ID,
    recordedAt: "2026-09-01T00:00:00Z",
    lease: {
      id: heldLease.leaseId,
      generation: heldLease.generation
    },
    baseline: {
      runtime: "tauri-v22",
      version: sourceSnapshot.latestJson.version,
      releaseTag: sourceSnapshot.release.tag,
      sourceSha: sourceSnapshot.release.targetCommitish,
      manifestSha256: sourceSnapshot.latestJson.sha256,
      stateSha256: sourceSnapshot.stateSha256
    },
    target: {
      runtime: "electron-v23",
      version: targetSnapshot.latestJson.version,
      releaseTag: targetSnapshot.release.tag,
      sourceSha: targetSnapshot.candidateReceipt.sourceSha,
      candidateReceiptSha256: targetSnapshot.candidateReceipt.sha256,
      manifestSha256: targetSnapshot.latestJson.sha256,
      stateSha256: targetSnapshot.stateSha256
    }
  });
  const storeSeal = createElectronProductionPublicationRecoveryStoreSeal({
    capsuleBytes: capsuleSource.length,
    capsuleSha256: sha256(capsuleSource),
    capsuleManifestBytes: 1,
    capsuleManifestSha256: sha256(Buffer.from("manifest", "utf8")),
    durableStore: {
      repository: options.durableRepository ?? `${OWNER}/${REPO}`,
      ref: REF,
      path: paths.capsulePath,
      repositoryPolicy: { defaultBranch: REF, visibility: "private" },
      byteLength: capsuleSource.length,
      blobSha: options.durableBlobSha ?? gitBlobSha(capsuleSource),
      treeSha: CAPSULE_TREE,
      parentCommitSha: CAPSULE_PARENT,
      commitSha: CAPSULE_COMMIT,
      remoteReceiptSha256: capsuleOperation.receiptIdentity.sha256,
      committedAt: "2026-09-01T00:01:00Z"
    },
    heldLease,
    publicationIntent,
    sealedAt: "2026-09-01T00:02:00Z",
    sourceSnapshot,
    targetSnapshot,
    writer: {
      repository: "rion-tw/rion-studio-source",
      workflow: ".github/workflows/electron-production-provisional-publish.yml",
      runId: "8001",
      runAttempt: 1,
      controlSha: "2".repeat(40)
    }
  });
  const storeSealPath = path.join(
    root,
    "electron-production-publication-recovery-store-seal.json"
  );
  const storeSealFile = await writeElectronProductionPublicationRecoveryStoreSeal({
    outputPath: storeSealPath,
    receipt: storeSeal
  });
  const sealSource = await readFile(storeSealPath);
  const sealParentSha = options.sealParentSha ?? CAPSULE_COMMIT;
  const sealRequest = createElectronProductionRecoveryStoreRemoteRequest({
    expectedHeadSha: sealParentSha,
    packageIdentity: {
      fileName: storeSealFile.receiptIdentity.fileName,
      byteLength: storeSealFile.receiptIdentity.bytes,
      sha256: storeSealFile.receiptIdentity.sha256
    },
    target: remoteTarget(paths.storeSealPath)
  });
  const sealReceipt = createElectronProductionRecoveryStoreRemoteOperationReceipt({
    request: sealRequest,
    result: {
      outcome: "applied",
      blobSha: options.sealBlobSha ?? gitBlobSha(sealSource),
      byteLength: sealSource.length,
      commitSha: SEAL_COMMIT,
      parentSha: sealParentSha,
      treeSha: SEAL_TREE
    }
  });
  const sealOperationPath = path.join(
    sealOperationDirectory,
    ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_OPERATION_RECEIPT_FILE
  );
  const sealOperation =
    await writeElectronProductionRecoveryStoreRemoteOperationReceipt({
      outputPath: sealOperationPath,
      receipt: sealReceipt
    });
  return {
    capsuleOperationPath,
    capsuleOperationSha256: capsuleOperation.receiptIdentity.sha256,
    capsulePath,
    capsuleSource,
    root,
    sealSource,
    sealOperationPath,
    sealOperationSha256: sealOperation.receiptIdentity.sha256,
    storeSealPath,
    transactionPaths: {
      capsule: paths.capsulePath,
      storeSeal: paths.storeSealPath
    }
  };
}

interface ReadbackFixture extends ChainFixture {
  readonly capsuleReadPath: string;
  readonly capsuleReadSha256: string;
  readonly sealReadPath: string;
  readonly sealReadSha256: string;
}

async function createReadbackFixture(options: Readonly<{
  capsuleReadBlobSha?: string;
  durableBlobSha?: string;
  sealReadBlobSha?: string;
  sealHeadSha?: string;
}> = {}): Promise<ReadbackFixture> {
  const fixture = await createChainFixture({
    durableBlobSha: options.durableBlobSha
  });
  const remoteTarget = (storePath: string) => ({
    owner: OWNER,
    repo: REPO,
    ref: REF,
    path: storePath,
    repositoryPolicy: { defaultBranch: REF, visibility: "private" as const }
  });
  const readReceipt = (input: Readonly<{
    blobSha?: string;
    content: Buffer;
    headSha: string;
    path: string;
  }>) => {
    const request = createElectronProductionRecoveryStoreRemoteReadRequest({
      expectedContent: { byteLength: null, sha256: null },
      target: remoteTarget(input.path)
    });
    const receipt = createElectronProductionRecoveryStoreRemoteReadOperationReceipt({
      content: input.content,
      request,
      result: {
        outcome: "present",
        blobSha: gitBlobSha(input.content),
        byteLength: input.content.length,
        commitMessage: "current private recovery-store head",
        contentBase64: input.content.toString("base64"),
        headSha: input.headSha,
        parentShas: [CAPSULE_COMMIT],
        treeSha: SEAL_TREE
      }
    });
    if (input.blobSha === undefined || receipt.observed === null) return receipt;
    return {
      ...receipt,
      observed: { ...receipt.observed, blobSha: input.blobSha }
    };
  };
  const capsuleReadDirectory = path.join(fixture.root, "capsule-read");
  const sealReadDirectory = path.join(fixture.root, "seal-read");
  await Promise.all([
    mkdir(capsuleReadDirectory, { mode: 0o700 }),
    mkdir(sealReadDirectory, { mode: 0o700 })
  ]);
  const capsuleReadPath = path.join(
    capsuleReadDirectory,
    ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_READ_OPERATION_RECEIPT_FILE
  );
  const sealReadPath = path.join(
    sealReadDirectory,
    ELECTRON_PRODUCTION_RECOVERY_STORE_REMOTE_READ_OPERATION_RECEIPT_FILE
  );
  const [capsuleRead, sealRead] = await Promise.all([
    writeElectronProductionRecoveryStoreRemoteReadOperationReceipt({
      outputPath: capsuleReadPath,
      receipt: readReceipt({
        blobSha: options.capsuleReadBlobSha,
        content: fixture.capsuleSource,
        headSha: SEAL_COMMIT,
        path: fixture.transactionPaths.capsule
      })
    }),
    writeElectronProductionRecoveryStoreRemoteReadOperationReceipt({
      outputPath: sealReadPath,
      receipt: readReceipt({
        blobSha: options.sealReadBlobSha,
        content: fixture.sealSource,
        headSha: options.sealHeadSha ?? SEAL_COMMIT,
        path: fixture.transactionPaths.storeSeal
      })
    })
  ]);
  return {
    ...fixture,
    capsuleReadPath,
    capsuleReadSha256: capsuleRead.receiptIdentity.sha256,
    sealReadPath,
    sealReadSha256: sealRead.receiptIdentity.sha256
  };
}

function createChainArguments(fixture: ChainFixture) {
  return [
    "verify-create-chain",
    "--transaction-id", RECOVERY_FIXTURE_TRANSACTION_ID,
    "--owner", OWNER,
    "--repo", REPO,
    "--ref", REF,
    "--capsule", fixture.capsulePath,
    "--capsule-operation", fixture.capsuleOperationPath,
    "--capsule-operation-sha256", fixture.capsuleOperationSha256,
    "--store-seal", fixture.storeSealPath,
    "--seal-operation", fixture.sealOperationPath,
    "--seal-operation-sha256", fixture.sealOperationSha256
  ];
}

function readbackArguments(fixture: ReadbackFixture) {
  return [
    "verify-readback-foundation",
    "--transaction-id", RECOVERY_FIXTURE_TRANSACTION_ID,
    "--owner", OWNER,
    "--repo", REPO,
    "--ref", REF,
    "--capsule", fixture.capsulePath,
    "--capsule-read-operation", fixture.capsuleReadPath,
    "--capsule-read-operation-sha256", fixture.capsuleReadSha256,
    "--store-seal", fixture.storeSealPath,
    "--seal-read-operation", fixture.sealReadPath,
    "--seal-read-operation-sha256", fixture.sealReadSha256
  ];
}

function makeObservedSnapshot(input: Readonly<{
  candidate: ReturnType<typeof candidateSummary> | null;
  idBase: number;
  isLatest: boolean;
  version: string;
}>) {
  const tag = `v${input.version}`;
  const digests = Object.fromEntries(
    ELECTRON_PRODUCTION_PUBLIC_RELEASE_ASSET_NAMES.map((name) => [
      name,
      sha256(`${input.version}:${name}`)
    ])
  );
  const assets = ELECTRON_PRODUCTION_PUBLIC_RELEASE_ASSET_NAMES.map(
    (name, index) => ({
      bytes: 100 + index,
      contentType: contentType(name),
      digest: `sha256:${digests[name]}`,
      id: String(input.idBase + index),
      name,
      url: `https://github.com/rion-tw/rion-studio/releases/download/` +
        `${tag}/${encodeURIComponent(name)}`
    })
  );
  const updaterBaseUrl = input.candidate?.updaterBaseUrl ??
    "https://updates.example.test/v22/";
  const state = {
    schemaVersion: 1,
    kind: "rion-electron-production-public-latest-snapshot",
    repository: "rion-tw/rion-studio",
    release: {
      draft: false,
      id: String(input.idBase * 10),
      isLatest: input.isLatest,
      prerelease: false,
      tag,
      targetCommitish: input.idBase.toString(16).padStart(40, "0")
    },
    assets,
    latestJson: {
      bytes: assets.find((asset) => asset.name === "latest.json")?.bytes,
      platforms: {
        "darwin-aarch64": {
          artifactName: "Rion.Studio-mac.app.tar.gz",
          artifactSha256: digests["Rion.Studio-mac.app.tar.gz"],
          signatureFileName: "Rion.Studio-mac.app.tar.gz.sig",
          signatureFileSha256: digests["Rion.Studio-mac.app.tar.gz.sig"],
          url: `${updaterBaseUrl}Rion.Studio-mac.app.tar.gz`
        },
        "windows-x86_64": {
          artifactName: "Rion.Studio-win.exe",
          artifactSha256: digests["Rion.Studio-win.exe"],
          signatureFileName: "Rion.Studio-win.exe.sig",
          signatureFileSha256: digests["Rion.Studio-win.exe.sig"],
          url: `${updaterBaseUrl}Rion.Studio-win.exe`
        }
      },
      publishedAt: "2026-09-01T00:00:00Z",
      sha256: digests["latest.json"],
      version: input.version
    },
    candidateReceipt: input.candidate === null ? null : {
      ...input.candidate,
      assets: digests,
      version: input.version
    }
  };
  const stateSha256 = sha256(serializeCanonicalJson(state));
  const body = { ...state, observationKind: "observed-release", stateSha256 };
  return assertElectronProductionPublicLatestSnapshot({
    ...body,
    snapshotSha256: sha256(serializeCanonicalJson(body))
  });
}

function candidateSummary(version: string) {
  return {
    assets: {} as Record<string, string>,
    bytes: 512,
    fileName: "electron-production-candidate-receipt.json" as const,
    publicKeySha256: "b".repeat(64),
    sha256: sha256(`candidate:${version}`),
    sourceSha: "a".repeat(40),
    updaterBaseUrl: PUBLIC_BASE,
    updaterEndpoint: `${PUBLIC_BASE}latest.json`,
    version
  };
}

function contentType(name: string) {
  if (name.endsWith(".sig") || name.endsWith(".txt")) return "text/plain";
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".dmg")) return "application/x-apple-diskimage";
  if (name.endsWith(".tar.gz")) return "application/gzip";
  return "application/vnd.microsoft.portable-executable";
}

function replaceOption(argumentsList: string[], name: string, value: string) {
  const copy = [...argumentsList];
  const index = copy.indexOf(`--${name}`);
  if (index < 0) throw new Error(`Missing fixture option --${name}.`);
  copy[index + 1] = value;
  return copy;
}

function sha256(source: string | Buffer) {
  return createHash("sha256").update(source).digest("hex");
}

function gitBlobSha(source: Buffer) {
  return createHash("sha1")
    .update(`blob ${source.length}\0`)
    .update(source)
    .digest("hex");
}
