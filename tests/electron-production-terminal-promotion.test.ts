import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { serializeCanonicalJson } from "../scripts/canonicalJson.mjs";
import {
  assertElectronProductionPublicLatestSnapshot,
  type ElectronProductionPublicLatestSnapshot
} from "../scripts/electronProductionPublicLatestSnapshot.mjs";
import {
  ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_FILE,
  electronProductionPublicLatestLeaseEventSha256,
  releaseElectronProductionPublicLatestLease,
  serializeElectronProductionPublicLatestLease,
  writeElectronProductionPublicLatestLease
} from "../scripts/electronProductionPublicLatestLease.mjs";
import {
  createElectronProductionPublicLatestRecoveryObservation,
  ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_FILE,
  writeElectronProductionPublicLatestRecoveryObservation
} from "../scripts/electronProductionPublicLatestRecovery.mjs";
import {
  writeElectronProductionPublicLatestSnapshot
} from "../scripts/electronProductionPublicLatestSnapshot.mjs";
import {
  ELECTRON_PRODUCTION_PUBLICATION_RECEIPT_NAMES,
  writeElectronProductionPublicationReceipt
} from "../scripts/electronProductionPublicationReceipt.mjs";
import {
  createElectronProductionPublicationIntentFromSnapshots,
  recordElectronProductionPublicationResult
} from "../scripts/electronProductionPublicationTransaction.mjs";
import {
  createElectronProductionTerminalPromotion,
  ELECTRON_PRODUCTION_TERMINAL_PROMOTION_APPROVAL,
  ELECTRON_PRODUCTION_TERMINAL_PROMOTION_RECEIPT,
  electronProductionTerminalPromotionSha256,
  readElectronProductionTerminalPromotion,
  writeElectronProductionTerminalPromotion,
  type ElectronProductionTerminalPromotionInput
} from "../scripts/electronProductionTerminalPromotion.mjs";
import {
  runElectronProductionTerminalPromotionCli
} from "../scripts/electronProductionTerminalPromotionCli.mjs";
import {
  createPublicLatestRecoveryFixture
} from "./support/electronProductionPublicLatestRecoveryFixture";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("Electron production terminal promotion", () => {
  it("records promoted only after exact target observations bracket a confirmed lease release", async () => {
    const input = await terminalPromotionInput();
    const receipt = createElectronProductionTerminalPromotion(input);

    expect(receipt).toMatchObject({
      status: "terminal-promotion-recorded",
      terminal: true,
      outcome: "promoted",
      candidate: {
        version: input.targetSnapshot.latestJson.version,
        releaseTag: input.targetSnapshot.release.tag
      },
      publication: {
        transactionId: input.heldLease.transactionId,
        preReleaseObservation: {
          receipt: { observation: { classification: "target" } }
        },
        finalObservation: {
          receipt: { observation: { classification: "target" } }
        }
      },
      lease: {
        release: {
          acknowledgement: "confirmed",
          command: "release",
          successor: { revision: input.heldLease.revision + 1 }
        }
      },
      compatibility: {
        macosAppKitRetained: true,
        windowsEvidenceIndependent: true
      }
    });
  });

  it("rejects a source, foreign, or unknown pre-release observation", async () => {
    const input = await terminalPromotionInput();
    const sourceObservation = recoveryObservation(
      observationFixture(input),
      "source",
      "2026-09-01T00:04:00Z"
    );

    expect(() => createElectronProductionTerminalPromotion({
      ...input,
      preReleaseObservation: sourceObservation
    })).toThrow("must be an exact target observation");

    const unknownObservation = recoveryObservation(
      observationFixture(input),
      "unknown",
      "2026-09-01T00:04:00Z"
    );
    expect(() => createElectronProductionTerminalPromotion({
      ...input,
      preReleaseObservation: unknownObservation
    })).toThrow("must be an exact target observation");
  });

  it("never converts an unknown lease acknowledgement into promoted", async () => {
    const input = await terminalPromotionInput();
    const remote = {
      ...input.leaseRemoteOperation,
      outcome: "indeterminate" as const,
      reason: "unknown-acknowledgement" as const,
      httpStatus: null,
      remote: { ...input.leaseRemoteOperation.remote, blobSha: null },
      lease: null,
      output: null
    };

    expect(() => createElectronProductionTerminalPromotion({
      ...input,
      leaseRemoteOperation: remote
    })).toThrow("confirmed lease release acknowledgement");
  });

  it("accepts a later exact observe-release acknowledgement for the same successor", async () => {
    const input = await terminalPromotionInput();
    const reconciled = {
      ...input.leaseRemoteOperation,
      command: "observe-release" as const,
      outcome: "observed" as const
    };
    const receipt = createElectronProductionTerminalPromotion({
      ...input,
      leaseReleaseResolvedAt: "2026-09-01T00:05:30Z",
      leaseRemoteOperation: reconciled
    });

    expect(receipt.lease.release).toMatchObject({
      command: "observe-release",
      acknowledgement: "confirmed",
      attemptedAt: "2026-09-01T00:05:00.000Z",
      resolvedAt: "2026-09-01T00:05:30.000Z"
    });
  });

  it("rejects a final observation that no longer names the target", async () => {
    const input = await terminalPromotionInput();
    const sourceObservation = recoveryObservation(
      observationFixture(input),
      "source",
      "2026-09-01T00:06:00Z"
    );

    expect(() => createElectronProductionTerminalPromotion({
      ...input,
      finalObservation: sourceObservation
    })).toThrow("must be an exact target observation");
  });

  it("rejects readiness that is rebound away from the provisional transaction", async () => {
    const input = await terminalPromotionInput();
    const readiness = structuredClone(input.readinessReceipt) as
      ReturnType<typeof promotionReadiness>;
    readiness.provisionalPublication.transactionId =
      "018f47a0-2d3e-7abc-8def-1234567890ff";
    const source = Buffer.from(`${JSON.stringify(readiness, null, 2)}\n`);

    expect(() => createElectronProductionTerminalPromotion({
      ...input,
      readinessReceipt: readiness,
      readinessReceiptIdentity: {
        bytes: source.length,
        sha256: sha256(source)
      }
    })).toThrow("provisional transaction ID");
  });

  it("writes and rereads one canonical create-new terminal receipt", async () => {
    const input = await terminalPromotionInput();
    const receipt = createElectronProductionTerminalPromotion(input);
    const root = await mkdtemp(path.join(tmpdir(), "rion-terminal-promotion-"));
    temporaryDirectories.push(root);
    const outputPath = path.join(
      root,
      ELECTRON_PRODUCTION_TERMINAL_PROMOTION_RECEIPT
    );

    const written = await writeElectronProductionTerminalPromotion({
      outputPath,
      receipt
    });
    expect(written.receiptIdentity.sha256).toBe(
      electronProductionTerminalPromotionSha256(receipt)
    );
    await expect(readElectronProductionTerminalPromotion({
      expectedSha256: written.receiptIdentity.sha256,
      receiptPath: outputPath
    })).resolves.toMatchObject({ receipt: { outcome: "promoted" } });
    await expect(writeElectronProductionTerminalPromotion({
      outputPath,
      receipt
    })).rejects.toThrow("must be create-new");
    await expect(readElectronProductionTerminalPromotion({
      expectedSha256: "0".repeat(64),
      receiptPath: outputPath
    })).rejects.toThrow("receipt SHA-256");
  });

  it("finalizes through the CLI only from exact hashed input files", async () => {
    const input = await terminalPromotionInput();
    const root = await mkdtemp(path.join(tmpdir(), "rion-terminal-cli-"));
    temporaryDirectories.push(root);
    const preRoot = path.join(root, "pre");
    const finalRoot = path.join(root, "final");
    await Promise.all([mkdir(preRoot), mkdir(finalRoot)]);
    const readinessPath = path.join(
      root,
      "electron-production-promotion-readiness-receipt.json"
    );
    const readinessSource = Buffer.from(
      `${JSON.stringify(input.readinessReceipt, null, 2)}\n`
    );
    await writeFile(readinessPath, readinessSource, { flag: "wx" });
    const provisional = await writeElectronProductionPublicationReceipt({
      outputPath: path.join(
        root,
        ELECTRON_PRODUCTION_PUBLICATION_RECEIPT_NAMES.provisional
      ),
      receipt: input.provisionalPublicationReceipt
    });
    const source = await writeElectronProductionPublicLatestSnapshot({
      outputPath: path.join(root, "source-public-latest-snapshot.json"),
      snapshot: input.sourceSnapshot
    });
    const target = await writeElectronProductionPublicLatestSnapshot({
      outputPath: path.join(root, "target-public-latest-projection.json"),
      snapshot: input.targetSnapshot
    });
    const held = await writeElectronProductionPublicLatestLease({
      outputPath: path.join(
        root,
        ELECTRON_PRODUCTION_PUBLIC_LATEST_LEASE_FILE
      ),
      lease: input.heldLease
    });
    const pre = await writeElectronProductionPublicLatestRecoveryObservation({
      outputPath: path.join(
        preRoot,
        ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_FILE
      ),
      receipt: input.preReleaseObservation
    });
    const final =
      await writeElectronProductionPublicLatestRecoveryObservation({
        outputPath: path.join(
          finalRoot,
          ELECTRON_PRODUCTION_PUBLIC_LATEST_RECOVERY_OBSERVATION_FILE
        ),
        receipt: input.finalObservation
      });
    const remotePath = path.join(root, "lease-remote-operation.json");
    const remoteSource = serializeCanonicalJson(input.leaseRemoteOperation);
    await writeFile(remotePath, remoteSource, { flag: "wx" });
    const outputPath = path.join(
      root,
      ELECTRON_PRODUCTION_TERMINAL_PROMOTION_RECEIPT
    );

    const result = await runElectronProductionTerminalPromotionCli([
      "finalize",
      "--readiness-receipt", readinessPath,
      "--readiness-receipt-sha256", sha256(readinessSource),
      "--provisional-publication-receipt", provisional.receiptPath,
      "--provisional-publication-receipt-sha256",
      provisional.receiptIdentity.sha256,
      "--source-snapshot", path.join(root, "source-public-latest-snapshot.json"),
      "--source-snapshot-sha256", source.file.sha256,
      "--target-snapshot", path.join(root, "target-public-latest-projection.json"),
      "--target-snapshot-sha256", target.file.sha256,
      "--held-lease", held.leasePath,
      "--held-lease-sha256", held.leaseIdentity.sha256,
      "--pre-release-observation", pre.receiptPath,
      "--pre-release-observation-sha256", pre.receiptIdentity.sha256,
      "--lease-remote-operation", remotePath,
      "--lease-remote-operation-sha256", sha256(remoteSource),
      "--lease-release-resolved-at", input.leaseReleaseResolvedAt,
      "--final-observation", final.receiptPath,
      "--final-observation-sha256", final.receiptIdentity.sha256,
      "--finalized-at", input.finalizedAt,
      "--owner-approval", input.ownerApproval,
      "--output", outputPath
    ], {
      GITHUB_REPOSITORY: "rion-tw/rion-studio-source",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_RUN_ID: "9001",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_SHA: "f".repeat(40)
    });

    expect(result.receipt).toMatchObject({
      outcome: "promoted",
      readiness: { sha256: sha256(readinessSource) }
    });
  });
});

async function terminalPromotionInput(): Promise<
  ElectronProductionTerminalPromotionInput
> {
  const root = await mkdtemp(path.join(tmpdir(), "rion-terminal-input-"));
  temporaryDirectories.push(root);
  const fixture = await createPublicLatestRecoveryFixture(root);
  const provisional = provisionalPublication(fixture);
  const readinessReceipt = promotionReadiness(fixture, provisional);
  const readinessSource = Buffer.from(
    `${JSON.stringify(readinessReceipt, null, 2)}\n`
  );
  const preReleaseObservation = recoveryObservation(
    fixture,
    "target",
    "2026-09-01T00:04:00Z"
  );
  const attemptedAt = "2026-09-01T00:05:00Z";
  return {
    finalObservation: recoveryObservation(
      fixture,
      "target",
      "2026-09-01T00:06:00Z"
    ),
    finalizedAt: "2026-09-01T00:07:00Z",
    heldLease: fixture.heldLease,
    heldLeaseFileSha256: sha256(
      serializeElectronProductionPublicLatestLease(fixture.heldLease)
    ),
    leaseReleaseResolvedAt: attemptedAt,
    leaseRemoteOperation: confirmedRemoteRelease(fixture, attemptedAt),
    ownerApproval: ELECTRON_PRODUCTION_TERMINAL_PROMOTION_APPROVAL,
    preReleaseObservation,
    producer: {
      repository: "rion-tw/rion-studio-source",
      workflow:
        ".github/workflows/electron-production-terminal-promotion.yml",
      event: "workflow_dispatch",
      runId: "9001",
      runAttempt: 1,
      controlSha: "f".repeat(40),
      producedAt: "2026-09-01T00:07:00Z"
    },
    provisionalPublicationReceipt: provisional,
    provisionalPublicationReceiptSha256: sha256(
      serializeCanonicalJson(provisional)
    ),
    readinessReceipt,
    readinessReceiptIdentity: {
      bytes: readinessSource.length,
      sha256: sha256(readinessSource)
    },
    sourceSnapshot: fixture.source,
    sourceSnapshotFileSha256: fixture.sourceFileSha256,
    targetSnapshot: fixture.target,
    targetSnapshotFileSha256: fixture.targetFileSha256
  };
}

function provisionalPublication(
  fixture: Awaited<ReturnType<typeof createPublicLatestRecoveryFixture>>
) {
  const lineage = {
    manifestSha256: fixture.source.latestJson.sha256,
    releaseTag: fixture.source.release.tag,
    runtime: "tauri-v22" as const,
    sourceSha: "1".repeat(40),
    version: fixture.source.latestJson.version
  };
  const intent = createElectronProductionPublicationIntentFromSnapshots({
    baselineLineage: lineage,
    lease: {
      id: fixture.heldLease.leaseId,
      generation: fixture.heldLease.generation
    },
    recordedAt: "2026-09-01T00:00:00Z",
    sourceSnapshot: fixture.source,
    targetSnapshot: fixture.target,
    transactionId: fixture.heldLease.transactionId
  });
  return recordElectronProductionPublicationResult({
    acknowledgement: "confirmed",
    lease: {
      id: fixture.heldLease.leaseId,
      generation: fixture.heldLease.generation,
      status: "held",
      foreignLeaseId: null,
      foreignLeaseGeneration: null
    },
    observedSnapshot: fixture.observedTarget,
    previousReceipt: intent,
    recordedAt: "2026-09-01T00:01:00Z",
    sourceSnapshot: fixture.source,
    targetSnapshot: fixture.target
  });
}

function promotionReadiness(
  fixture: Awaited<ReturnType<typeof createPublicLatestRecoveryFixture>>,
  provisional: ReturnType<typeof provisionalPublication>
) {
  const candidate = fixture.target.candidateReceipt!;
  const provenance = {
    candidateRunControlSha: "1".repeat(40),
    candidateRunAttempt: 1,
    candidateRunId: "101",
    evidenceRunControlSha: "2".repeat(40),
    evidenceRunAttempt: 1,
    evidenceRunId: "102",
    priorCandidateRunControlSha: "3".repeat(40),
    priorCandidateRunAttempt: 1,
    priorCandidateRunId: "103",
    provisionalPublicationRunControlSha: "4".repeat(40),
    provisionalPublicationRunAttempt: 1,
    provisionalPublicationRunId: "104",
    readinessControlSha: "5".repeat(40),
    repository: "rion-tw/rion-studio-source" as const,
    tauriLineageRunControlSha: "6".repeat(40),
    tauriLineageRunAttempt: 1,
    tauriLineageRunId: "105"
  };
  const evidence = Object.fromEntries([
    "tauri-v22-to-electron-v23",
    "electron-v23-to-electron-v23"
  ].map((transition, transitionIndex) => [
    transition,
    Object.fromEntries([
      "darwin-aarch64",
      "windows-x86_64"
    ].map((platform, platformIndex) => {
      const sequence = transitionIndex * 2 + platformIndex + 1;
      return [platform, {
        receiptSha256: sequence.toString(16).repeat(64).slice(0, 64),
        evidenceAttemptId:
          `018f47a0-2d3e-7abc-8def-12345678910${sequence}`,
        sourceInstallAttemptId: transitionIndex === 0
          ? `update-install-${sequence}`
          : `update-install-018f47a0-2d3e-7abc-8def-12345678910${sequence}`,
        completedAt: "2026-09-01T00:02:00Z",
        source: { version: transitionIndex === 0 ? "8.4.2" : "8.5.0" },
        target: {
          version: candidate.version,
          sourceSha: candidate.sourceSha
        },
        producer: { runId: "102" },
        attachments: {},
        sourceFetchEndpoint: "https://example.test/latest.json",
        sourceFetchFinalUrlSha256: "a".repeat(64),
        sourceFetchMode: "direct",
        terminalOutcome: "applied"
      }];
    }))
  ]));
  return {
    schemaVersion: 4 as const,
    kind: "rion-electron-production-promotion-readiness" as const,
    status: "verified-terminal-evidence" as const,
    publication: {
      allowedByThisWorkflow: false as const,
      status: "externally-served-terminal-evidence-observed" as const,
      terminalPromotionReceipt: false as const
    },
    ownerGate: {
      approval: "VERIFY ELECTRON PRODUCTION PROMOTION READINESS",
      environment: "electron-production-release" as const
    },
    candidate: {
      receiptFileName: "electron-production-candidate-receipt.json" as const,
      receiptSha256: candidate.sha256,
      trustedControlReceiptSha256: "b".repeat(64),
      sourceSha: candidate.sourceSha,
      version: candidate.version,
      updaterBaseUrl: candidate.updaterBaseUrl,
      updaterEndpoint: candidate.updaterEndpoint,
      publicKeySha256: candidate.publicKeySha256,
      assets: candidate.assets
    },
    priorElectronCandidate: {
      receiptSha256: "c".repeat(64),
      trustedControlReceiptSha256: "d".repeat(64),
      sourceSha: "e".repeat(40),
      version: "8.5.0",
      updaterEndpoint: candidate.updaterEndpoint,
      publicKeySha256: candidate.publicKeySha256,
      assets: candidate.assets
    },
    provisionalPublication: {
      receiptFileName:
        "electron-production-publication-provisional-receipt.json" as const,
      receiptSha256: sha256(serializeCanonicalJson(provisional)),
      transactionId: provisional.transactionId,
      revision: provisional.revision,
      previousEventSha256: provisional.previousEventSha256!,
      phase: "provisional" as const,
      terminal: false as const,
      outcome: null,
      baseline: provisional.baseline,
      target: provisional.target,
      lease: provisional.lease,
      publication: provisional.publication,
      recordedAt: provisional.recordedAt,
      producer: {
        artifactName:
          `electron-production-publication-provisional-${candidate.version}-${candidate.sourceSha}-attempt-1`,
        repository: "rion-tw/rion-studio-source" as const,
        workflow:
          ".github/workflows/electron-production-provisional-publish.yml" as const,
        runId: "104",
        runAttempt: 1,
        sourceSha: candidate.sourceSha
      }
    },
    tauriV22PublicLineage: { bound: true },
    provenance,
    challenge: {
      id: "018f47a0-2d3e-7abc-8def-1234567890ad",
      nonceSha256: "f".repeat(64),
      issuedAt: "2026-09-01T00:00:00Z",
      expiresAt: "2026-09-01T01:00:00Z"
    },
    evidence,
    compatibility: {
      macosAppKitRetained: true as const,
      stableTauriReleasePath:
        "retained-as-rollback-source-until-terminal-promotion" as const,
      windowsEvidenceIndependent: true as const
    },
    verifiedAt: "2026-09-01T00:03:00Z"
  };
}

function recoveryObservation(
  fixture: Pick<
    Awaited<ReturnType<typeof createPublicLatestRecoveryFixture>>,
    | "observedTarget"
    | "source"
    | "sourceFileSha256"
    | "target"
    | "targetFileSha256"
  >,
  classification: "source" | "target" | "unknown",
  observedAt: string
) {
  const result = classification === "unknown"
    ? {
        outcome: "indeterminate" as const,
        reason: "transport" as const,
        status: null,
        latest: null
      }
    : {
        outcome: "observed" as const,
        latest: {
          releaseId: classification === "source"
            ? fixture.source.release.id
            : fixture.target.release.id,
          updatedAt: observedAt
        },
        snapshot: classification === "source"
          ? fixture.source
          : fixture.observedTarget
      };
  return createElectronProductionPublicLatestRecoveryObservation({
    observedAt,
    result,
    sourceSnapshot: fixture.source,
    sourceSnapshotFileSha256: fixture.sourceFileSha256,
    targetSnapshot: fixture.target,
    targetSnapshotFileSha256: fixture.targetFileSha256
  });
}

function observationFixture(input: ElectronProductionTerminalPromotionInput) {
  return {
    observedTarget: observedTargetFromProjection(input.targetSnapshot),
    source: input.sourceSnapshot,
    sourceFileSha256: input.sourceSnapshotFileSha256,
    target: input.targetSnapshot,
    targetFileSha256: input.targetSnapshotFileSha256
  };
}

function observedTargetFromProjection(
  target: ElectronProductionPublicLatestSnapshot
) {
  const state = {
    schemaVersion: target.schemaVersion,
    kind: target.kind,
    repository: target.repository,
    release: target.release,
    assets: target.assets,
    latestJson: target.latestJson,
    candidateReceipt: target.candidateReceipt
  };
  const body = {
    ...state,
    observationKind: "observed-release",
    stateSha256: target.stateSha256
  };
  return assertElectronProductionPublicLatestSnapshot({
    ...body,
    snapshotSha256: sha256(serializeCanonicalJson(body))
  });
}

function confirmedRemoteRelease(
  fixture: Awaited<ReturnType<typeof createPublicLatestRecoveryFixture>>,
  attemptedAt: string
) {
  const released = releaseElectronProductionPublicLatestLease(
    fixture.heldLease,
    {
      transactionId: fixture.heldLease.transactionId,
      leaseId: fixture.heldLease.leaseId,
      generation: fixture.heldLease.generation,
      sourceStateSha256: fixture.heldLease.source.stateSha256,
      targetStateSha256: fixture.heldLease.target.stateSha256,
      recordedAt: attemptedAt
    }
  );
  const source = serializeElectronProductionPublicLatestLease(released);
  return {
    schemaVersion: 1 as const,
    kind: "rion-electron-production-public-latest-lease-remote-operation" as const,
    command: "release" as const,
    request: {
      attemptedAt,
      held: {
        transactionId: fixture.heldLease.transactionId,
        leaseId: fixture.heldLease.leaseId,
        generation: fixture.heldLease.generation,
        revision: fixture.heldLease.revision,
        eventSha256:
          electronProductionPublicLatestLeaseEventSha256(fixture.heldLease),
        sourceStateSha256: fixture.heldLease.source.stateSha256,
        targetStateSha256: fixture.heldLease.target.stateSha256
      }
    },
    outcome: "applied" as const,
    reason: null,
    httpStatus: 200,
    remote: {
      repository: "rion-tw/rion-studio" as const,
      ref: "main" as const,
      path:
        "releases/electron-production-public-latest-lease.json" as const,
      blobSha: gitBlobSha(source)
    },
    lease: {
      transactionId: released.transactionId,
      leaseId: released.leaseId,
      generation: released.generation,
      revision: released.revision,
      status: "released" as const,
      eventSha256: electronProductionPublicLatestLeaseEventSha256(released)
    },
    output: {
      bytes: source.length,
      fileName: "electron-production-public-latest-lease.json" as const,
      sha256: sha256(source)
    }
  };
}

function gitBlobSha(source: Buffer) {
  return createHash("sha1")
    .update(`blob ${source.length}\0`)
    .update(source)
    .digest("hex");
}

function sha256(source: string | Buffer) {
  return createHash("sha256").update(source).digest("hex");
}
