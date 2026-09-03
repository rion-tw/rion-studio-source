import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import {
  electronProductionPublicLatestLeaseEventSha256,
  releaseElectronProductionPublicLatestLease,
  serializeElectronProductionPublicLatestLease,
  writeElectronProductionPublicLatestLease
} from "../../scripts/electronProductionPublicLatestLease.mjs";
import {
  serializeElectronProductionPublicLatestSnapshot
} from "../../scripts/electronProductionPublicLatestSnapshot.mjs";
import {
  createElectronProductionPublicationRecoveryOutcomeDiscovery,
  type ElectronProductionPublicationRecoveryOutcomeDiscovery,
  type ElectronProductionPublicationRecoveryOutcomeDiscoveryEntry
} from "../../scripts/electronProductionPublicationRecoveryOutcomeDiscovery.mjs";
import {
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_FILE,
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_STORE_SEAL_FILE,
  createElectronProductionPublicationRecoveryOutcome,
  createElectronProductionPublicationRecoveryStoreSeal,
  electronProductionPublicationRecoveryOutcomeAttemptFileName,
  electronProductionPublicationRecoveryOutcomeSha256,
  electronProductionPublicationRecoveryStoreSealSha256,
  serializeElectronProductionPublicationRecoveryOutcome,
  writeElectronProductionPublicationRecoveryStoreSeal,
  type ElectronProductionPublicationRecoveryLeaseRelease,
  type ElectronProductionPublicationRecoveryMutation,
  type ElectronProductionPublicationRecoveryOperation,
  type ElectronProductionPublicationRecoveryOutcome
} from "../../scripts/electronProductionPublicationRecovery.mjs";
import {
  createElectronProductionPublicationIntent
} from "../../scripts/electronProductionPublicationReceipt.mjs";
import {
  ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PACKAGE_NAME
} from "../../scripts/electronProductionRecoveryCapsule.mjs";
import {
  electronProductionRecoveryStoreTransactionPaths
} from "../../scripts/electronProductionRecoveryStoreTransactionPaths.mjs";
import {
  createPublicLatestRecoveryFixture,
  RECOVERY_FIXTURE_TRANSACTION_ID
} from "./electronProductionPublicLatestRecoveryFixture";

const STORE_REPOSITORY = "recovery-owner/recovery-vault";
const STORE_REF = "recovery-main";
const HEAD_COMMIT_SHA = "4".repeat(40);
const ROOT_TREE_SHA = "5".repeat(40);
const OUTCOME_TREE_SHA = "6".repeat(40);

export async function createOutcomeDiscoveryFixture(root: string) {
  const publicFixture = await createPublicLatestRecoveryFixture(root);
  const { heldLease, source, target } = publicFixture;
  const capsuleSource = Buffer.alloc(4096, "rion-recovery-capsule-fixture\n");
  const intent = createElectronProductionPublicationIntent({
    transactionId: RECOVERY_FIXTURE_TRANSACTION_ID,
    recordedAt: "2026-09-01T00:00:00Z",
    lease: { id: heldLease.leaseId, generation: heldLease.generation },
    baseline: {
      runtime: "tauri-v22",
      version: source.latestJson.version,
      releaseTag: source.release.tag,
      sourceSha: "1".repeat(40),
      manifestSha256: source.latestJson.sha256,
      stateSha256: source.stateSha256
    },
    target: {
      runtime: "electron-v23",
      version: target.latestJson.version,
      releaseTag: target.release.tag,
      sourceSha: target.candidateReceipt!.sourceSha,
      candidateReceiptSha256: target.candidateReceipt!.sha256,
      manifestSha256: target.latestJson.sha256,
      stateSha256: target.stateSha256
    }
  });
  const storeSeal = createElectronProductionPublicationRecoveryStoreSeal({
    capsuleBytes: capsuleSource.length,
    capsuleManifestBytes: 1024,
    capsuleManifestSha256: digest("capsule manifest"),
    capsuleSha256: digest(capsuleSource),
    durableStore: {
      repository: STORE_REPOSITORY,
      ref: STORE_REF,
      path: `transactions/${RECOVERY_FIXTURE_TRANSACTION_ID}/` +
        ELECTRON_PRODUCTION_RECOVERY_CAPSULE_PACKAGE_NAME,
      repositoryPolicy: {
        defaultBranch: STORE_REF,
        visibility: "private"
      },
      byteLength: capsuleSource.length,
      blobSha: gitBlobSha(capsuleSource),
      treeSha: "8".repeat(40),
      parentCommitSha: "9".repeat(40),
      commitSha: "a".repeat(40),
      remoteReceiptSha256: digest("capsule create operation"),
      committedAt: "2026-09-01T00:01:00Z"
    },
    heldLease,
    publicationIntent: intent,
    sealedAt: "2026-09-01T00:02:00Z",
    sourceSnapshot: source,
    targetSnapshot: target,
    writer: {
      repository: "rion-tw/release-control",
      workflow: ".github/workflows/store-publication-recovery.yml",
      runId: "8001",
      runAttempt: 1,
      controlSha: "b".repeat(40)
    }
  });
  const foundation = {
    heldLease,
    heldLeaseSha256: digest(serializeElectronProductionPublicLatestLease(heldLease)),
    sourceSnapshot: source,
    sourceSnapshotSha256: digest(
      serializeElectronProductionPublicLatestSnapshot(source)
    ),
    storeSeal,
    storeSealSha256:
      electronProductionPublicationRecoveryStoreSealSha256(storeSeal),
    targetSnapshot: target,
    targetSnapshotSha256: digest(
      serializeElectronProductionPublicLatestSnapshot(target)
    )
  };
  return {
    ...publicFixture,
    capsuleSource,
    foundation,
    storeSeal,
    createOutcome(input: Readonly<{
      determinedAt: string;
      beforeClassification?: "source" | "target" | "unknown";
      beforeObservedAt?: string;
      finalClassification?: "source" | "target" | "unknown";
      finalObservedAt?: string;
      previousOutcomeSha256: string | null;
      runAttempt: number;
      runId: string;
      startedAt: string;
      leaseRelease?: ElectronProductionPublicationRecoveryLeaseRelease;
      mutation?: ElectronProductionPublicationRecoveryMutation;
      recoveryOperation?: ElectronProductionPublicationRecoveryOperation;
      terminal?: boolean;
    }>) {
      const mutation = input.mutation ?? {
        kind: "none" as const,
        submitted: false as const,
        acknowledgement: null,
        submittedAt: null,
        resultRecordedAt: null
      };
      const beforeClassification = input.beforeClassification ?? "source";
      const finalClassification = input.finalClassification ?? "source";
      const released = releaseElectronProductionPublicLatestLease(heldLease, {
        transactionId: heldLease.transactionId,
        leaseId: heldLease.leaseId,
        generation: heldLease.generation,
        sourceStateSha256: heldLease.source.stateSha256,
        targetStateSha256: heldLease.target.stateSha256,
        recordedAt: input.determinedAt
      });
      return createElectronProductionPublicationRecoveryOutcome({
        beforeMutation: {
          classification: beforeClassification,
          observedAt: input.beforeObservedAt ?? input.startedAt,
          stateSha256: observationStateSha256(
            beforeClassification,
            source.stateSha256,
            target.stateSha256
          )
        },
        determinedAt: input.determinedAt,
        finalObservation: {
          classification: finalClassification,
          observedAt: input.finalObservedAt ?? input.startedAt,
          stateSha256: observationStateSha256(
            finalClassification,
            source.stateSha256,
            target.stateSha256
          )
        },
        heldLease,
        leaseRelease: input.leaseRelease ?? (input.terminal
          ? {
              attempted: true,
              acknowledgement: "confirmed",
              attemptedAt: input.determinedAt,
              operationSha256: digest(`release ${input.runId}`),
              resolvedAt: input.determinedAt,
              successorEventSha256:
                electronProductionPublicLatestLeaseEventSha256(released)
            }
          : {
              attempted: false,
              acknowledgement: null,
              attemptedAt: null,
              operationSha256: null,
              resolvedAt: null,
              successorEventSha256: null
            }),
        mutation,
        previousOutcomeSha256: input.previousOutcomeSha256,
        recoveryOperation: input.recoveryOperation ?? {
          kind: mutation.kind === "rollback"
            ? "rion-electron-production-public-latest-recovery-rollback-operation"
            : "rion-electron-production-public-latest-recovery-observation",
          sha256: digest(`observe ${input.runId}:${input.runAttempt}`)
        },
        recoveryRun: {
          repository: "rion-tw/rion-studio-source",
          workflow: ".github/workflows/recover-electron-publication.yml",
          runId: input.runId,
          runAttempt: input.runAttempt,
          controlSha: "c".repeat(40),
          startedAt: input.startedAt
        },
        sourceSnapshot: source,
        storeSeal,
        targetSnapshot: target
      });
    },
    entry(outcome: ElectronProductionPublicationRecoveryOutcome,
      role: "attempt" | "terminal" = "attempt") {
      return outcomeEntry(outcome, role);
    },
    discovery(
      entries: readonly ElectronProductionPublicationRecoveryOutcomeDiscoveryEntry[],
      options: Readonly<{
        observedAt?: string;
        status?: ElectronProductionPublicationRecoveryOutcomeDiscovery["outcomeDirectory"]["status"];
      }> = {}
    ) {
      const status = options.status ?? "present";
      return createElectronProductionPublicationRecoveryOutcomeDiscovery({
        transactionId: RECOVERY_FIXTURE_TRANSACTION_ID,
        target: {
          repository: STORE_REPOSITORY,
          ref: STORE_REF,
          repositoryPolicy: {
            defaultBranch: STORE_REF,
            visibility: "private"
          }
        },
        currentObservation: {
          headCommitSha: HEAD_COMMIT_SHA,
          treeSha: ROOT_TREE_SHA,
          parentCommitShas: ["d".repeat(40)]
        },
        outcomeDirectory: {
          path: outcomeDirectory(),
          status,
          treeSha: status === "present" ? OUTCOME_TREE_SHA : null
        },
        entries: [...entries].sort((left, right) =>
          left.path < right.path ? -1 : left.path > right.path ? 1 : 0
        ),
        observedAt: options.observedAt ?? "2026-09-01T01:00:00Z"
      });
    }
  };
}

export async function writeOutcomeDiscoveryFoundation(
  root: string,
  fixture: Awaited<ReturnType<typeof createOutcomeDiscoveryFixture>>
) {
  const held = await writeElectronProductionPublicLatestLease({
    lease: fixture.heldLease,
    outputPath: path.join(root, "electron-production-public-latest-lease.json")
  });
  const sourcePath = path.join(root, "source-snapshot.json");
  const targetPath = path.join(root, "target-snapshot.json");
  await writeFile(
    sourcePath,
    serializeElectronProductionPublicLatestSnapshot(fixture.source),
    { flag: "wx" }
  );
  await writeFile(
    targetPath,
    serializeElectronProductionPublicLatestSnapshot(fixture.target),
    { flag: "wx" }
  );
  const seal = await writeElectronProductionPublicationRecoveryStoreSeal({
    outputPath: path.join(root,
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_STORE_SEAL_FILE),
    receipt: fixture.storeSeal
  });
  return {
    heldLease: held.leasePath,
    heldLeaseSha256: held.leaseIdentity.sha256,
    sourceSnapshot: sourcePath,
    sourceSnapshotSha256: fixture.foundation.sourceSnapshotSha256,
    storeSeal: seal.receiptPath,
    storeSealSha256: seal.receiptIdentity.sha256,
    targetSnapshot: targetPath,
    targetSnapshotSha256: fixture.foundation.targetSnapshotSha256
  };
}

export function outcomeEntry(
  outcome: ElectronProductionPublicationRecoveryOutcome,
  role: "attempt" | "terminal" = "attempt"
): ElectronProductionPublicationRecoveryOutcomeDiscoveryEntry {
  const source = serializeElectronProductionPublicationRecoveryOutcome(outcome);
  const fileName = role === "terminal"
    ? ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_FILE
    : electronProductionPublicationRecoveryOutcomeAttemptFileName(
        outcome.recoveryRun
      );
  return {
    role,
    path: `${outcomeDirectory()}/${fileName}`,
    fileName,
    mode: "100644",
    type: "blob",
    blobSha: gitBlobSha(source),
    byteLength: source.length,
    sha256: electronProductionPublicationRecoveryOutcomeSha256(outcome),
    contentBase64: source.toString("base64")
  };
}

export function outcomeDirectory() {
  return path.posix.dirname(
    electronProductionRecoveryStoreTransactionPaths({
      transactionId: RECOVERY_FIXTURE_TRANSACTION_ID
    }).recoveryOutcomeTerminalPath
  );
}

export function digest(source: string | Buffer) {
  return createHash("sha256").update(source).digest("hex");
}

export function gitBlobSha(source: Buffer) {
  return createHash("sha1")
    .update(`blob ${source.length}\0`)
    .update(source)
    .digest("hex");
}

function observationStateSha256(
  classification: "source" | "target" | "unknown",
  sourceStateSha256: string,
  targetStateSha256: string
) {
  if (classification === "source") return sourceStateSha256;
  if (classification === "target") return targetStateSha256;
  return null;
}
