import { describe, expect, it, vi } from "vitest";

import { serializeCanonicalJson } from
  "../scripts/canonicalJson.mjs";
import {
  runElectronProductionRecoveryStoreReadbackContinuityCli
} from
  "../scripts/electronProductionRecoveryStoreReadbackContinuityCli.mjs";
import type {
  ElectronProductionRecoveryStoreReadbackFoundation
} from
  "../scripts/electronProductionRecoveryStoreReadbackFoundationCli.mjs";

const TRANSACTION_ID = "6d975aa7-99ed-4654-aed3-f6034475eb67";
const INITIAL_CAPSULE =
  "/tmp/initial/electron-production-publication-recovery-capsule.capsule.json";
const FRESH_CAPSULE =
  "/tmp/fresh/electron-production-publication-recovery-capsule.capsule.json";

describe("electron production recovery-store readback continuity CLI", () => {
  it("reverifies two distinct snapshots and emits their exact shared observation", async () => {
    const initial = foundation("1".repeat(64), "2".repeat(64));
    const fresh = foundation("3".repeat(64), "4".repeat(64));
    const verifyReadback = vi.fn(async (argumentsList: readonly string[]) =>
      argumentsList.includes(INITIAL_CAPSULE) ? initial : fresh
    );
    const output: Buffer[] = [];

    const summary = await runElectronProductionRecoveryStoreReadbackContinuityCli(
      argumentsList(),
      {
        verifyReadback,
        writeStdout: (source) => {
          output.push(source);
        }
      }
    );

    expect(verifyReadback).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({
      status: "verified-same-observation",
      transactionId: TRANSACTION_ID,
      currentObservation: initial.currentObservation,
      capsule: {
        file: initial.capsule.file,
        blobSha: initial.capsule.blobSha
      },
      storeSeal: {
        file: initial.storeSeal.file,
        blobSha: initial.storeSeal.blobSha
      },
      receipts: {
        initial: {
          capsuleReadReceiptSha256: "1".repeat(64),
          sealReadReceiptSha256: "2".repeat(64)
        },
        fresh: {
          capsuleReadReceiptSha256: "3".repeat(64),
          sealReadReceiptSha256: "4".repeat(64)
        }
      }
    });
    expect(output).toEqual([serializeCanonicalJson(summary)]);
    expect(Object.isFrozen(summary.currentObservation)).toBe(true);
  });

  it.each([
    ["head", (value: MutableFoundation) => {
      value.currentObservation.headCommitSha = "a".repeat(40);
    }],
    ["tree", (value: MutableFoundation) => {
      value.currentObservation.treeSha = "b".repeat(40);
    }],
    ["capsule digest", (value: MutableFoundation) => {
      value.capsule.file.sha256 = "c".repeat(64);
    }],
    ["capsule blob", (value: MutableFoundation) => {
      value.capsule.blobSha = "d".repeat(40);
    }],
    ["seal digest", (value: MutableFoundation) => {
      value.storeSeal.file.sha256 = "e".repeat(64);
    }],
    ["transaction", (value: MutableFoundation) => {
      value.transactionId = "1c9915e7-70bb-4e14-8c71-776953e2b626";
    }]
  ] as const)("rejects a changed %s observation", async (_label, mutate) => {
    const initial = foundation("1".repeat(64), "2".repeat(64));
    const changed = structuredClone(
      foundation("3".repeat(64), "4".repeat(64))
    ) as MutableFoundation;
    mutate(changed);

    await expect(runElectronProductionRecoveryStoreReadbackContinuityCli(
      argumentsList(),
      {
        verifyReadback: async (argumentsList) =>
          argumentsList.includes(INITIAL_CAPSULE)
            ? initial
            : changed as unknown as ElectronProductionRecoveryStoreReadbackFoundation,
        writeStdout: () => undefined
      }
    )).rejects.toThrow("changed between sealed reads");
  });

  it("rejects path reuse before either authoritative verifier runs", async () => {
    const verifyReadback = vi.fn();
    const argumentsWithReuse = argumentsList().map((value) =>
      value === FRESH_CAPSULE ? INITIAL_CAPSULE : value
    );

    await expect(runElectronProductionRecoveryStoreReadbackContinuityCli(
      argumentsWithReuse,
      { verifyReadback }
    )).rejects.toThrow("must all be distinct");
    expect(verifyReadback).not.toHaveBeenCalled();
  });

  it.each(["token", "binding", "source-root", "expected-head-sha"])(
    "rejects forbidden --%s authority",
    async (option) => {
      await expect(runElectronProductionRecoveryStoreReadbackContinuityCli([
        ...argumentsList(),
        `--${option}`,
        "forbidden"
      ])).rejects.toThrow(`Unknown readback-continuity option --${option}`);
    }
  );
});

function argumentsList(): string[] {
  return [
    "verify-readback-continuity",
    "--transaction-id", TRANSACTION_ID,
    "--owner", "owner",
    "--repo", "private-recovery",
    "--ref", "recovery-main",
    "--initial-capsule", INITIAL_CAPSULE,
    "--initial-capsule-read-operation", "/tmp/initial/capsule-read.json",
    "--initial-capsule-read-operation-sha256", "1".repeat(64),
    "--initial-store-seal", "/tmp/initial/store-seal.json",
    "--initial-seal-read-operation", "/tmp/initial/seal-read.json",
    "--initial-seal-read-operation-sha256", "2".repeat(64),
    "--fresh-capsule", FRESH_CAPSULE,
    "--fresh-capsule-read-operation", "/tmp/fresh/capsule-read.json",
    "--fresh-capsule-read-operation-sha256", "3".repeat(64),
    "--fresh-store-seal", "/tmp/fresh/store-seal.json",
    "--fresh-seal-read-operation", "/tmp/fresh/seal-read.json",
    "--fresh-seal-read-operation-sha256", "4".repeat(64)
  ];
}

function foundation(
  capsuleReadReceiptSha256: string,
  sealReadReceiptSha256: string
): ElectronProductionRecoveryStoreReadbackFoundation {
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
      capsule:
        `transactions/${TRANSACTION_ID}/` +
        "electron-production-publication-recovery-capsule.capsule.json",
      storeSeal:
        `transactions/${TRANSACTION_ID}/` +
        "electron-production-publication-recovery-store-seal.json"
    },
    currentObservation: {
      headCommitSha: "5".repeat(40),
      treeSha: "6".repeat(40),
      parentCommitShas: ["7".repeat(40)]
    },
    capsule: {
      file: {
        fileName:
          "electron-production-publication-recovery-capsule.capsule.json",
        byteLength: 100,
        sha256: "8".repeat(64)
      },
      blobSha: "9".repeat(40),
      readReceiptSha256: capsuleReadReceiptSha256
    },
    storeSeal: {
      file: {
        fileName:
          "electron-production-publication-recovery-store-seal.json",
        byteLength: 200,
        sha256: "a".repeat(64)
      },
      blobSha: "b".repeat(40),
      readReceiptSha256: sealReadReceiptSha256
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

interface MutableFoundation {
  transactionId: string;
  currentObservation: {
    headCommitSha: string;
    treeSha: string;
  };
  capsule: {
    blobSha: string;
    file: { sha256: string };
  };
  storeSeal: {
    file: { sha256: string };
  };
}
