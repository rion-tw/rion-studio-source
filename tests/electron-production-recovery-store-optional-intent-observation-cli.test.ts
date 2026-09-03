import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createElectronProductionPublicLatestRecoveryObservation,
  electronProductionPublicLatestRecoveryObservationSha256
} from "../scripts/electronProductionPublicLatestRecovery.mjs";
import {
  createElectronProductionPublicationRecoveryLeaseReleaseIntent,
  electronProductionPublicationRecoveryLeaseReleaseIntentPath,
  serializeElectronProductionPublicationRecoveryLeaseReleaseIntent
} from "../scripts/electronProductionPublicationRecoveryLeaseReleaseIntent.mjs";
import {
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_CHAIN_PROOF_FILE,
  ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_DISCOVERY_FILE,
  electronProductionPublicationRecoveryOutcomeDiscoverySha256,
  verifyElectronProductionPublicationRecoveryOutcomeChain,
  writeElectronProductionPublicationRecoveryOutcomeChainProof,
  writeElectronProductionPublicationRecoveryOutcomeDiscovery
} from "../scripts/electronProductionPublicationRecoveryOutcomeDiscovery.mjs";
import {
  createElectronProductionPublicationRecoveryPublicMutationAttempt,
  electronProductionPublicationRecoveryPublicMutationAttemptPath,
  serializeElectronProductionPublicationRecoveryPublicMutationAttempt
} from "../scripts/electronProductionPublicationRecoveryPublicMutationAttempt.mjs";
import {
  ELECTRON_PRODUCTION_RECOVERY_STORE_OPTIONAL_INTENT_OBSERVATION_FILE,
  ELECTRON_PRODUCTION_RECOVERY_STORE_OPTIONAL_PUBLIC_MUTATION_ATTEMPT_OBSERVATION_FILE,
  readElectronProductionRecoveryStoreOptionalPublicMutationAttemptObservation,
  readElectronProductionRecoveryStoreOptionalIntentObservation,
  runElectronProductionRecoveryStoreOptionalIntentObservationCli
} from "../scripts/electronProductionRecoveryStoreOptionalIntentObservationCli.mjs";
import {
  createLeaseReleaseAuthorizationFixture
} from "./support/electronProductionPublicationRecoveryLeaseReleaseAuthorizationFixture";
import {
  createOutcomeDiscoveryFixture
} from "./support/electronProductionPublicationRecoveryOutcomeDiscoveryFixture";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("recovery-store optional intent observation CLI", () => {
  it("proves absence at the exact outcome-discovery head", async () => {
    const setup = await createSetup();
    const readRemote = vi.fn(async () => ({
      outcome: "absent" as const,
      commitMessage: "recovery head",
      headSha: setup.discovery.currentObservation.headCommitSha,
      treeSha: setup.discovery.currentObservation.treeSha,
      parentShas: setup.discovery.currentObservation.parentCommitShas
    }));
    const stdout: Buffer[] = [];

    const summary =
      await runElectronProductionRecoveryStoreOptionalIntentObservationCli(
        argumentsList(setup),
        {
          environment: { GH_TOKEN: "private-reader-token" },
          fetchImpl: vi.fn(),
          readRemote,
          writeStdout: (source) => {
            stdout.push(source);
          }
        }
      );

    expect(readRemote).toHaveBeenCalledWith(expect.objectContaining({
      token: "private-reader-token",
      target: expect.objectContaining({ path: setup.intentPath })
    }));
    expect(summary).toMatchObject({
      status: "verified",
      currentObservation: setup.discovery.currentObservation,
      intent: { status: "absent-at-head" }
    });
    if (summary.command !== "observe") {
      throw new Error("Expected an optional-intent observe summary.");
    }
    const receipt =
      await readElectronProductionRecoveryStoreOptionalIntentObservation({
        observationPath: setup.output,
        expectedSha256: summary.output.sha256
      });
    expect(receipt.value.intent).toEqual({ status: "absent-at-head" });
    expect(stdout[0]!.toString("utf8")).not.toContain("private-reader-token");

    const verified =
      await runElectronProductionRecoveryStoreOptionalIntentObservationCli([
        "verify",
        "--discovery", setup.discoveryPath,
        "--discovery-sha256", setup.discoverySha256,
        "--observation", setup.output,
        "--observation-sha256", summary.output.sha256
      ], { writeStdout: () => undefined });
    expect(verified).toMatchObject({
      command: "verify",
      status: "verified",
      currentObservation: setup.discovery.currentObservation,
      intent: { status: "absent-at-head" }
    });
  });

  it("proves a canonical existing intent by identity without exposing content", async () => {
    const setup = await createSetup();
    const intent = createElectronProductionPublicationRecoveryLeaseReleaseIntent({
      heldLease: setup.fixture.heldLease,
      heldLeaseSha256: setup.fixture.foundation.heldLeaseSha256,
      storeSeal: setup.fixture.storeSeal,
      storeSealSha256: setup.fixture.foundation.storeSealSha256,
      chainProof: setup.chainProof,
      chainProofSha256: setup.chainProofSha256,
      recoveryRun: {
        repository: "rion-tw/rion-studio-source",
        workflow:
          ".github/workflows/electron-production-provisional-recovery.yml",
        runId: "9901",
        runAttempt: 1,
        controlSha: "e".repeat(40),
        startedAt: "2026-09-01T01:01:00Z"
      },
      authorizedAt: "2026-09-01T01:02:00Z"
    });
    const source =
      serializeElectronProductionPublicationRecoveryLeaseReleaseIntent(intent);

    const summary =
      await runElectronProductionRecoveryStoreOptionalIntentObservationCli(
        argumentsList(setup),
        {
          environment: { GH_TOKEN: "private-reader-token" },
          fetchImpl: vi.fn(),
          readRemote: async () => ({
            outcome: "present",
            commitMessage: "recovery intent",
            headSha: setup.discovery.currentObservation.headCommitSha,
            treeSha: setup.discovery.currentObservation.treeSha,
            parentShas: setup.discovery.currentObservation.parentCommitShas,
            blobSha: gitBlobSha(source),
            byteLength: source.length,
            contentBase64: source.toString("base64")
          }),
          writeStdout: () => undefined
        }
      );

    if (summary.command !== "observe") {
      throw new Error("Expected an optional-intent observe summary.");
    }
    expect(summary.intent).toEqual({
      status: "present-at-head",
      blobSha: gitBlobSha(source),
      file: {
        fileName:
          "electron-production-publication-recovery-lease-release-intent.json",
        byteLength: source.length,
        sha256: sha256(source)
      }
    });
    const serializedReceipt = await readFile(setup.output, "utf8");
    expect(serializedReceipt).not.toContain(source.toString("base64"));
    expect(serializedReceipt).not.toContain(intent.recoveryRun.controlSha);
  });

  it("rejects a moved head, foreign intent, and indeterminate read", async () => {
    const moved = await createSetup();
    await expect(
      runElectronProductionRecoveryStoreOptionalIntentObservationCli(
        argumentsList(moved),
        dependencies(moved, {
          outcome: "absent",
          commitMessage: "moved",
          headSha: "f".repeat(40),
          treeSha: moved.discovery.currentObservation.treeSha,
          parentShas: moved.discovery.currentObservation.parentCommitShas
        })
      )
    ).rejects.toThrow("not from the outcome-discovery head");

    const indeterminate = await createSetup();
    await expect(
      runElectronProductionRecoveryStoreOptionalIntentObservationCli(
        argumentsList(indeterminate),
        dependencies(indeterminate, {
          outcome: "indeterminate",
          reason: "transport",
          status: null
        })
      )
    ).rejects.toThrow("was not authoritative");

    const foreign = await createSetup();
    const intent = createElectronProductionPublicationRecoveryLeaseReleaseIntent({
      heldLease: foreign.fixture.heldLease,
      heldLeaseSha256: foreign.fixture.foundation.heldLeaseSha256,
      storeSeal: foreign.fixture.storeSeal,
      storeSealSha256: foreign.fixture.foundation.storeSealSha256,
      chainProof: foreign.chainProof,
      chainProofSha256: foreign.chainProofSha256,
      recoveryRun: {
        repository: "rion-tw/rion-studio-source",
        workflow:
          ".github/workflows/electron-production-provisional-recovery.yml",
        runId: "9902",
        runAttempt: 1,
        controlSha: "e".repeat(40),
        startedAt: "2026-09-01T01:01:00Z"
      },
      authorizedAt: "2026-09-01T01:02:00Z"
    });
    const raw = structuredClone(intent) as unknown as {
      transactionId: string;
    };
    raw.transactionId = "018f47a0-2d3e-7abc-8def-1234567890ab";
    const source = Buffer.from(JSON.stringify(raw));
    await expect(
      runElectronProductionRecoveryStoreOptionalIntentObservationCli(
        argumentsList(foreign),
        dependencies(foreign, {
          outcome: "present",
          commitMessage: "foreign",
          headSha: foreign.discovery.currentObservation.headCommitSha,
          treeSha: foreign.discovery.currentObservation.treeSha,
          parentShas: foreign.discovery.currentObservation.parentCommitShas,
          blobSha: gitBlobSha(source),
          byteLength: source.length,
          contentBase64: source.toString("base64")
        })
      )
    ).rejects.toThrow();
  });

  it("proves the genesis public-mutation slot absent at the verified chain head", async () => {
    const setup = await createSetup();
    const readRemote = vi.fn(async () => ({
      outcome: "absent" as const,
      commitMessage: "recovery head",
      headSha: setup.discovery.currentObservation.headCommitSha,
      treeSha: setup.discovery.currentObservation.treeSha,
      parentShas: setup.discovery.currentObservation.parentCommitShas
    }));
    const summary =
      await runElectronProductionRecoveryStoreOptionalIntentObservationCli(
        mutationAttemptArgumentsList(setup),
        {
          environment: { GH_TOKEN: "private-reader-token" },
          fetchImpl: vi.fn(),
          readRemote,
          writeStdout: () => undefined
        }
      );

    const markerPath =
      electronProductionPublicationRecoveryPublicMutationAttemptPath({
        transactionId: setup.fixture.heldLease.transactionId,
        previousOutcomeSha256: null
      });
    expect(readRemote).toHaveBeenCalledWith(expect.objectContaining({
      token: "private-reader-token",
      target: expect.objectContaining({ path: markerPath })
    }));
    expect(summary).toMatchObject({
      command: "observe-mutation-attempt",
      predecessorOutcomeSha256: null,
      attempt: { status: "absent-at-head" }
    });
    if (summary.command !== "observe-mutation-attempt") {
      throw new Error("Expected a public-mutation observe summary.");
    }
    const receipt =
      await readElectronProductionRecoveryStoreOptionalPublicMutationAttemptObservation({
        observationPath: setup.markerObservationOutput,
        expectedSha256: summary.output.sha256
      });
    expect(receipt.value.path).toBe(markerPath);
    expect(receipt.value.outcomeChainProofSha256).toBe(setup.chainProofSha256);

    const verified =
      await runElectronProductionRecoveryStoreOptionalIntentObservationCli([
        "verify-mutation-attempt",
        "--transaction-id", setup.fixture.heldLease.transactionId,
        "--discovery", setup.discoveryPath,
        "--discovery-sha256", setup.discoverySha256,
        "--outcome-chain-proof", setup.chainProofPath,
        "--outcome-chain-proof-sha256", setup.chainProofSha256,
        "--observation", setup.markerObservationOutput,
        "--observation-sha256", summary.output.sha256
      ], { writeStdout: () => undefined });
    expect(verified).toMatchObject({
      command: "verify-mutation-attempt",
      attempt: { status: "absent-at-head" }
    });
  });

  it("proves a canonical existing marker without exposing its content", async () => {
    const setup = await createSetup();
    const marker = await createMarker(setup);
    const source =
      serializeElectronProductionPublicationRecoveryPublicMutationAttempt(marker);
    const summary =
      await runElectronProductionRecoveryStoreOptionalIntentObservationCli(
        mutationAttemptArgumentsList(setup),
        dependencies(setup, {
          outcome: "present",
          commitMessage: "durable public-mutation marker",
          headSha: setup.discovery.currentObservation.headCommitSha,
          treeSha: setup.discovery.currentObservation.treeSha,
          parentShas: setup.discovery.currentObservation.parentCommitShas,
          blobSha: gitBlobSha(source),
          byteLength: source.length,
          contentBase64: source.toString("base64")
        })
      );

    expect(summary).toMatchObject({
      command: "observe-mutation-attempt",
      predecessorOutcomeSha256: null,
      attempt: {
        status: "present-at-head",
        operation: "release-held-lease",
        blobSha: gitBlobSha(source),
        file: { byteLength: source.length, sha256: sha256(source) }
      }
    });
    const serializedReceipt = await readFile(
      setup.markerObservationOutput,
      "utf8"
    );
    expect(serializedReceipt).not.toContain(source.toString("base64"));
    expect(serializedReceipt).not.toContain(marker.currentRun.controlSha);
  });

  it("rejects a chain proof that is not derived from the exact discovery", async () => {
    const setup = await createSetup();
    const forgedDirectory = path.join(setup.root, "forged-proof");
    await mkdir(forgedDirectory);
    const forged = await writeElectronProductionPublicationRecoveryOutcomeChainProof({
      outputPath: path.join(
        forgedDirectory,
        ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_CHAIN_PROOF_FILE
      ),
      value: {
        ...setup.chainProof,
        discoveryReceiptSha256: "f".repeat(64)
      }
    });
    const args = mutationAttemptArgumentsList(setup);
    const proofIndex = args.indexOf("--outcome-chain-proof");
    const digestIndex = args.indexOf("--outcome-chain-proof-sha256");
    args[proofIndex + 1] = forged.valuePath;
    args[digestIndex + 1] = forged.valueIdentity.sha256;

    await expect(
      runElectronProductionRecoveryStoreOptionalIntentObservationCli(
        args,
        dependencies(setup, {
          outcome: "absent",
          commitMessage: "recovery head",
          headSha: setup.discovery.currentObservation.headCommitSha,
          treeSha: setup.discovery.currentObservation.treeSha,
          parentShas: setup.discovery.currentObservation.parentCommitShas
        })
      )
    ).rejects.toThrow("proof discovery receipt SHA-256");
  });

  it.each(["token", "expected-head-sha", "intent-output", "source-root"])(
    "rejects forbidden --%s authority",
    async (option) => {
      const setup = await createSetup();
      await expect(
        runElectronProductionRecoveryStoreOptionalIntentObservationCli([
          ...argumentsList(setup),
          `--${option}`,
          "forbidden"
        ])
      ).rejects.toThrow(`Unknown optional intent observation option --${option}`);
    }
  );
});

async function createSetup() {
  const root = await mkdtemp(path.join(tmpdir(), "rion-optional-intent-"));
  temporaryDirectories.push(root);
  const fixture = await createOutcomeDiscoveryFixture(root);
  const discovery = fixture.discovery([], {
    status: "outcome-directory-absent"
  });
  const discoveryFile =
    await writeElectronProductionPublicationRecoveryOutcomeDiscovery({
      outputPath: path.join(
        root,
        ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_DISCOVERY_FILE
      ),
      value: discovery
    });
  const chainProof = verifyElectronProductionPublicationRecoveryOutcomeChain({
    ...fixture.foundation,
    discovery,
    discoverySha256:
      electronProductionPublicationRecoveryOutcomeDiscoverySha256(discovery)
  });
  const chainProofDirectory = path.join(root, "outcome-chain");
  await mkdir(chainProofDirectory);
  const chainProofFile =
    await writeElectronProductionPublicationRecoveryOutcomeChainProof({
      outputPath: path.join(
        chainProofDirectory,
        ELECTRON_PRODUCTION_PUBLICATION_RECOVERY_OUTCOME_CHAIN_PROOF_FILE
      ),
      value: chainProof
    });
  return {
    root,
    fixture,
    discovery,
    discoveryPath: discoveryFile.valuePath,
    discoverySha256: discoveryFile.valueIdentity.sha256,
    chainProof,
    chainProofPath: chainProofFile.valuePath,
    chainProofSha256: chainProofFile.valueIdentity.sha256,
    intentPath: electronProductionPublicationRecoveryLeaseReleaseIntentPath({
      transactionId: fixture.heldLease.transactionId
    }),
    output: path.join(
      root,
      ELECTRON_PRODUCTION_RECOVERY_STORE_OPTIONAL_INTENT_OBSERVATION_FILE
    ),
    markerObservationOutput: path.join(
      root,
      ELECTRON_PRODUCTION_RECOVERY_STORE_OPTIONAL_PUBLIC_MUTATION_ATTEMPT_OBSERVATION_FILE
    )
  };
}

function argumentsList(
  setupValue: Awaited<ReturnType<typeof createSetup>>
): string[] {
  return [
    "observe",
    "--transaction-id", setupValue.fixture.heldLease.transactionId,
    "--owner", "recovery-owner",
    "--repo", "recovery-vault",
    "--ref", "recovery-main",
    "--repository-default-branch", "recovery-main",
    "--repository-visibility", "private",
    "--discovery", setupValue.discoveryPath,
    "--discovery-sha256", setupValue.discoverySha256,
    "--observed-at", "2026-09-01T01:03:00Z",
    "--output", setupValue.output
  ];
}

function mutationAttemptArgumentsList(
  setupValue: Awaited<ReturnType<typeof createSetup>>
): string[] {
  return [
    "observe-mutation-attempt",
    "--transaction-id", setupValue.fixture.heldLease.transactionId,
    "--owner", "recovery-owner",
    "--repo", "recovery-vault",
    "--ref", "recovery-main",
    "--repository-default-branch", "recovery-main",
    "--repository-visibility", "private",
    "--discovery", setupValue.discoveryPath,
    "--discovery-sha256", setupValue.discoverySha256,
    "--outcome-chain-proof", setupValue.chainProofPath,
    "--outcome-chain-proof-sha256", setupValue.chainProofSha256,
    "--observed-at", "2026-09-01T01:06:00Z",
    "--output", setupValue.markerObservationOutput
  ];
}

async function createMarker(
  setupValue: Awaited<ReturnType<typeof createSetup>>
) {
  const pre = await createLeaseReleaseAuthorizationFixture({
    authorizedAt: "2026-09-01T01:02:00Z",
    fixture: setupValue.fixture,
    freshEntries: [],
    initialEntries: [],
    mode: "created-now",
    outputRoot: setupValue.root,
    recoveryRunStartedAt: "2026-09-01T01:01:00Z",
    suffix: "optional-marker",
    verifiedAt: "2026-09-01T01:04:00Z"
  });
  const publicObservation =
    createElectronProductionPublicLatestRecoveryObservation({
      observedAt: "2026-09-01T01:04:30Z",
      result: {
        outcome: "observed",
        latest: {
          releaseId: setupValue.fixture.source.release.id,
          updatedAt: "2026-09-01T01:00:00Z"
        },
        snapshot: setupValue.fixture.source
      },
      sourceSnapshot: setupValue.fixture.source,
      sourceSnapshotFileSha256:
        setupValue.fixture.foundation.sourceSnapshotSha256,
      targetSnapshot: setupValue.fixture.target,
      targetSnapshotFileSha256:
        setupValue.fixture.foundation.targetSnapshotSha256
    });
  return createElectronProductionPublicationRecoveryPublicMutationAttempt({
    authorization: pre.authorization,
    authorizationSha256: pre.sha256,
    operation: "release-held-lease",
    publicObservation,
    publicObservationSha256:
      electronProductionPublicLatestRecoveryObservationSha256(
        publicObservation
      ),
    reservedAt: "2026-09-01T01:05:00Z",
    sourceSnapshot: setupValue.fixture.source,
    targetSnapshot: setupValue.fixture.target
  });
}

function dependencies(
  _setupValue: Awaited<ReturnType<typeof createSetup>>,
  result: unknown
) {
  return {
    environment: { GH_TOKEN: "private-reader-token" },
    fetchImpl: vi.fn(),
    readRemote: async () => result as never,
    writeStdout: () => undefined
  };
}

function sha256(source: Uint8Array): string {
  return createHash("sha256").update(source).digest("hex");
}

function gitBlobSha(source: Uint8Array): string {
  return createHash("sha1")
    .update(`blob ${source.length}\0`)
    .update(source)
    .digest("hex");
}
