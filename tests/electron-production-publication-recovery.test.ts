import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_KIND,
  ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_ROLLBACK_KIND
} from "../scripts/electronProductionPublicLatestRecovery.mjs";
import {
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_FILE,
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_STORE_SEAL_FILE,
  assertElectronProductionPublicationRecoveryOutcome,
  assertElectronProductionPublicationRecoveryOutcomeBindings,
  assertElectronProductionPublicationRecoveryStoreSeal,
  assertElectronProductionPublicationRecoveryStoreSealBindings,
  createElectronProductionPublicationRecoveryOutcome,
  createElectronProductionPublicationRecoveryStoreSeal,
  electronProductionPublicationRecoveryOutcomeSha256,
  electronProductionPublicationRecoveryOutcomeAttemptFileName,
  electronProductionPublicationRecoveryStoreSealSha256,
  readElectronProductionPublicationRecoveryOutcomeAttempt,
  readElectronProductionPublicationRecoveryStoreSeal,
  writeElectronProductionPublicationRecoveryOutcome,
  writeElectronProductionPublicationRecoveryOutcomeAttempt,
  writeElectronProductionPublicationRecoveryStoreSeal,
  type ElectronProductionPublicationRecoveryLeaseRelease,
  type ElectronProductionPublicationRecoveryMutation,
  type ElectronProductionPublicationRecoveryOutcome
} from "../scripts/electronProductionPublicationRecovery.mjs";
import {
  createElectronProductionPublicationIntent
} from "../scripts/electronProductionPublicationReceipt.mjs";

const TRANSACTION_ID = "018f47a0-2d3e-7abc-8def-1234567890ab";
const LEASE_ID = "018f47a0-2d3e-7abc-8def-1234567890ac";
const PUBLIC_BASE =
  "https://github.com/rion-tw/rion-studio/releases/latest/download/";
const SOURCE_SHA = "1".repeat(40);
const CONTROL_SHA = "2".repeat(40);
const RECOVERY_CONTROL_SHA = "3".repeat(40);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("Electron production publication recovery contracts", () => {
  it("seals one pre-mutation capsule in an explicitly selected durable store", () => {
    const fixture = recoveryFixture();
    const seal = fixture.storeSeal;

    expect(seal).toMatchObject({
      status: "durably-stored-pre-mutation",
      transactionId: TRANSACTION_ID,
      capsuleFileName:
        "electron-production-publication-recovery-capsule.capsule.json",
      capsuleBytes: 4096,
      lease: {
        leaseId: LEASE_ID,
        generation: 1
      },
      source: {
        runtime: "tauri-v22",
        version: "8.4.2",
        releaseId: fixture.source.release.id,
        stateSha256: fixture.source.stateSha256
      },
      target: {
        runtime: "electron-v23",
        version: "8.6.0",
        releaseId: fixture.target.release.id,
        stateSha256: fixture.target.stateSha256
      },
      durableStore: {
        repository: "alternate-owner/recovery-vault",
        ref: "recovery-capsules",
        repositoryPolicy: {
          defaultBranch: "recovery-capsules",
          visibility: "private"
        },
        byteLength: 4096,
        blobSha: "5".repeat(40),
        treeSha: "6".repeat(40),
        parentCommitSha: "7".repeat(40),
        commitSha: "4".repeat(40),
        remoteReceiptSha256: digest("durable store applied operation")
      }
    });
    expect(Object.isFrozen(seal)).toBe(true);
    expect(assertElectronProductionPublicationRecoveryStoreSealBindings({
      heldLease: fixture.heldLease,
      publicationIntent: fixture.intent,
      seal,
      sourceSnapshot: fixture.source,
      targetSnapshot: fixture.target
    })).toEqual(seal);

    const rebound = structuredClone(seal) as Record<string, unknown>;
    (rebound.lease as Record<string, unknown>).eventSha256 =
      digest("a different held lease event");
    expect(() => assertElectronProductionPublicationRecoveryStoreSealBindings({
      heldLease: fixture.heldLease,
      publicationIntent: fixture.intent,
      seal: rebound,
      sourceSnapshot: fixture.source,
      targetSnapshot: fixture.target
    })).toThrow("lease binding");

    const hardcodedShape = structuredClone(seal) as Record<string, unknown>;
    (hardcodedShape.durableStore as Record<string, unknown>).repository =
      "another-owner/another-private-store";
    expect(assertElectronProductionPublicationRecoveryStoreSeal(hardcodedShape)
      .durableStore.repository).toBe("another-owner/another-private-store");

    const mismatchedBlob = structuredClone(seal) as Record<string, unknown>;
    (mismatchedBlob.durableStore as Record<string, unknown>).byteLength = 4095;
    expect(() => assertElectronProductionPublicationRecoveryStoreSeal(mismatchedBlob))
      .toThrow("capsule byte length");

    const publicStore = structuredClone(seal) as Record<string, unknown>;
    ((publicStore.durableStore as Record<string, unknown>)
      .repositoryPolicy as Record<string, unknown>).visibility = "public";
    expect(() => assertElectronProductionPublicationRecoveryStoreSeal(publicStore))
      .toThrow("durable recovery store visibility");
  });

  it("authorizes lease release only for an exact source-observed no-op", () => {
    const fixture = recoveryFixture();
    const outcome = createOutcome(fixture, {
      before: fixture.source,
      final: fixture.source,
      mutation: noMutation(),
      leaseRelease: confirmedLeaseRelease()
    });

    expect(outcome).toMatchObject({
      observation: {
        beforeMutation: { classification: "source" },
        final: { classification: "source" }
      },
      mutation: {
        kind: "none",
        submitted: false,
        acknowledgement: null
      },
      outcome: {
        classification: "source-observed-noop",
        terminal: true,
        safeToReleaseLease: true
      }
    });
    const source = JSON.stringify(outcome);
    expect(source).not.toContain("not-submitted");
    expect(source).not.toContain("promoted");
    expect(assertElectronProductionPublicationRecoveryOutcomeBindings({
      heldLease: fixture.heldLease,
      outcome,
      sourceSnapshot: fixture.source,
      storeSeal: fixture.storeSeal,
      targetSnapshot: fixture.target
    })).toEqual(outcome);
    const unreleased = createOutcome(fixture, {
      before: fixture.source,
      final: fixture.source,
      mutation: noMutation(),
      leaseRelease: noLeaseRelease()
    });
    expect(unreleased.outcome).toMatchObject({
      classification: "indeterminate",
      terminal: false,
      safeToReleaseLease: false
    });
  });

  it("authorizes lease release only after confirmed rollback and exact source readback", () => {
    const fixture = recoveryFixture();
    const outcome = createOutcome(fixture, {
      before: fixture.observedTarget,
      final: fixture.source,
      mutation: rollbackMutation("confirmed"),
      leaseRelease: confirmedLeaseRelease()
    });

    expect(outcome).toMatchObject({
      observation: {
        beforeMutation: {
          classification: "target",
          stateSha256: fixture.target.stateSha256
        },
        final: {
          classification: "source",
          stateSha256: fixture.source.stateSha256
        }
      },
      mutation: {
        kind: "rollback",
        submitted: true,
        acknowledgement: "confirmed"
      },
      outcome: {
        classification: "rollback-confirmed",
        terminal: true,
        safeToReleaseLease: true
      }
    });
  });

  it("records marker-only rollback and lease reconciliation without forged transport times", () => {
    const fixture = recoveryFixture();
    const reservation = {
      attemptSha256: digest("durable public-mutation attempt"),
      authorizationSha256: digest("fresh public-mutation authorization")
    };
    expect(() => createOutcome(fixture, {
      before: fixture.observedTarget,
      final: fixture.source,
      mutation: {
        kind: "rollback",
        submitted: "possibly",
        acknowledgement: "unknown",
        reservedAt: "2026-09-01T00:05:00Z",
        submittedAt: null,
        resultRecordedAt: "2026-09-01T00:07:00Z",
        reservation
      },
      leaseRelease: noLeaseRelease()
    })).toThrow("requires marker authority");
    const rollback = createElectronProductionPublicationRecoveryOutcome({
      ...outcomeInput(fixture, {
      before: fixture.observedTarget,
      final: fixture.source,
      mutation: {
        kind: "rollback",
        submitted: "possibly",
        acknowledgement: "unknown",
        reservedAt: "2026-09-01T00:05:00Z",
        submittedAt: null,
        resultRecordedAt: "2026-09-01T00:07:00Z",
        reservation
      },
      leaseRelease: noLeaseRelease()
      }),
      recoveryOperation: markerRecoveryOperation(
        "rollback-public-latest",
        "marker-reconciliation",
        reservation
      ),
      recoveryRun: {
        ...recoveryRun(),
        runId: "9002",
        runAttempt: 1,
        startedAt: "2026-09-01T00:06:00Z"
      }
    });
    expect(rollback.mutation).toEqual({
      kind: "rollback",
      submitted: "possibly",
      acknowledgement: "unknown",
      reservedAt: "2026-09-01T00:05:00Z",
      submittedAt: null,
      resultRecordedAt: "2026-09-01T00:07:00Z",
      reservation
    });
    expect(rollback.outcome).toMatchObject({
      classification: "indeterminate",
      terminal: false,
      safeToReleaseLease: false
    });

    const unresolvedRelease = createElectronProductionPublicationRecoveryOutcome({
      ...outcomeInput(fixture, {
      before: fixture.source,
      final: fixture.source,
      mutation: noMutation(),
      leaseRelease: {
        attempted: "possibly",
        acknowledgement: "unknown",
        attemptedAt: null,
        operationSha256: null,
        reservation,
        resolvedAt: "2026-09-01T00:08:00Z",
        successorEventSha256: null
      }
      }),
      recoveryOperation: markerRecoveryOperation(
        "release-held-lease",
        "marker-reconciliation",
        reservation
      ),
      recoveryRun: {
        ...recoveryRun(),
        runId: "9003",
        runAttempt: 1,
        startedAt: "2026-09-01T00:06:00Z"
      }
    });
    expect(unresolvedRelease.outcome).toMatchObject({
      classification: "lease-release-acknowledgement-unknown",
      terminal: false,
      safeToReleaseLease: false
    });

    for (const classification of ["foreign", "unknown"] as const) {
      const stateSha256 = classification === "foreign"
        ? digest("foreign public-latest state")
        : null;
      const drifted = createElectronProductionPublicationRecoveryOutcome({
        ...outcomeInput(fixture, {
          before: fixture.source,
          final: null,
          mutation: noMutation(),
          leaseRelease: {
            attempted: "possibly",
            acknowledgement: "unknown",
            attemptedAt: null,
            operationSha256: null,
            reservation,
            resolvedAt: "2026-09-01T00:08:00Z",
            successorEventSha256: null
          }
        }),
        finalObservation: {
          classification,
          observedAt: "2026-09-01T00:07:00Z",
          stateSha256
        },
        recoveryOperation: markerRecoveryOperation(
          "release-held-lease",
          "marker-reconciliation",
          reservation
        ),
        recoveryRun: {
          ...recoveryRun(),
          runId: classification === "foreign" ? "9004" : "9005",
          runAttempt: 1,
          startedAt: "2026-09-01T00:06:00Z"
        }
      });
      expect(drifted.outcome).toMatchObject({
        classification: "lease-release-acknowledgement-unknown",
        terminal: false,
        safeToReleaseLease: false
      });
    }

    const reconciledRelease = createElectronProductionPublicationRecoveryOutcome({
      ...outcomeInput(fixture, {
      before: fixture.source,
      final: fixture.source,
      mutation: noMutation(),
      leaseRelease: {
        attempted: "possibly",
        acknowledgement: "confirmed",
        attemptedAt: "2026-09-01T00:07:30Z",
        operationSha256: null,
        reservation,
        resolvedAt: "2026-09-01T00:08:00Z",
        successorEventSha256: digest("authoritative released successor")
      }
      }),
      recoveryOperation: markerRecoveryOperation(
        "release-held-lease",
        "marker-reconciliation",
        reservation
      )
    });
    expect(reconciledRelease.outcome).toMatchObject({
      classification: "source-observed-noop",
      terminal: true,
      safeToReleaseLease: true
    });

    const forged = structuredClone(unresolvedRelease) as Record<string, unknown>;
    (((forged.leaseRelease as Record<string, unknown>)
      .reservation as Record<string, unknown>).authorizationSha256) = "not-a-digest";
    expect(() => assertElectronProductionPublicationRecoveryOutcome(forged))
      .toThrow("public-mutation authorization SHA-256");
  });

  it.each([
    ["unknown acknowledgement with source readback", "unknown", "source"],
    ["rejected acknowledgement with source readback", "rejected", "source"],
    ["confirmed acknowledgement with target readback", "confirmed", "target"],
    ["unknown acknowledgement with unknown readback", "unknown", "unknown"]
  ] as const)("keeps %s indeterminate and held", (_label, acknowledgement, final) => {
    const fixture = recoveryFixture();
    const finalSnapshot = final === "source"
      ? fixture.source
      : final === "target" ? fixture.observedTarget : null;
    const outcome = createOutcome(fixture, {
      before: fixture.observedTarget,
      final: finalSnapshot,
      mutation: rollbackMutation(acknowledgement),
      leaseRelease: noLeaseRelease()
    });

    expect(outcome.outcome).toEqual({
      classification: "indeterminate",
      terminal: false,
      safeToReleaseLease: false,
      determinedAt: "2026-09-01T00:09:00Z"
    });
  });

  it("records an unknown lease-release acknowledgement without reauthorizing release", () => {
    const fixture = recoveryFixture();
    const outcome = createOutcome(fixture, {
      before: fixture.observedTarget,
      final: fixture.source,
      mutation: rollbackMutation("confirmed"),
      leaseRelease: {
        attempted: true,
        acknowledgement: "unknown",
        attemptedAt: "2026-09-01T00:08:00Z",
        operationSha256: digest("unknown lease release operation"),
        resolvedAt: "2026-09-01T00:08:00Z",
        successorEventSha256: null
      }
    });

    expect(outcome.outcome).toMatchObject({
      classification: "lease-release-acknowledgement-unknown",
      terminal: false,
      safeToReleaseLease: false
    });
    const unsafePair = createOutcome(fixture, {
      before: fixture.observedTarget,
      final: null,
      mutation: rollbackMutation("unknown"),
      leaseRelease: {
        attempted: true,
        acknowledgement: "unknown",
        attemptedAt: "2026-09-01T00:08:00Z",
        operationSha256: digest("unsafe lease release operation"),
        resolvedAt: "2026-09-01T00:08:00Z",
        successorEventSha256: null
      }
    });
    expect(unsafePair.outcome).toMatchObject({
      classification: "lease-release-acknowledgement-unknown",
      terminal: false,
      safeToReleaseLease: false
    });
  });

  it("rejects forged terminality, unsafe rollback, and invented acknowledgements", () => {
    const fixture = recoveryFixture();
    const indeterminate = createOutcome(fixture, {
      before: fixture.observedTarget,
      final: null,
      mutation: rollbackMutation("unknown"),
      leaseRelease: noLeaseRelease()
    });
    const forgedTerminal = structuredClone(indeterminate) as Record<string, unknown>;
    const forgedDecision = forgedTerminal.outcome as Record<string, unknown>;
    forgedDecision.classification = "rollback-confirmed";
    forgedDecision.terminal = true;
    forgedDecision.safeToReleaseLease = true;
    expect(() => assertElectronProductionPublicationRecoveryOutcome(forgedTerminal))
      .toThrow("derived publication recovery outcome");

    const inventedAcknowledgement = structuredClone(indeterminate) as Record<string, unknown>;
    (inventedAcknowledgement.mutation as Record<string, unknown>).acknowledgement =
      "not-submitted";
    expect(() => assertElectronProductionPublicationRecoveryOutcome(
      inventedAcknowledgement
    )).toThrow("rollback acknowledgement is invalid");

    const inventedPromotion = structuredClone(indeterminate) as Record<string, unknown>;
    (inventedPromotion.outcome as Record<string, unknown>).classification = "promoted";
    expect(() => assertElectronProductionPublicationRecoveryOutcome(inventedPromotion))
      .toThrow("publication recovery outcome is invalid");

    expect(() => createOutcome(fixture, {
      before: fixture.source,
      final: fixture.source,
      mutation: rollbackMutation("confirmed"),
      leaseRelease: noLeaseRelease()
    })).toThrow("Rollback requires an exact target observation");
  });

  it("writes and rereads canonical create-new store and outcome receipts", async () => {
    const fixture = recoveryFixture();
    const outcome = createOutcome(fixture, {
      before: fixture.source,
      final: fixture.source,
      mutation: noMutation(),
      leaseRelease: noLeaseRelease()
    });
    const root = await temporaryDirectory();
    const sealPath = path.join(
      root,
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_STORE_SEAL_FILE
    );
    const terminalOutcomePath = path.join(
      root,
      ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_FILE
    );
    const outcomePath = path.join(
      root,
      electronProductionPublicationRecoveryOutcomeAttemptFileName(
        outcome.recoveryRun
      )
    );
    const writtenSeal = await writeElectronProductionPublicationRecoveryStoreSeal({
      outputPath: sealPath,
      receipt: fixture.storeSeal
    });
    const writtenOutcome =
      await writeElectronProductionPublicationRecoveryOutcomeAttempt({
      outputPath: outcomePath,
      receipt: outcome
    });

    expect(await readFile(sealPath)).toEqual(serializeCanonicalJson(fixture.storeSeal));
    expect(await readFile(outcomePath)).toEqual(serializeCanonicalJson(outcome));
    expect(writtenSeal.receiptIdentity.sha256).toBe(
      electronProductionPublicationRecoveryStoreSealSha256(fixture.storeSeal)
    );
    expect(writtenOutcome.receiptIdentity.sha256).toBe(
      electronProductionPublicationRecoveryOutcomeSha256(outcome)
    );
    expect((await readElectronProductionPublicationRecoveryStoreSeal({
      receiptPath: sealPath,
      expectedSha256: writtenSeal.receiptIdentity.sha256
    })).receipt).toEqual(fixture.storeSeal);
    expect((await readElectronProductionPublicationRecoveryOutcomeAttempt({
      receiptPath: outcomePath,
      expectedSha256: writtenOutcome.receiptIdentity.sha256
    })).receipt).toEqual(outcome);
    await expect(writeElectronProductionPublicationRecoveryOutcomeAttempt({
      outputPath: outcomePath,
      receipt: outcome
    })).rejects.toThrow("must be create-new");
    await expect(writeElectronProductionPublicationRecoveryOutcome({
      outputPath: terminalOutcomePath,
      receipt: outcome
    })).rejects.toThrow("terminal-only");
  });

  it("rejects reversed recovery timestamps and store-path traversal", () => {
    const fixture = recoveryFixture();
    expect(() => createElectronProductionPublicationRecoveryOutcome({
      ...outcomeInput(fixture, {
        before: fixture.source,
        final: fixture.source,
        mutation: noMutation(),
        leaseRelease: noLeaseRelease()
      }),
      recoveryRun: {
        ...recoveryRun(),
        startedAt: "2026-09-01T00:00:30Z"
      }
    })).toThrow("cannot precede its durable store seal");

    const forgedSeal = structuredClone(fixture.storeSeal) as Record<string, unknown>;
    (forgedSeal.durableStore as Record<string, unknown>).path = "../capsule.json";
    expect(() => assertElectronProductionPublicationRecoveryStoreSeal(forgedSeal))
      .toThrow("repository-relative");
  });
});

function recoveryFixture() {
  const source = makeObservedSnapshot({
    candidate: null,
    idBase: 100,
    isLatest: true,
    version: "8.4.2"
  });
  const staged = makeObservedSnapshot({
    candidate: candidateSummary("8.6.0"),
    idBase: 200,
    isLatest: false,
    version: "8.6.0"
  });
  const target = deriveElectronProductionExpectedLatestState(staged);
  const observedTarget = observedFromProjection(target);
  const intent = createElectronProductionPublicationIntent({
    transactionId: TRANSACTION_ID,
    recordedAt: "2026-09-01T00:00:00Z",
    lease: { id: LEASE_ID, generation: 1 },
    baseline: {
      runtime: "tauri-v22",
      version: source.latestJson.version,
      releaseTag: source.release.tag,
      sourceSha: SOURCE_SHA,
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
  const heldLease = acquireElectronProductionPublicLatestLease({
    holder: {
      repository: "rion-tw/rion-studio-source",
      workflow: ".github/workflows/electron-production-provisional-publish.yml",
      runId: "7001",
      runAttempt: 2,
      headSha: CONTROL_SHA
    },
    leaseId: LEASE_ID,
    previous: null,
    purpose: "electron-v23-provisional-publication",
    recordedAt: "2026-09-01T00:00:00Z",
    source: {
      runtime: "tauri-v22",
      version: source.latestJson.version,
      stateSha256: source.stateSha256
    },
    target: {
      runtime: "electron-v23",
      version: target.latestJson.version,
      stateSha256: target.stateSha256
    },
    transactionId: TRANSACTION_ID,
    vacantGeneration: 0
  });
  const storeSeal = createElectronProductionPublicationRecoveryStoreSeal({
    capsuleBytes: 4096,
    capsuleSha256: digest("packed recovery capsule"),
    capsuleManifestBytes: 2048,
    capsuleManifestSha256: digest("recovery capsule manifest"),
    durableStore: {
      repository: "alternate-owner/recovery-vault",
      ref: "recovery-capsules",
      path: `transactions/${TRANSACTION_ID}/electron-production-publication-recovery-capsule.capsule.json`,
      repositoryPolicy: {
        defaultBranch: "recovery-capsules",
        visibility: "private"
      },
      byteLength: 4096,
      blobSha: "5".repeat(40),
      treeSha: "6".repeat(40),
      parentCommitSha: "7".repeat(40),
      commitSha: "4".repeat(40),
      remoteReceiptSha256: digest("durable store applied operation"),
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
      controlSha: CONTROL_SHA
    }
  });
  return { heldLease, intent, observedTarget, source, storeSeal, target };
}

function createOutcome(
  fixture: ReturnType<typeof recoveryFixture>,
  input: Readonly<{
    before: ReturnType<typeof makeObservedSnapshot> | null;
    final: ReturnType<typeof makeObservedSnapshot> | null;
    mutation: ElectronProductionPublicationRecoveryMutation;
    leaseRelease: ElectronProductionPublicationRecoveryLeaseRelease;
  }>
): Readonly<ElectronProductionPublicationRecoveryOutcome> {
  return createElectronProductionPublicationRecoveryOutcome(
    outcomeInput(fixture, input)
  );
}

function outcomeInput(
  fixture: ReturnType<typeof recoveryFixture>,
  input: Readonly<{
    before: ReturnType<typeof makeObservedSnapshot> | null;
    final: ReturnType<typeof makeObservedSnapshot> | null;
    mutation: ElectronProductionPublicationRecoveryMutation;
    leaseRelease: ElectronProductionPublicationRecoveryLeaseRelease;
  }>
) {
  return {
    beforeMutation: {
      observedAt: "2026-09-01T00:04:00Z",
      snapshot: input.before
    },
    determinedAt: "2026-09-01T00:09:00Z",
    finalObservation: {
      observedAt: "2026-09-01T00:07:00Z",
      snapshot: input.final
    },
    heldLease: fixture.heldLease,
    leaseRelease: input.leaseRelease,
    mutation: input.mutation,
    previousOutcomeSha256: null,
    recoveryOperation: {
      kind: input.mutation.kind === "rollback"
        ? ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_ROLLBACK_KIND
        : ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_KIND,
      sha256: digest(`authoritative ${input.mutation.kind} operation`)
    },
    recoveryRun: recoveryRun(),
    sourceSnapshot: fixture.source,
    storeSeal: fixture.storeSeal,
    targetSnapshot: fixture.target
  };
}

function recoveryRun() {
  return {
    repository: "rion-tw/rion-studio-source",
    workflow: ".github/workflows/recover-electron-publication.yml",
    runId: "9001",
    runAttempt: 3,
    controlSha: RECOVERY_CONTROL_SHA,
    startedAt: "2026-09-01T00:03:00Z"
  };
}

function noMutation(): ElectronProductionPublicationRecoveryMutation {
  return {
    kind: "none",
    submitted: false,
    acknowledgement: null,
    submittedAt: null,
    resultRecordedAt: null
  };
}

function rollbackMutation(
  acknowledgement: "confirmed" | "rejected" | "unknown"
): ElectronProductionPublicationRecoveryMutation {
  return {
    kind: "rollback",
    submitted: true,
    acknowledgement,
    submittedAt: "2026-09-01T00:05:00Z",
    resultRecordedAt: "2026-09-01T00:06:00Z"
  };
}

function noLeaseRelease(): ElectronProductionPublicationRecoveryLeaseRelease {
  return {
    attempted: false,
    acknowledgement: null,
    attemptedAt: null,
    operationSha256: null,
    resolvedAt: null,
    successorEventSha256: null
  };
}

function confirmedLeaseRelease(): ElectronProductionPublicationRecoveryLeaseRelease {
  return {
    attempted: true,
    acknowledgement: "confirmed",
    attemptedAt: "2026-09-01T00:08:00Z",
    operationSha256: digest("confirmed lease release operation"),
    resolvedAt: "2026-09-01T00:08:00Z",
    successorEventSha256: digest("released lease successor event")
  };
}

function markerRecoveryOperation(
  operation: "release-held-lease" | "rollback-public-latest",
  mode: "actual-transport" | "marker-reconciliation",
  authority: Readonly<{ attemptSha256: string; authorizationSha256: string }>
) {
  return {
    kind:
      "rion-electron-production-publication-recovery-public-mutation-operation" as const,
    operation,
    mode,
    authority,
    sha256: digest(`${operation}:${mode}:operation`)
  };
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
      digest(`${input.version}:${name}`)
    ])
  );
  const assets = ELECTRON_PRODUCTION_PUBLIC_RELEASE_ASSET_NAMES.map((name, index) => ({
    bytes: 100 + index,
    contentType: contentType(name),
    digest: `sha256:${digests[name]}`,
    id: String(input.idBase + index),
    name,
    url: `https://github.com/rion-tw/rion-studio/releases/download/${tag}/${encodeURIComponent(name)}`
  }));
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
  const stateSha256 = digest(serializeCanonicalJson(state));
  const body = { ...state, observationKind: "observed-release", stateSha256 };
  return assertElectronProductionPublicLatestSnapshot({
    ...body,
    snapshotSha256: digest(serializeCanonicalJson(body))
  });
}

function observedFromProjection(target: ReturnType<
  typeof deriveElectronProductionExpectedLatestState
>) {
  const body = {
    schemaVersion: target.schemaVersion,
    kind: target.kind,
    observationKind: "observed-release",
    repository: target.repository,
    release: target.release,
    assets: target.assets,
    latestJson: target.latestJson,
    candidateReceipt: target.candidateReceipt,
    stateSha256: target.stateSha256
  };
  return assertElectronProductionPublicLatestSnapshot({
    ...body,
    snapshotSha256: digest(serializeCanonicalJson(body))
  });
}

function candidateSummary(version: string) {
  return {
    assets: {} as Record<string, string>,
    bytes: 512,
    fileName: "electron-production-candidate-receipt.json" as const,
    publicKeySha256: "b".repeat(64),
    sha256: digest(`candidate:${version}`),
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

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "rion-recovery-outcome-"));
  temporaryDirectories.push(directory);
  return directory;
}

function digest(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}
