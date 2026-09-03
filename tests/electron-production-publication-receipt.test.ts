import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { serializeCanonicalJson } from "../scripts/canonicalJson.mjs";
import {
  assertSemanticVersionIsNewer,
  compareSemanticVersions
} from "../scripts/electronUpdaterCompatibilityReceiptIo.mjs";
import {
  ELECTRON_PRODUCTION_PUBLICATION_RECEIPT_NAMES,
  assertElectronProductionPublicationReceipt,
  createElectronProductionPublicationIntent,
  electronProductionPublicationEventSha256,
  readElectronProductionPublicationReceipt,
  transitionElectronProductionPublication,
  writeElectronProductionPublicationReceipt,
  type ElectronProductionPublicationLeaseObservation,
  type ElectronProductionPublicationReceipt
} from "../scripts/electronProductionPublicationReceipt.mjs";

const TRANSACTION_ID = "10000000-0000-4000-8000-000000000001";
const LEASE_ID = "20000000-0000-4000-8000-000000000002";
const FOREIGN_LEASE_ID = "30000000-0000-4000-8000-000000000003";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("Electron production publication transaction receipts", () => {
  it("orders arbitrary application SemVer independently from v22/v23 runtime labels", () => {
    expect(compareSemanticVersions("8.5.0-beta.2", "8.5.0-beta.1")).toBeGreaterThan(0);
    expect(compareSemanticVersions("8.5.0", "8.5.0-beta.2")).toBeGreaterThan(0);
    expect(compareSemanticVersions(
      "8.5.0-9007199254740993",
      "8.5.0-9007199254740992"
    )).toBeGreaterThan(0);
    expect(() => assertSemanticVersionIsNewer(
      "8.4.2",
      "8.5.0",
      "Electron target application version"
    )).toThrow("must be strictly newer");
  });

  it("chains intent, provisional publication, and confirmed rollback by revision and hash", () => {
    const intent = createIntent();

    expect(intent).toMatchObject({
      revision: 1,
      previousEventSha256: null,
      phase: "intent",
      terminal: false,
      outcome: null,
      publication: {
        acknowledgement: null,
        observedState: "baseline"
      },
      recovery: {
        rollbackAllowed: false,
        rollbackAttempted: false,
        acknowledgement: null,
        observedStateBeforeRollback: null,
        observedStateBeforeRollbackSha256: null,
        finalState: null,
        finalStateSha256: null,
        reason: null
      }
    });
    expect(Object.isFrozen(intent)).toBe(true);
    expect(Object.isFrozen(intent.recovery)).toBe(true);

    const provisional = transitionElectronProductionPublication(intent, {
      kind: "publication-result",
      acknowledgement: "confirmed",
      observedState: "target",
      observedStateSha256: intent.target.stateSha256,
      lease: heldLease(intent),
      recordedAt: "2026-09-01T00:01:00Z"
    });

    expect(provisional).toMatchObject({
      revision: 2,
      previousEventSha256: electronProductionPublicationEventSha256(intent),
      phase: "provisional",
      terminal: false,
      outcome: null,
      recovery: {
        rollbackAllowed: true,
        rollbackAttempted: false,
        acknowledgement: null,
        observedStateBeforeRollback: null,
        observedStateBeforeRollbackSha256: null,
        finalState: null,
        finalStateSha256: null,
        reason: null
      }
    });

    const rolledBack = transitionElectronProductionPublication(provisional, {
      kind: "recovery-result",
      observedState: "target",
      observedStateSha256: provisional.target.stateSha256,
      rollbackAttempted: true,
      rollbackAcknowledgement: "confirmed",
      finalState: "baseline",
      finalStateSha256: provisional.baseline.stateSha256,
      lease: heldLease(provisional),
      recordedAt: "2026-09-01T00:02:00Z"
    });

    expect(rolledBack).toMatchObject({
      revision: 3,
      previousEventSha256: electronProductionPublicationEventSha256(provisional),
      phase: "terminal",
      terminal: true,
      outcome: "rolled-back",
      recovery: {
        rollbackAllowed: true,
        rollbackAttempted: true,
        acknowledgement: "confirmed",
        observedStateBeforeRollback: "target",
        observedStateBeforeRollbackSha256: provisional.target.stateSha256,
        finalState: "baseline",
        finalStateSha256: provisional.baseline.stateSha256,
        reason: "source-snapshot-restored"
      }
    });
    expect(() => transitionElectronProductionPublication(rolledBack, {
      kind: "publication-result",
      acknowledgement: "confirmed",
      observedState: "target",
      observedStateSha256: rolledBack.target.stateSha256,
      lease: heldLease(rolledBack),
      recordedAt: "2026-09-01T00:03:00Z"
    })).toThrow("terminal publication transaction cannot transition");
  });

  it.each(["not-submitted", "rejected"] as const)(
    "terminalizes a safe %s publication as aborted without rollback",
    (acknowledgement) => {
      const intent = createIntent();
      const aborted = transitionElectronProductionPublication(intent, {
        kind: "publication-result",
        acknowledgement,
        observedState: "baseline",
        observedStateSha256: intent.baseline.stateSha256,
        lease: heldLease(intent),
        recordedAt: "2026-09-01T00:01:00Z"
      });

      expect(aborted).toMatchObject({
        phase: "terminal",
        outcome: "aborted",
        recovery: {
          rollbackAllowed: false,
          rollbackAttempted: false,
          acknowledgement: null,
          finalState: "baseline",
          reason: acknowledgement === "not-submitted"
            ? "publication-not-submitted"
            : "publication-rejected"
        }
      });
    }
  );

  it("routes only an unknown acknowledgement with exact target readback through recovery", () => {
      const intent = createIntent();
      const recoveryRequired = transitionElectronProductionPublication(intent, {
        kind: "publication-result",
        acknowledgement: "unknown",
        observedState: "target",
        observedStateSha256: intent.target.stateSha256,
        lease: heldLease(intent),
        recordedAt: "2026-09-01T00:01:00Z"
      });

      expect(recoveryRequired).toMatchObject({
        phase: "recovery-required",
        terminal: false,
        outcome: null,
        publication: { acknowledgement: "unknown", observedState: "target" },
        recovery: {
          rollbackAllowed: true,
          rollbackAttempted: false,
          acknowledgement: null,
          finalState: null,
          finalStateSha256: null,
          reason: null
        }
      });
      expect(JSON.stringify(recoveryRequired)).not.toContain("promoted");

      const rolledBack = transitionElectronProductionPublication(recoveryRequired, {
        kind: "recovery-result",
        observedState: "target",
        observedStateSha256: recoveryRequired.target.stateSha256,
        rollbackAttempted: true,
        rollbackAcknowledgement: "confirmed",
        finalState: "baseline",
        finalStateSha256: recoveryRequired.baseline.stateSha256,
        lease: heldLease(recoveryRequired),
        recordedAt: "2026-09-01T00:02:00Z"
      });
      expect(rolledBack).toMatchObject({
        phase: "terminal",
        outcome: "rolled-back",
        previousEventSha256:
          electronProductionPublicationEventSha256(recoveryRequired)
      });
    }
  );

  it.each(["not-submitted", "rejected"] as const)(
    "terminalizes %s with exact target readback as indeterminate without rollback authority",
    (acknowledgement) => {
      const intent = createIntent();
      const result = transitionElectronProductionPublication(intent, {
        kind: "publication-result",
        acknowledgement,
        observedState: "target",
        observedStateSha256: intent.target.stateSha256,
        lease: heldLease(intent),
        recordedAt: "2026-09-01T00:01:00Z"
      });

      expect(result).toMatchObject({
        phase: "terminal",
        terminal: true,
        outcome: "indeterminate",
        publication: { acknowledgement, observedState: "target" },
        recovery: {
          rollbackAllowed: false,
          rollbackAttempted: false,
          acknowledgement: null,
          observedStateBeforeRollback: null,
          observedStateBeforeRollbackSha256: null,
          finalState: "target",
          finalStateSha256: intent.target.stateSha256,
          reason: "publication-readback-mismatch"
        }
      });
      expect(() => transitionElectronProductionPublication(result, {
        kind: "recovery-result",
        observedState: "target",
        observedStateSha256: result.target.stateSha256,
        rollbackAttempted: true,
        rollbackAcknowledgement: "confirmed",
        finalState: "baseline",
        finalStateSha256: result.baseline.stateSha256,
        lease: heldLease(result),
        recordedAt: "2026-09-01T00:02:00Z"
      })).toThrow("terminal publication transaction cannot transition");

      const forgedAuthority = structuredClone(result) as Record<string, unknown>;
      const forgedRecovery = forgedAuthority.recovery as Record<string, unknown>;
      forgedRecovery.rollbackAllowed = true;
      forgedRecovery.observedStateBeforeRollback = "target";
      forgedRecovery.observedStateBeforeRollbackSha256 = intent.target.stateSha256;
      forgedRecovery.reason = "rollback-not-attempted";
      expect(() => assertElectronProductionPublicationReceipt(forgedAuthority)).toThrow(
        "non-applied publication acknowledgement cannot authorize rollback"
      );
    }
  );

  it.each(["not-submitted", "rejected"] as const)(
    "rejects forged %s recovery-required and rolled-back authority",
    (acknowledgement) => {
      const intent = createIntent();
      const recoveryRequired = transitionElectronProductionPublication(intent, {
        kind: "publication-result",
        acknowledgement: "unknown",
        observedState: "target",
        observedStateSha256: intent.target.stateSha256,
        lease: heldLease(intent),
        recordedAt: "2026-09-01T00:01:00Z"
      });
      const forgedRecoveryRequired = structuredClone(recoveryRequired) as Record<string, unknown>;
      (forgedRecoveryRequired.publication as Record<string, unknown>).acknowledgement =
        acknowledgement;
      expect(() => assertElectronProductionPublicationReceipt(forgedRecoveryRequired)).toThrow(
        "recovery-required publication acknowledgement does not match"
      );

      const rolledBack = transitionElectronProductionPublication(recoveryRequired, {
        kind: "recovery-result",
        observedState: "target",
        observedStateSha256: recoveryRequired.target.stateSha256,
        rollbackAttempted: true,
        rollbackAcknowledgement: "confirmed",
        finalState: "baseline",
        finalStateSha256: recoveryRequired.baseline.stateSha256,
        lease: heldLease(recoveryRequired),
        recordedAt: "2026-09-01T00:02:00Z"
      });
      const forgedRolledBack = structuredClone(rolledBack) as Record<string, unknown>;
      (forgedRolledBack.publication as Record<string, unknown>).acknowledgement = acknowledgement;
      expect(() => assertElectronProductionPublicationReceipt(forgedRolledBack)).toThrow(
        "rolled-back publication receipt is inconsistent"
      );
    }
  );

  it("never converts an unknown rollback acknowledgement into rolled-back or promoted", () => {
    const provisional = createProvisional();
    const result = transitionElectronProductionPublication(provisional, {
      kind: "recovery-result",
      observedState: "target",
      observedStateSha256: provisional.target.stateSha256,
      rollbackAttempted: true,
      rollbackAcknowledgement: "unknown",
      finalState: "unknown",
      finalStateSha256: null,
      lease: heldLease(provisional),
      recordedAt: "2026-09-01T00:02:00Z"
    });

    expect(result).toMatchObject({
      phase: "terminal",
      outcome: "indeterminate",
      recovery: {
        rollbackAttempted: true,
        acknowledgement: "unknown",
        finalState: "unknown",
        finalStateSha256: null,
        reason: "rollback-acknowledgement-unknown"
      }
    });
    expect(JSON.stringify(result)).not.toContain("promoted");
  });

  it.each(["lost", "foreign-state", "foreign-lease"] as const)(
    "forbids rollback after %s fencing evidence",
    (scenario) => {
      const provisional = createProvisional();
      const lease = scenario === "lost"
        ? leaseObservation(provisional, "lost")
        : scenario === "foreign-lease"
          ? leaseObservation(provisional, "foreign")
          : heldLease(provisional);
      const observedState = scenario === "foreign-state" ? "foreign" : "target";
      const observedStateSha256 = observedState === "foreign"
        ? digest("foreign-published-state")
        : provisional.target.stateSha256;

      expect(() => transitionElectronProductionPublication(provisional, {
        kind: "recovery-result",
        observedState,
        observedStateSha256,
        rollbackAttempted: true,
        rollbackAcknowledgement: "confirmed",
        finalState: "baseline",
        finalStateSha256: provisional.baseline.stateSha256,
        lease,
        recordedAt: "2026-09-01T00:02:00Z"
      })).toThrow("Rollback is forbidden");

      const indeterminate = transitionElectronProductionPublication(provisional, {
        kind: "recovery-result",
        observedState,
        observedStateSha256,
        rollbackAttempted: false,
        rollbackAcknowledgement: null,
        finalState: observedState,
        finalStateSha256: observedStateSha256,
        lease,
        recordedAt: "2026-09-01T00:02:00Z"
      });
      expect(indeterminate.outcome).toBe("indeterminate");
      expect(indeterminate.recovery.rollbackAttempted).toBe(false);
    }
  );

  it("rejects stale lease generations before any state transition", () => {
    const intent = createIntent();
    expect(() => transitionElectronProductionPublication(intent, {
      kind: "publication-result",
      acknowledgement: "confirmed",
      observedState: "target",
      observedStateSha256: intent.target.stateSha256,
      lease: {
        ...heldLease(intent),
        generation: intent.lease.generation + 1
      },
      recordedAt: "2026-09-01T00:01:00Z"
    })).toThrow("publication lease generation fence does not match");
  });

  it("cross-binds every readback and chained event to the full baseline and target snapshots", () => {
    const intent = createIntent();
    expect(() => transitionElectronProductionPublication(intent, {
      kind: "publication-result",
      acknowledgement: "confirmed",
      observedState: "target",
      observedStateSha256: digest("different-target-snapshot"),
      lease: heldLease(intent),
      recordedAt: "2026-09-01T00:01:00Z"
    })).toThrow("publication readback target state does not match");

    const provisional = createProvisional();
    expect(provisional.baseline).toEqual(intent.baseline);
    expect(provisional.target).toEqual(intent.target);

    const aliasedSnapshots = structuredClone(intent) as Record<string, unknown>;
    (aliasedSnapshots.target as Record<string, unknown>).stateSha256 =
      intent.baseline.stateSha256;
    expect(() => assertElectronProductionPublicationReceipt(aliasedSnapshots)).toThrow(
      "baseline and target snapshot identities must differ"
    );
  });

  it.each(["unknown-state", "foreign-state", "lost-lease"] as const)(
    "terminalizes %s publication evidence as indeterminate without rollback",
    (scenario) => {
      const intent = createIntent();
      const observedState = scenario === "unknown-state"
        ? "unknown"
        : scenario === "foreign-state" ? "foreign" : "target";
      const observedStateSha256 = observedState === "unknown"
        ? null
        : observedState === "foreign"
          ? digest("foreign-current-state")
          : intent.target.stateSha256;
      const result = transitionElectronProductionPublication(intent, {
        kind: "publication-result",
        acknowledgement: "unknown",
        observedState,
        observedStateSha256,
        lease: scenario === "lost-lease"
          ? leaseObservation(intent, "lost")
          : heldLease(intent),
        recordedAt: "2026-09-01T00:01:00Z"
      });

      expect(result).toMatchObject({
        phase: "terminal",
        outcome: "indeterminate",
        recovery: {
          rollbackAttempted: false,
          acknowledgement: null
        }
      });
    }
  );

  it("writes and rereads only canonical create-new phase receipts", async () => {
    const root = await temporaryDirectory();
    const intent = createIntent();
    const outputPath = join(
      root,
      ELECTRON_PRODUCTION_PUBLICATION_RECEIPT_NAMES.intent
    );
    const written = await writeElectronProductionPublicationReceipt({
      outputPath,
      receipt: intent
    });

    expect(await readFile(outputPath)).toEqual(serializeCanonicalJson(intent));
    expect(written.receiptIdentity).toMatchObject({
      fileName: ELECTRON_PRODUCTION_PUBLICATION_RECEIPT_NAMES.intent,
      sha256: electronProductionPublicationEventSha256(intent)
    });
    const reread = await readElectronProductionPublicationReceipt({
      receiptPath: outputPath,
      expectedSha256: written.receiptIdentity.sha256
    });
    expect(reread.receipt).toEqual(intent);
    await expect(writeElectronProductionPublicationReceipt({
      outputPath,
      receipt: intent
    })).rejects.toThrow("must be create-new");
  });

  it("rejects missing explicit nulls and any recovery receipt that claims promoted", async () => {
    const intent = createIntent();
    const missingNull = structuredClone(intent) as Record<string, unknown>;
    delete (missingNull.recovery as Record<string, unknown>).acknowledgement;
    expect(() => assertElectronProductionPublicationReceipt(missingNull)).toThrow(
      "publication recovery has an unexpected schema"
    );

    const root = await temporaryDirectory();
    const forged = structuredClone(createProvisional()) as Record<string, unknown>;
    forged.phase = "terminal";
    forged.terminal = true;
    forged.outcome = "promoted";
    const path = join(root, ELECTRON_PRODUCTION_PUBLICATION_RECEIPT_NAMES.terminal);
    const source = serializeCanonicalJson(forged);
    await writeFile(path, source);
    await expect(readElectronProductionPublicationReceipt({
      receiptPath: path,
      expectedSha256: createHash("sha256").update(source).digest("hex")
    })).rejects.toThrow("publication recovery outcome is invalid");
  });
});

function createIntent(): Readonly<ElectronProductionPublicationReceipt> {
  return createElectronProductionPublicationIntent({
    transactionId: TRANSACTION_ID,
    recordedAt: "2026-09-01T00:00:00Z",
    lease: {
      id: LEASE_ID,
      generation: 7
    },
    baseline: {
      runtime: "tauri-v22",
      version: "8.4.2",
      releaseTag: "v8.4.2",
      sourceSha: "a".repeat(40),
      manifestSha256: digest("baseline-manifest"),
      stateSha256: digest("baseline-publication-state")
    },
    target: {
      runtime: "electron-v23",
      version: "8.5.0",
      releaseTag: "v8.5.0",
      sourceSha: "b".repeat(40),
      candidateReceiptSha256: digest("candidate-receipt"),
      manifestSha256: digest("target-manifest"),
      stateSha256: digest("target-publication-state")
    }
  });
}

function createProvisional(): Readonly<ElectronProductionPublicationReceipt> {
  const intent = createIntent();
  return transitionElectronProductionPublication(intent, {
    kind: "publication-result",
    acknowledgement: "confirmed",
    observedState: "target",
    observedStateSha256: intent.target.stateSha256,
    lease: heldLease(intent),
    recordedAt: "2026-09-01T00:01:00Z"
  });
}

function heldLease(
  receipt: Readonly<ElectronProductionPublicationReceipt>
): ElectronProductionPublicationLeaseObservation {
  return leaseObservation(receipt, "held");
}

function leaseObservation(
  receipt: Readonly<ElectronProductionPublicationReceipt>,
  status: "held" | "lost" | "foreign"
): ElectronProductionPublicationLeaseObservation {
  return {
    id: receipt.lease.id,
    generation: receipt.lease.generation,
    status,
    foreignLeaseId: status === "foreign" ? FOREIGN_LEASE_ID : null,
    foreignLeaseGeneration: status === "foreign"
      ? receipt.lease.generation + 1
      : null
  };
}

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "rion-publication-receipt-"));
  temporaryDirectories.push(directory);
  return directory;
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
