import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import {
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_AUTHORIZATION_FILE,
  createElectronProductionPublicationRecoveryLeaseReleaseAuthorization,
  createElectronProductionPublicationRecoveryLeaseReleaseIntent,
  createElectronProductionPublicationRecoveryLeaseReleaseIntentHistory,
  electronProductionPublicationRecoveryLeaseReleaseAuthorizationSha256,
  electronProductionPublicationRecoveryLeaseReleaseIntentHistorySha256,
  electronProductionPublicationRecoveryLeaseReleaseIntentSha256,
  serializeElectronProductionPublicationRecoveryLeaseReleaseIntent,
  writeElectronProductionPublicationRecoveryLeaseReleaseAuthorization,
  type ElectronProductionPublicationRecoveryLeaseReleaseIntent
} from "../../scripts/electronProductionPublicationRecoveryLeaseReleaseIntent.mjs";
import {
  electronProductionPublicationRecoveryOutcomeDiscoverySha256,
  serializeElectronProductionPublicationRecoveryOutcomeChainProof,
  verifyElectronProductionPublicationRecoveryOutcomeChain,
  type ElectronProductionPublicationRecoveryOutcomeDiscoveryEntry
} from "../../scripts/electronProductionPublicationRecoveryOutcomeDiscovery.mjs";
import {
  serializeElectronProductionPublicationRecoveryStoreSeal
} from "../../scripts/electronProductionPublicationRecovery.mjs";
import {
  createElectronProductionRecoveryStoreRemoteOperationReceipt,
  createElectronProductionRecoveryStoreRemoteReadOperationReceipt,
  createElectronProductionRecoveryStoreRemoteReadRequest,
  createElectronProductionRecoveryStoreRemoteRequest,
  electronProductionRecoveryStoreRemoteOperationReceiptSha256,
  electronProductionRecoveryStoreRemoteReadOperationReceiptSha256
} from "../../scripts/electronProductionRecoveryStoreRemoteOperation.mjs";
import type {
  createOutcomeDiscoveryFixture
} from "./electronProductionPublicationRecoveryOutcomeDiscoveryFixture";

type OutcomeFixture = Awaited<
  ReturnType<typeof createOutcomeDiscoveryFixture>
>;

export async function createLeaseReleaseAuthorizationFixture(input: Readonly<{
  authorizedAt: string;
  currentObservation?: Readonly<{ head: string; parent: string; tree: string }>;
  currentRun?: ElectronProductionPublicationRecoveryLeaseReleaseIntent["recoveryRun"];
  fixture: OutcomeFixture;
  freshEntries: readonly ElectronProductionPublicationRecoveryOutcomeDiscoveryEntry[];
  initialEntries?: readonly ElectronProductionPublicationRecoveryOutcomeDiscoveryEntry[];
  intent?: ElectronProductionPublicationRecoveryLeaseReleaseIntent;
  mode: "created-now" | "resumed-existing";
  outputRoot: string;
  recoveryRunStartedAt: string;
  suffix: string;
  verifiedAt: string;
}>) {
  const initialEntries = input.initialEntries ?? input.freshEntries;
  const initialProof = proofAt(input.fixture, initialEntries, "4", "5", "d");
  const intent = input.intent ?? createIntent(
    input.fixture,
    initialProof,
    input.authorizedAt,
    input.recoveryRunStartedAt
  );
  if (input.mode === "resumed-existing" && input.intent === undefined) {
    throw new Error("A resumed authorization fixture requires its durable intent.");
  }
  const current = input.currentObservation ?? (input.mode === "created-now"
    ? { head: "1", tree: "2", parent: "4" }
    : { head: "3", tree: "6", parent: "2" });
  const freshProof = proofAt(
    input.fixture,
    input.freshEntries,
    current.head,
    current.tree,
    current.parent
  );
  const evidence = authorizationEvidence(
    input.fixture,
    intent,
    freshProof,
    { ...current, historyObservedAt: input.verifiedAt, mode: input.mode }
  );
  const currentRun = input.currentRun ?? (input.mode === "created-now"
    ? intent.recoveryRun
    : {
        repository: "rion-tw/rion-studio-source" as const,
        workflow:
          ".github/workflows/electron-production-provisional-recovery.yml" as const,
        runId: "9902",
        runAttempt: 1,
        controlSha: "f".repeat(40),
        startedAt: input.verifiedAt
      });
  const authorization =
    createElectronProductionPublicationRecoveryLeaseReleaseAuthorization({
      ...evidence,
      currentRun,
      verifiedAt: input.verifiedAt
    });
  const directory = path.join(input.outputRoot, `authorization-${input.suffix}`);
  await mkdir(directory);
  const authorizationPath = path.join(
    directory,
    ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_LEASE_RELEASE_AUTHORIZATION_FILE
  );
  const written =
    await writeElectronProductionPublicationRecoveryLeaseReleaseAuthorization({
      outputPath: authorizationPath,
      value: authorization
    });
  return {
    authorization,
    authorizationFile: {
      currentRun: authorization.currentRun,
      path: written.valuePath,
      sha256: written.valueIdentity.sha256
    },
    freshProof,
    evidence,
    initialProof,
    intent,
    sha256:
      electronProductionPublicationRecoveryLeaseReleaseAuthorizationSha256(
        authorization
      )
  } as const;
}

function createIntent(
  fixture: OutcomeFixture,
  chainProof: ReturnType<typeof proofAt>,
  authorizedAt: string,
  startedAt: string
) {
  return createElectronProductionPublicationRecoveryLeaseReleaseIntent({
    heldLease: fixture.heldLease,
    heldLeaseSha256: fixture.foundation.heldLeaseSha256,
    storeSeal: fixture.storeSeal,
    storeSealSha256: fixture.foundation.storeSealSha256,
    chainProof,
    chainProofSha256: digest(
      serializeElectronProductionPublicationRecoveryOutcomeChainProof(chainProof)
    ),
    recoveryRun: {
      repository: "rion-tw/rion-studio-source",
      workflow: ".github/workflows/electron-production-provisional-recovery.yml",
      runId: "9901",
      runAttempt: 1,
      controlSha: "e".repeat(40),
      startedAt
    },
    authorizedAt
  });
}

function proofAt(
  fixture: OutcomeFixture,
  entries: readonly ElectronProductionPublicationRecoveryOutcomeDiscoveryEntry[],
  head: string,
  tree: string,
  parent: string
) {
  const discovery = {
    ...fixture.discovery(entries),
    currentObservation: {
      headCommitSha: head.repeat(40),
      treeSha: tree.repeat(40),
      parentCommitShas: [parent.repeat(40)]
    }
  };
  return verifyElectronProductionPublicationRecoveryOutcomeChain({
    ...fixture.foundation,
    discovery,
    discoverySha256:
      electronProductionPublicationRecoveryOutcomeDiscoverySha256(discovery)
  });
}

function authorizationEvidence(
  fixture: OutcomeFixture,
  intent: ElectronProductionPublicationRecoveryLeaseReleaseIntent,
  freshChainProof: ReturnType<typeof proofAt>,
  options: Readonly<{
    head: string;
    historyObservedAt: string;
    mode: "created-now" | "resumed-existing";
    parent: string;
    tree: string;
  }>
) {
  const source =
    serializeElectronProductionPublicationRecoveryLeaseReleaseIntent(intent);
  const intentSha256 =
    electronProductionPublicationRecoveryLeaseReleaseIntentSha256(intent);
  const target = remoteTarget(intent);
  const createRequest = createElectronProductionRecoveryStoreRemoteRequest({
    expectedHeadSha: intent.privateStore.expectedHeadCommitSha,
    packageIdentity: {
      fileName: path.posix.basename(intent.privateStore.path),
      byteLength: source.length,
      sha256: intentSha256
    },
    target
  });
  const commit = options.head.repeat(40);
  const tree = options.tree.repeat(40);
  const parent = options.parent.repeat(40);
  const blob = gitBlobSha(source);
  const createOperation = options.mode === "created-now"
    ? createElectronProductionRecoveryStoreRemoteOperationReceipt({
        request: createRequest,
        result: {
          outcome: "applied",
          parentSha: intent.privateStore.expectedHeadCommitSha,
          commitSha: commit,
          treeSha: tree,
          blobSha: blob,
          byteLength: source.length
        }
      })
    : null;
  const readRequest = createElectronProductionRecoveryStoreRemoteReadRequest({
    target,
    expectedContent: { byteLength: source.length, sha256: intentSha256 }
  });
  const intentReadOperation =
    createElectronProductionRecoveryStoreRemoteReadOperationReceipt({
      request: readRequest,
      content: source,
      result: {
        outcome: "present",
        blobSha: blob,
        byteLength: source.length,
        commitMessage: "recovery readback",
        contentBase64: source.toString("base64"),
        headSha: commit,
        parentShas: [parent],
        treeSha: tree
      }
    });
  const intentHistoryProof = options.mode === "resumed-existing"
    ? createElectronProductionPublicationRecoveryLeaseReleaseIntentHistory({
        target: intent.privateStore.target,
        path: intent.privateStore.path,
        initialHeadCommitSha: intent.privateStore.expectedHeadCommitSha,
        intentCommitSha: "1".repeat(40),
        intentTreeSha: "a".repeat(40),
        intentBlobSha: blob,
        currentObservation: {
          headCommitSha: commit,
          treeSha: tree,
          parentCommitShas: [parent]
        },
        pathHistory: {
          reachableFromHeadCommitSha: commit,
          commitSha: "1".repeat(40),
          resultCount: 1,
          nextPage: false
        },
        observedAt: options.historyObservedAt
      })
    : null;
  return {
    intent,
    intentSha256,
    createOperation,
    createOperationSha256: createOperation === null
      ? null
      : electronProductionRecoveryStoreRemoteOperationReceiptSha256(
          createOperation
        ),
    intentHistoryProof,
    intentHistoryProofSha256: intentHistoryProof === null
      ? null
      : electronProductionPublicationRecoveryLeaseReleaseIntentHistorySha256(
          intentHistoryProof
        ),
    intentReadOperation,
    intentReadOperationSha256:
      electronProductionRecoveryStoreRemoteReadOperationReceiptSha256(
        intentReadOperation
      ),
    freshChainProof,
    freshChainProofSha256: digest(
      serializeElectronProductionPublicationRecoveryOutcomeChainProof(
        freshChainProof
      )
    ),
    foundationReadback: foundationReadback(fixture, intent, {
      head: commit,
      parent,
      tree
    })
  } as const;
}

function foundationReadback(
  fixture: OutcomeFixture,
  intent: ElectronProductionPublicationRecoveryLeaseReleaseIntent,
  observation: Readonly<{ head: string; parent: string; tree: string }>
) {
  return {
    schemaVersion: 1,
    kind: "rion-electron-production-recovery-store-readback-foundation",
    status: "verified-current-readback",
    transactionId: intent.transactionId,
    target: intent.privateStore.target,
    paths: {
      capsule: intent.foundation.capsule.path,
      storeSeal: intent.foundation.storeSeal.path
    },
    currentObservation: {
      headCommitSha: observation.head,
      treeSha: observation.tree,
      parentCommitShas: [observation.parent]
    },
    capsule: {
      file: {
        fileName: intent.foundation.capsule.fileName,
        byteLength: intent.foundation.capsule.byteLength,
        sha256: intent.foundation.capsule.sha256
      },
      blobSha: fixture.storeSeal.durableStore.blobSha,
      readReceiptSha256: digest("capsule read")
    },
    storeSeal: {
      file: {
        fileName: intent.foundation.storeSeal.fileName,
        byteLength:
          serializeElectronProductionPublicationRecoveryStoreSeal(
            fixture.storeSeal
          ).length,
        sha256: intent.foundation.storeSeal.sha256
      },
      blobSha: "8".repeat(40),
      readReceiptSha256: digest("seal read")
    },
    historicalCapsuleCreate: {
      authority: "seal-recorded-not-reproved",
      parentCommitSha: fixture.storeSeal.durableStore.parentCommitSha,
      commitSha: fixture.storeSeal.durableStore.commitSha,
      treeSha: fixture.storeSeal.durableStore.treeSha,
      operationReceiptSha256:
        fixture.storeSeal.durableStore.remoteReceiptSha256
    }
  } as const;
}

function remoteTarget(intent: ElectronProductionPublicationRecoveryLeaseReleaseIntent) {
  const [owner, repo] = intent.privateStore.target.repository.split("/");
  return {
    owner: owner!,
    repo: repo!,
    ref: intent.privateStore.target.ref,
    path: intent.privateStore.path,
    repositoryPolicy: intent.privateStore.target.repositoryPolicy
  };
}

function gitBlobSha(source: Uint8Array) {
  return createHash("sha1")
    .update(`blob ${source.length}\0`)
    .update(source)
    .digest("hex");
}

function digest(source: string | Uint8Array) {
  return createHash("sha256").update(source).digest("hex");
}
