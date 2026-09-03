import { describe, expect, it } from "vitest";

import {
  ELECTRON_PRODUCTION_RECOVERY_STORE_OUTCOME_PATHS_KIND,
  ELECTRON_PRODUCTION_RECOVERY_STORE_TRANSACTION_PATHS_KIND,
  electronProductionRecoveryStoreOutcomePaths,
  electronProductionRecoveryStoreTransactionPaths
} from "../scripts/electronProductionRecoveryStoreTransactionPaths.mjs";

const TRANSACTION_ID = "018f47a0-2d3e-7abc-8def-1234567890ab";

describe("Electron production recovery-store transaction paths", () => {
  it("derives one deterministic UUID-fenced capsule and store-seal namespace", () => {
    const first = electronProductionRecoveryStoreTransactionPaths({
      transactionId: TRANSACTION_ID
    });
    const second = electronProductionRecoveryStoreTransactionPaths({
      transactionId: TRANSACTION_ID
    });

    expect(first).toEqual({
      schemaVersion: 1,
      kind: ELECTRON_PRODUCTION_RECOVERY_STORE_TRANSACTION_PATHS_KIND,
      transactionId: TRANSACTION_ID,
      capsulePath:
        `transactions/${TRANSACTION_ID}/` +
        "electron-production-publication-recovery-capsule.capsule.json",
      storeSealPath:
        `transactions/${TRANSACTION_ID}/` +
        "electron-production-publication-recovery-store-seal.json",
      recoveryOutcomeTerminalPath:
        `transactions/${TRANSACTION_ID}/` +
        "recovery-outcomes/" +
        "electron-production-publication-recovery-outcome.json"
    });
    expect(second).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.keys(first)).not.toContain("repository");
    expect(first.capsulePath.split("/").slice(0, 2)).toEqual([
      "transactions",
      TRANSACTION_ID
    ]);
    expect(first.storeSealPath.split("/").slice(0, 2)).toEqual([
      "transactions",
      TRANSACTION_ID
    ]);
    expect(first.recoveryOutcomeTerminalPath.split("/").slice(0, 2)).toEqual([
      "transactions",
      TRANSACTION_ID
    ]);
  });

  it("derives bounded append-only attempt and fixed terminal outcome paths", () => {
    const paths = electronProductionRecoveryStoreOutcomePaths({
      transactionId: TRANSACTION_ID,
      recoveryRun: recoveryRun({ runId: "123456", runAttempt: 7 })
    });

    expect(paths).toEqual({
      schemaVersion: 1,
      kind: ELECTRON_PRODUCTION_RECOVERY_STORE_OUTCOME_PATHS_KIND,
      transactionId: TRANSACTION_ID,
      recoveryRun: { runId: "123456", runAttempt: 7 },
      attemptPath:
        `transactions/${TRANSACTION_ID}/recovery-outcomes/` +
        "electron-production-publication-recovery-outcome-run-" +
        "123456-attempt-000007.json",
      terminalPath:
        `transactions/${TRANSACTION_ID}/recovery-outcomes/` +
        "electron-production-publication-recovery-outcome.json"
    });
    expect(Object.isFrozen(paths.recoveryRun)).toBe(true);
  });

  it.each([
    ["1".repeat(31), 1],
    ["123", 1_000_000]
  ])("rejects out-of-bounds outcome run coordinates %j/%j", (
    runId,
    runAttempt
  ) => {
    expect(() => electronProductionRecoveryStoreOutcomePaths({
      transactionId: TRANSACTION_ID,
      recoveryRun: recoveryRun({ runId, runAttempt })
    })).toThrow("exceeds path bounds");
  });

  it("rejects invalid or caller-controlled outcome paths", () => {
    expect(() => electronProductionRecoveryStoreOutcomePaths({
      transactionId: TRANSACTION_ID,
      recoveryRun: recoveryRun({ runId: "../123", runAttempt: 1 })
    })).toThrow("positive decimal GitHub run ID");
    expect(() => electronProductionRecoveryStoreOutcomePaths({
      transactionId: TRANSACTION_ID,
      recoveryRun: recoveryRun({ runId: "123", runAttempt: 0 })
    })).toThrow("positive safe integer");
    expect(() => electronProductionRecoveryStoreOutcomePaths({
      transactionId: TRANSACTION_ID,
      recoveryRun: recoveryRun({ runId: "123", runAttempt: 1 }),
      terminalPath: "foreign"
    } as unknown as Parameters<
      typeof electronProductionRecoveryStoreOutcomePaths
    >[0])).toThrow("unexpected schema");
  });

  it.each([
    "",
    "018F47A0-2D3E-7ABC-8DEF-1234567890AB",
    "../018f47a0-2d3e-7abc-8def-1234567890ab",
    "018f47a0-2d3e-0abc-8def-1234567890ab",
    "018f47a0-2d3e-7abc-7def-1234567890ab",
    "018f47a0-2d3e-7abc-8def-1234567890ab/foreign"
  ])("rejects an unfenced transaction value %j", (transactionId) => {
    expect(() => electronProductionRecoveryStoreTransactionPaths({
      transactionId
    })).toThrow("lowercase RFC 9562 UUID");
  });

  it("rejects missing and caller-controlled path or repository fields", () => {
    expect(() => electronProductionRecoveryStoreTransactionPaths({
      transactionId: undefined
    } as unknown as { transactionId: string })).toThrow(
      "lowercase RFC 9562 UUID"
    );
    expect(() => electronProductionRecoveryStoreTransactionPaths({
      transactionId: TRANSACTION_ID,
      repository: "owner/private-recovery"
    } as unknown as { transactionId: string })).toThrow("unexpected schema");
    expect(() => electronProductionRecoveryStoreTransactionPaths({
      transactionId: TRANSACTION_ID,
      capsulePath: "foreign"
    } as unknown as { transactionId: string })).toThrow("unexpected schema");
  });
});

function recoveryRun(input: Readonly<{
  runId: string;
  runAttempt: number;
}>) {
  return {
    repository: "rion-tw/rion-studio-source",
    workflow: ".github/workflows/electron-production-provisional-recovery.yml",
    runId: input.runId,
    runAttempt: input.runAttempt,
    controlSha: "a".repeat(40),
    startedAt: "2026-09-01T00:00:00Z"
  };
}
