import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  electronProductionPublicLatestLeaseEventSha256,
  serializeElectronProductionPublicLatestLease
} from "../scripts/electronProductionPublicLatestLease.mjs";
import {
  assertElectronProductionPublicationRecoveryLeaseReleaseAuthorization,
  createElectronProductionPublicationRecoveryLeaseReleaseAuthorization,
  createElectronProductionPublicationRecoveryLeaseReleaseIntent,
  createElectronProductionPublicationRecoveryLeaseReleaseIntentHistory,
  electronProductionPublicationRecoveryLeaseReleaseAuthorizationSha256,
  electronProductionPublicationRecoveryLeaseReleaseIntentHistorySha256,
  electronProductionPublicationRecoveryLeaseReleaseIntentPath,
  electronProductionPublicationRecoveryLeaseReleaseIntentSha256,
  readElectronProductionPublicationRecoveryLeaseReleaseIntent,
  serializeElectronProductionPublicationRecoveryLeaseReleaseIntent,
  writeElectronProductionPublicationRecoveryLeaseReleaseIntent
} from "../scripts/electronProductionPublicationRecoveryLeaseReleaseIntent.mjs";
import {
  electronProductionPublicationRecoveryOutcomeDiscoverySha256,
  serializeElectronProductionPublicationRecoveryOutcomeChainProof,
  verifyElectronProductionPublicationRecoveryOutcomeChain
} from "../scripts/electronProductionPublicationRecoveryOutcomeDiscovery.mjs";
import {
  serializeElectronProductionPublicationRecoveryStoreSeal
} from "../scripts/electronProductionPublicationRecovery.mjs";
import {
  createElectronProductionRecoveryStoreRemoteOperationReceipt,
  createElectronProductionRecoveryStoreRemoteReadOperationReceipt,
  createElectronProductionRecoveryStoreRemoteReadRequest,
  createElectronProductionRecoveryStoreRemoteRequest,
  electronProductionRecoveryStoreRemoteOperationReceiptSha256,
  electronProductionRecoveryStoreRemoteReadOperationReceiptSha256
} from "../scripts/electronProductionRecoveryStoreRemoteOperation.mjs";
import {
  createOutcomeDiscoveryFixture
} from "./support/electronProductionPublicationRecoveryOutcomeDiscoveryFixture";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("publication recovery lease-release intent", () => {
  it("binds one fixed durable intent and authorizes exactly one private head transition", async () => {
    const fixture = await newFixture();
    const initialProof = proofAt(fixture, [], "4", "5", "d");
    const intent = intentFrom(fixture, initialProof);
    const freshProof = proofAt(fixture, [], "1", "2", "4");
    const evidence = authorizationEvidence(fixture, intent, freshProof, {
      mode: "created-now",
      head: "1",
      tree: "2"
    });
    const authorization =
      createElectronProductionPublicationRecoveryLeaseReleaseAuthorization({
        ...evidence,
        verifiedAt: "2026-09-01T01:02:00Z"
      });

    expect(intent).toMatchObject({
      status: "durable-pre-public-release-authority",
      transactionId: fixture.heldLease.transactionId,
      heldLease: {
        eventSha256:
          electronProductionPublicLatestLeaseEventSha256(fixture.heldLease),
        fileSha256: digest(
          serializeElectronProductionPublicLatestLease(fixture.heldLease)
        )
      },
      privateStore: {
        path: electronProductionPublicationRecoveryLeaseReleaseIntentPath({
          transactionId: fixture.heldLease.transactionId
        }),
        expectedHeadCommitSha: "4".repeat(40)
      },
      publicLatest: {
        repository: "rion-tw/rion-studio",
        ref: "main",
        path: "releases/electron-production-public-latest-lease.json",
        overtakePolicy: "forbidden-until-terminal-outcome"
      }
    });
    expect(authorization).toMatchObject({
      status: "verified-durable-release-authority",
      transactionId: fixture.heldLease.transactionId,
      headTransition: {
        mode: "created-now",
        initialHeadCommitSha: "4".repeat(40),
        currentHeadCommitSha: "1".repeat(40),
        intentCommitSha: "1".repeat(40),
        treeSha: "2".repeat(40),
        parentCommitShas: ["4".repeat(40)]
      }
    });
    expect(() =>
      assertElectronProductionPublicationRecoveryLeaseReleaseAuthorization(
        authorization
      )
    ).not.toThrow();
    expect(electronProductionPublicationRecoveryLeaseReleaseAuthorizationSha256(
      authorization
    )).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("resumes an unchanged existing intent only when the fresh open chain preserves its exact prefix", async () => {
    const fixture = await newFixture();
    const first = fixture.createOutcome({
      runId: "9401",
      runAttempt: 1,
      previousOutcomeSha256: null,
      startedAt: "2026-09-01T00:03:00Z",
      determinedAt: "2026-09-01T00:04:00Z"
    });
    const initialProof = proofAt(fixture, [fixture.entry(first)], "4", "5", "d");
    const intent = intentFrom(fixture, initialProof);
    const second = fixture.createOutcome({
      runId: "9402",
      runAttempt: 1,
      previousOutcomeSha256: digest(
        fixture.entry(first).contentBase64,
        "base64"
      ),
      startedAt: "2026-09-01T01:00:30Z",
      determinedAt: "2026-09-01T01:01:00Z"
    });
    const freshProof = proofAt(
      fixture,
      [fixture.entry(first), fixture.entry(second)],
      "3",
      "6",
      "2"
    );
    const evidence = authorizationEvidence(fixture, intent, freshProof, {
      mode: "resumed-existing",
      head: "3",
      tree: "6",
      parent: "2"
    });
    const authorization =
      createElectronProductionPublicationRecoveryLeaseReleaseAuthorization({
        ...evidence,
        verifiedAt: "2026-09-01T01:02:00Z"
      });

    expect(authorization.headTransition).toMatchObject({
      mode: "resumed-existing",
      currentHeadCommitSha: "3".repeat(40),
      intentCommitSha: null
    });
    expect(authorization.evidence.freshChainProof.receipt.latestOutcome?.sha256)
      .toBe(freshProof.latestOutcome?.sha256);

    expect(() =>
      createElectronProductionPublicationRecoveryLeaseReleaseAuthorization({
        ...evidence,
        verifiedAt: "2026-09-01T01:00:45Z"
      })
    ).toThrow("cannot precede its fresh chain head");

    const forked = structuredClone(freshProof) as unknown as MutableChainProof;
    forked.outcomes[0].sha256 = "f".repeat(64);
    forked.outcomes[1].previousOutcomeSha256 = "f".repeat(64);
    forked.latestOutcome = { ...forked.outcomes[1] };
    expect(() => createElectronProductionPublicationRecoveryLeaseReleaseAuthorization({
      ...evidence,
      freshChainProof: forked as never,
      freshChainProofSha256: digest(
        serializeElectronProductionPublicationRecoveryOutcomeChainProof(forked)
      ),
      verifiedAt: "2026-09-01T01:02:00Z"
    })).toThrow("exact prefix");
  });

  it("rejects terminal, foreign-foundation, stale-reader, and unrelated-intent evidence", async () => {
    const fixture = await newFixture();
    const initialProof = proofAt(fixture, [], "4", "5", "d");
    const intent = intentFrom(fixture, initialProof);
    const freshProof = proofAt(fixture, [], "1", "2", "4");
    const evidence = authorizationEvidence(fixture, intent, freshProof, {
      mode: "created-now",
      head: "1",
      tree: "2"
    });
    const staleRead = structuredClone(evidence.intentReadOperation) as {
      observed: null | { headCommitSha: string };
    };
    if (staleRead.observed === null) throw new Error("Expected present read.");
    staleRead.observed.headCommitSha = "9".repeat(40);
    expect(() => createElectronProductionPublicationRecoveryLeaseReleaseAuthorization({
      ...evidence,
      intentReadOperation: staleRead as never,
      intentReadOperationSha256:
        electronProductionRecoveryStoreRemoteReadOperationReceiptSha256(staleRead),
      verifiedAt: "2026-09-01T01:02:00Z"
    })).toThrow(/head|transition/u);

    const foreign = structuredClone(intent) as {
      heldLease: { eventSha256: string };
    };
    foreign.heldLease.eventSha256 = "9".repeat(64);
    expect(() => createElectronProductionPublicationRecoveryLeaseReleaseAuthorization({
      ...evidence,
      intent: foreign as never,
      intentSha256: digest(
        serializeElectronProductionPublicationRecoveryLeaseReleaseIntent(foreign)
      ),
      verifiedAt: "2026-09-01T01:02:00Z"
    })).toThrow(/held event|chain held/u);
  });

  it("writes and reads the canonical intent create-new by external digest", async () => {
    const fixture = await newFixture();
    const intent = intentFrom(fixture, proofAt(fixture, [], "4", "5", "d"));
    const directory = await temporaryDirectory();
    const outputPath = path.join(
      directory,
      "electron-production-publication-recovery-lease-release-intent.json"
    );
    const written =
      await writeElectronProductionPublicationRecoveryLeaseReleaseIntent({
        outputPath,
        value: intent
      });

    expect(await readFile(outputPath)).toEqual(
      serializeElectronProductionPublicationRecoveryLeaseReleaseIntent(intent)
    );
    await expect(readElectronProductionPublicationRecoveryLeaseReleaseIntent({
      receiptPath: outputPath,
      expectedSha256: written.valueIdentity.sha256
    })).resolves.toEqual(written);
    await expect(writeElectronProductionPublicationRecoveryLeaseReleaseIntent({
      outputPath,
      value: intent
    })).rejects.toThrow("create-new");
  });
});

async function newFixture() {
  const directory = await temporaryDirectory();
  return createOutcomeDiscoveryFixture(directory);
}

function proofAt(
  fixture: Awaited<ReturnType<typeof createOutcomeDiscoveryFixture>>,
  entries: ReturnType<typeof fixture.entry>[],
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

function intentFrom(
  fixture: Awaited<ReturnType<typeof createOutcomeDiscoveryFixture>>,
  chainProof: ReturnType<typeof proofAt>
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
      startedAt: "2026-09-01T00:30:00Z"
    },
    authorizedAt: "2026-09-01T01:00:00Z"
  });
}

function authorizationEvidence(
  fixture: Awaited<ReturnType<typeof createOutcomeDiscoveryFixture>>,
  intent: ReturnType<typeof intentFrom>,
  freshChainProof: ReturnType<typeof proofAt>,
  options: Readonly<{
    mode: "created-now" | "resumed-existing";
    head: string;
    tree: string;
    parent?: string;
  }>
) {
  const source = serializeElectronProductionPublicationRecoveryLeaseReleaseIntent(
    intent
  );
  const intentSha256 = electronProductionPublicationRecoveryLeaseReleaseIntentSha256(
    intent
  );
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
  const parent = (options.parent ?? "4").repeat(40);
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
        observedAt: "2026-09-01T01:01:00Z"
      })
    : null;
  return {
    currentRun: options.mode === "created-now"
      ? intent.recoveryRun
      : {
          repository: "rion-tw/rion-studio-source" as const,
          workflow:
            ".github/workflows/electron-production-provisional-recovery.yml" as const,
          runId: "9902",
          runAttempt: 1,
          controlSha: "f".repeat(40),
          startedAt: "2026-09-01T01:00:00Z"
        },
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
    foundationReadback: {
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
        headCommitSha: commit,
        treeSha: tree,
        parentCommitShas: [parent]
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
    }
  } as const;
}

function remoteTarget(intent: ReturnType<typeof intentFrom>) {
  const [owner, repo] = intent.privateStore.target.repository.split("/");
  return {
    owner,
    repo,
    ref: intent.privateStore.target.ref,
    path: intent.privateStore.path,
    repositoryPolicy: intent.privateStore.target.repositoryPolicy
  };
}

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "rion-release-intent-"));
  temporaryDirectories.push(directory);
  return directory;
}

function gitBlobSha(source: Uint8Array) {
  return createHash("sha1")
    .update(`blob ${source.length}\0`)
    .update(source)
    .digest("hex");
}

function digest(source: string | Uint8Array, encoding?: BufferEncoding) {
  const bytes = typeof source === "string"
    ? Buffer.from(source, encoding)
    : source;
  return createHash("sha256").update(bytes).digest("hex");
}

type MutableChainProof = {
  outcomes: Array<{
    previousOutcomeSha256: string | null;
    sha256: string;
  }>;
  latestOutcome: null | {
    previousOutcomeSha256: string | null;
    sha256: string;
  };
};
