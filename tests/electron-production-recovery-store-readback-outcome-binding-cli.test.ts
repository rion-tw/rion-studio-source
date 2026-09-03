import { describe, expect, it, vi } from "vitest";

import { serializeCanonicalJson } from "../scripts/canonicalJson.mjs";
import type {
  ElectronProductionPublicationRecoveryOutcomeChainProof
} from "../scripts/electronProductionPublicationRecoveryOutcomeDiscovery.mjs";
import {
  runElectronProductionRecoveryStoreReadbackOutcomeBindingCli
} from "../scripts/electronProductionRecoveryStoreReadbackOutcomeBindingCli.mjs";
import type {
  ElectronProductionRecoveryStoreReadbackFoundation
} from "../scripts/electronProductionRecoveryStoreReadbackFoundationCli.mjs";

const TRANSACTION_ID = "6d975aa7-99ed-4654-aed3-f6034475eb67";
const CHAIN_PROOF_SHA256 = "f".repeat(64);

describe("recovery-store readback/outcome binding CLI", () => {
  it("binds the complete outcome chain to the exact capsule/seal observation", async () => {
    const readback = foundation();
    const proof = chainProof();
    const verifyReadback = vi.fn(async () => readback);
    const readChainProof = vi.fn(async () => ({
      value: proof,
      sha256: CHAIN_PROOF_SHA256
    }));
    const stdout: Buffer[] = [];

    const summary =
      await runElectronProductionRecoveryStoreReadbackOutcomeBindingCli(
        argumentsList(),
        {
          verifyReadback,
          readChainProof,
          writeStdout: (source) => {
            stdout.push(source);
          }
        }
      );

    expect(verifyReadback).toHaveBeenCalledOnce();
    expect(readChainProof).toHaveBeenCalledWith({
      expectedSha256: CHAIN_PROOF_SHA256,
      proofPath: "/tmp/outcome-chain-proof.json"
    });
    expect(summary).toMatchObject({
      status: "verified-same-head-outcome-chain",
      transactionId: TRANSACTION_ID,
      target: readback.target,
      currentObservation: readback.currentObservation,
      outcomeChain: {
        proofSha256: CHAIN_PROOF_SHA256,
        status: "empty",
        latestOutcome: null,
        terminal: null
      }
    });
    expect(stdout).toEqual([serializeCanonicalJson(summary)]);
    expect(JSON.stringify(summary)).not.toContain("/tmp/");
    expect(JSON.stringify(summary)).not.toContain("token");
    expect(Object.isFrozen(summary.outcomeChain)).toBe(true);
  });

  it.each([
    ["transaction ID", (proof: MutableProof) => {
      proof.transactionId = "1c9915e7-70bb-4e14-8c71-776953e2b626";
    }],
    ["private target", (proof: MutableProof) => {
      proof.target.repository = "different-owner/private-recovery";
    }],
    ["head/tree observation", (proof: MutableProof) => {
      proof.currentObservation.treeSha = "0".repeat(40);
    }],
    ["store-seal foundation", (proof: MutableProof) => {
      proof.foundation.storeSealSha256 = "0".repeat(64);
    }]
  ] as const)("rejects a cross-boundary %s mismatch", async (label, mutate) => {
    const changed = structuredClone(chainProof()) as MutableProof;
    mutate(changed);

    await expect(
      runElectronProductionRecoveryStoreReadbackOutcomeBindingCli(
        argumentsList(),
        {
          verifyReadback: async () => foundation(),
          readChainProof: async () => ({
            value: changed as unknown as
              ElectronProductionPublicationRecoveryOutcomeChainProof,
            sha256: CHAIN_PROOF_SHA256
          }),
          writeStdout: () => undefined
        }
      )
    ).rejects.toThrow(`outcome ${label} does not match readback`);
  });

  it.each(["token", "expected-head-sha", "source-root", "binding"])(
    "rejects forbidden --%s authority",
    async (option) => {
      await expect(
        runElectronProductionRecoveryStoreReadbackOutcomeBindingCli([
          ...argumentsList(),
          `--${option}`,
          "forbidden"
        ])
      ).rejects.toThrow(`Unknown readback-outcome binding option --${option}`);
    }
  );
});

function argumentsList(): string[] {
  return [
    "verify-readback-outcome-binding",
    "--transaction-id", TRANSACTION_ID,
    "--owner", "owner",
    "--repo", "private-recovery",
    "--ref", "recovery-main",
    "--capsule", "/tmp/capsule.json",
    "--capsule-read-operation", "/tmp/capsule-read.json",
    "--capsule-read-operation-sha256", "1".repeat(64),
    "--store-seal", "/tmp/store-seal.json",
    "--seal-read-operation", "/tmp/seal-read.json",
    "--seal-read-operation-sha256", "2".repeat(64),
    "--outcome-chain-proof", "/tmp/outcome-chain-proof.json",
    "--outcome-chain-proof-sha256", CHAIN_PROOF_SHA256
  ];
}

function foundation(): ElectronProductionRecoveryStoreReadbackFoundation {
  return {
    schemaVersion: 1,
    kind: "rion-electron-production-recovery-store-readback-foundation",
    status: "verified-current-readback",
    transactionId: TRANSACTION_ID,
    target: {
      repository: "owner/private-recovery",
      ref: "recovery-main",
      repositoryPolicy: {
        defaultBranch: "recovery-main",
        visibility: "private"
      }
    },
    paths: {
      capsule: `transactions/${TRANSACTION_ID}/capsule.json`,
      storeSeal: `transactions/${TRANSACTION_ID}/store-seal.json`
    },
    currentObservation: {
      headCommitSha: "5".repeat(40),
      treeSha: "6".repeat(40),
      parentCommitShas: ["7".repeat(40)]
    },
    capsule: {
      file: {
        fileName: "electron-production-publication-recovery-capsule.capsule.json",
        byteLength: 100,
        sha256: "8".repeat(64)
      },
      blobSha: "9".repeat(40),
      readReceiptSha256: "1".repeat(64)
    },
    storeSeal: {
      file: {
        fileName: "electron-production-publication-recovery-store-seal.json",
        byteLength: 200,
        sha256: "a".repeat(64)
      },
      blobSha: "b".repeat(40),
      readReceiptSha256: "2".repeat(64)
    },
    historicalCapsuleCreate: {
      authority: "seal-recorded-not-reproved",
      parentCommitSha: "c".repeat(40),
      commitSha: "d".repeat(40),
      treeSha: "e".repeat(40),
      operationReceiptSha256: "f".repeat(64)
    }
  };
}

function chainProof(): ElectronProductionPublicationRecoveryOutcomeChainProof {
  const readback = foundation();
  return {
    schemaVersion: 1,
    kind: "rion-electron-production-publication-recovery-outcome-chain-proof",
    status: "empty",
    transactionId: TRANSACTION_ID,
    discoveryReceiptSha256: "0".repeat(64),
    foundation: {
      transactionId: TRANSACTION_ID,
      leaseId: "lease-id",
      generation: 1,
      heldLeaseEventSha256: "1".repeat(64),
      heldLeaseSha256: "2".repeat(64),
      storeSealSha256: readback.storeSeal.file.sha256,
      sourceSnapshotSha256: "4".repeat(64),
      targetSnapshotSha256: "5".repeat(64),
      sourceStateSha256: "6".repeat(64),
      targetStateSha256: "7".repeat(64)
    },
    target: readback.target,
    currentObservation: readback.currentObservation,
    outcomeDirectory: {
      path: `transactions/${TRANSACTION_ID}/recovery-outcomes`,
      status: "outcome-directory-absent",
      treeSha: null
    },
    terminal: null,
    latestOutcome: null,
    outcomes: []
  };
}

interface MutableProof {
  transactionId: string;
  target: { repository: string };
  currentObservation: { treeSha: string };
  foundation: { storeSealSha256: string };
}
