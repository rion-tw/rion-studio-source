import { describe, expect, it, vi } from "vitest";

import {
  ChromiumSessionMigrationResumeCoordinator,
  type ChromiumSessionMigrationResumeCorePort
} from "../src/electron/main/chromiumSessionMigrationResumeCoordinator";
import type {
  ChromiumSessionMigrationImportResult
} from "../src/electron/main/chromiumSessionMigrationImporter";
import type {
  RoleSessionMigrationImportBeginInputInternal,
  RoleSessionMigrationTargetTransitionInputInternal
} from "../src/electron/core/coreAddonClient";
import { RionBridgeError } from "../src/electron/ipc/errors";
import type {
  RoleSessionMigrationPlatform,
  RoleSessionMigrationRecord
} from "../src/shared/generated";

const ROLE_ID = "11111111-1111-4111-8111-111111111111";
const TRANSFER_ID = "22222222-2222-4222-8222-222222222222";
const SECOND_ROLE_ID = "55555555-5555-4555-8555-555555555555";
const SECOND_TRANSFER_ID = "66666666-6666-4666-8666-666666666666";
const FIRST_TRANSITION_ID = "33333333-3333-4333-8333-333333333333";
const SECOND_TRANSITION_ID = "44444444-4444-4444-8444-444444444444";
const ENVELOPE_SHA256 = "a".repeat(64);
const INVENTORY_SHA256 = "b".repeat(64);
const FIRST_TIME = "2026-08-30T00:00:02.000Z";
const SECOND_TIME = "2026-08-30T00:00:03.000Z";

function migrationJournal(
  phase: "exported" | "importing" | "verifying" | "indeterminate" = "importing",
  overrides: Partial<RoleSessionMigrationRecord> = {}
): RoleSessionMigrationRecord {
  const targetRevision = overrides.targetRevision ?? (phase === "exported" ? undefined : 9);
  return {
    roleId: ROLE_ID,
    transferId: TRANSFER_ID,
    phase,
    journalRevision: phase === "exported" ? 3 : phase === "importing" ? 4 :
      phase === "verifying" ? 5 : 6,
    platform: "macos",
    sourceEngine: "wkwebview",
    targetEngine: "chromium",
    sourceRevision: 12,
    ...(targetRevision === undefined ? {} : { targetRevision }),
    envelopeSha256: ENVELOPE_SHA256,
    inventorySha256: INVENTORY_SHA256,
    cookieCount: 1,
    localStorageOriginCount: 0,
    localStorageEntryCount: 0,
    startedAt: "2026-08-30T00:00:00.000Z",
    phaseChangedAt: "2026-08-30T00:00:01.000Z",
    updatedAt: "2026-08-30T00:00:01.000Z",
    ...(phase === "verifying"
      ? {
        cleanFlushReceiptId:
          `chromium-cookie-flush:${TRANSFER_ID}:${targetRevision}`
      }
      : {}),
    ...(phase === "indeterminate"
      ? {
        stableErrorCode: "CHROMIUM_SESSION_MIGRATION_RETRY_REQUIRED",
        outcome: "indeterminate" as const,
        outcomeAt: "2026-08-30T00:00:01.000Z"
      }
      : {}),
    ...overrides
  };
}

function applied(
  journal: RoleSessionMigrationRecord
): ChromiumSessionMigrationImportResult {
  return Object.freeze({
    status: "applied",
    receipt: Object.freeze({
      roleId: journal.roleId,
      transferId: journal.transferId,
      targetRevision: journal.targetRevision!,
      inventorySha256: journal.inventorySha256!,
      cookieCount: journal.cookieCount!,
      localStorageOriginCount: 0 as const,
      localStorageEntryCount: 0 as const,
      cleanFlushReceiptId:
        `chromium-cookie-flush:${journal.transferId}:${journal.targetRevision}`
    })
  });
}

function appliedFresh(
  journal: RoleSessionMigrationRecord,
  receiptId = `chromium-session-fresh:${"c".repeat(64)}`
): ChromiumSessionMigrationImportResult {
  return Object.freeze({
    status: "applied",
    receipt: Object.freeze({
      roleId: journal.roleId,
      transferId: journal.transferId,
      targetRevision: journal.targetRevision!,
      inventorySha256: journal.inventorySha256!,
      cookieCount: journal.cookieCount!,
      localStorageOriginCount: journal.localStorageOriginCount!,
      localStorageEntryCount: journal.localStorageEntryCount!,
      cleanFlushReceiptId: receiptId
    })
  });
}

interface CoreHarness {
  readonly core: ChromiumSessionMigrationResumeCorePort;
  readonly begin: ReturnType<typeof vi.fn>;
  readonly begins: RoleSessionMigrationImportBeginInputInternal[];
  readonly invoke: ReturnType<typeof vi.fn>;
  readonly transition: ReturnType<typeof vi.fn>;
  readonly transitions: RoleSessionMigrationTargetTransitionInputInternal[];
  readonly stateByRole: Map<string, RoleSessionMigrationRecord>;
}

function createCore(
  journals: readonly RoleSessionMigrationRecord[],
  options: Readonly<{
    rejectBeginAfterCommit?: boolean;
    rejectBeginWith?: RionBridgeError;
    rejectTransitionAt?: number;
    rejectTransitionWith?: RionBridgeError;
  }> = {}
): CoreHarness {
  const stateByRole = new Map(journals.map((journal) => [
    journal.roleId,
    journal
  ]));
  const transitions: RoleSessionMigrationTargetTransitionInputInternal[] = [];
  const begins: RoleSessionMigrationImportBeginInputInternal[] = [];
  const invoke = vi.fn(async (command: { type: string }) => {
    if (command.type !== "roleSessionMigrationsList") {
      throw new Error("unexpected public Core command");
    }
    return [...stateByRole.values()];
  });
  const begin = vi.fn(async (input: RoleSessionMigrationImportBeginInputInternal) => {
    begins.push(input);
    const current = stateByRole.get(input.roleId);
    if (
      !current || current.transferId !== input.transferId ||
      current.phase !== "exported" ||
      current.journalRevision !== input.expectedJournalRevision
    ) {
      throw new Error("stale import admission fence");
    }
    if (options.rejectBeginWith) throw options.rejectBeginWith;
    const committed: RoleSessionMigrationRecord = {
      ...current,
      phase: "importing",
      journalRevision: current.journalRevision + 1,
      targetRevision: 1,
      phaseChangedAt: FIRST_TIME,
      updatedAt: FIRST_TIME
    };
    stateByRole.set(input.roleId, committed);
    if (options.rejectBeginAfterCommit) {
      throw new Error("Core import admission acknowledgement unavailable");
    }
    return committed;
  });
  const transition = vi.fn(async (
    input: RoleSessionMigrationTargetTransitionInputInternal
  ) => {
    transitions.push(input);
    if (options.rejectTransitionWith) throw options.rejectTransitionWith;
    if (transitions.length === options.rejectTransitionAt) {
      throw new Error("Core transition acknowledgement unavailable");
    }
    const current = stateByRole.get(input.roleId);
    if (
      !current ||
      current.transferId !== input.transferId ||
      current.phase !== input.expectedPhase ||
      current.journalRevision !== input.expectedJournalRevision
    ) {
      throw new Error("stale transition fence");
    }
    const terminal = new Set(["v23Ready", "failed", "indeterminate"])
      .has(input.nextPhase);
    const committed: RoleSessionMigrationRecord = {
      ...current,
      phase: input.nextPhase,
      journalRevision: current.journalRevision + 1,
      stableErrorCode: input.stableErrorCode,
      outcome: input.outcome,
      cleanFlushReceiptId: input.cleanFlushReceiptId,
      resetReceiptId: undefined,
      firstVerifiedLaunchAt: undefined,
      phaseChangedAt: input.occurredAt,
      updatedAt: input.occurredAt,
      outcomeAt: terminal ? input.occurredAt : undefined
    };
    stateByRole.set(input.roleId, committed);
    return committed;
  });
  return {
    core: {
      invoke: invoke as ChromiumSessionMigrationResumeCorePort["invoke"],
      beginRoleSessionMigrationImportInternal:
        begin as ChromiumSessionMigrationResumeCorePort[
          "beginRoleSessionMigrationImportInternal"
        ],
      transitionRoleSessionMigrationTargetInternal:
        transition as ChromiumSessionMigrationResumeCorePort[
          "transitionRoleSessionMigrationTargetInternal"
        ]
    },
    begin,
    begins,
    invoke,
    transition,
    transitions,
    stateByRole
  };
}

function sequence(values: readonly string[]): () => string {
  let index = 0;
  return () => values[index++] ?? "sequence-exhausted";
}

function coordinator(
  core: ChromiumSessionMigrationResumeCorePort,
  importRole: (input: {
    roleId: string;
    transferId: string;
    expectedJournalRevision: number;
    targetRevision: number;
  }) => Promise<ChromiumSessionMigrationImportResult>,
  expectedPlatform: RoleSessionMigrationPlatform = "macos",
  ids = [FIRST_TRANSITION_ID, SECOND_TRANSITION_ID],
  times = [FIRST_TIME, SECOND_TIME],
  startupSignal?: AbortSignal
): ChromiumSessionMigrationResumeCoordinator {
  return new ChromiumSessionMigrationResumeCoordinator({
    core,
    expectedPlatform,
    importer: { importRole },
    nextTransitionId: sequence(ids),
    now: sequence(times),
    startupSignal
  });
}

describe("ChromiumSessionMigrationResumeCoordinator", () => {
  it("admits an exact exported journal through Rust before importing it", async () => {
    const exported = migrationJournal("exported", {
      platform: "windows",
      sourceEngine: "webview2"
    });
    const harness = createCore([exported]);
    const importRole = vi.fn(async () => applied(harness.stateByRole.get(ROLE_ID)!));

    const result = await coordinator(harness.core, importRole, "windows").start();

    expect(harness.begins).toEqual([{
      roleId: ROLE_ID,
      transferId: TRANSFER_ID,
      expectedJournalRevision: 3
    }]);
    expect(importRole).toHaveBeenCalledWith({
      roleId: ROLE_ID,
      transferId: TRANSFER_ID,
      expectedJournalRevision: 4,
      targetRevision: 1
    });
    expect(harness.transitions.map((transition) => transition.nextPhase))
      .toEqual(["verifying", "v23Ready"]);
    expect(result).toMatchObject({
      eligibleRoleCount: 1,
      results: [{
        status: "v23-ready",
        journal: { phase: "v23Ready", journalRevision: 6, targetRevision: 1 }
      }]
    });
  });

  it("recovers an unknown import-admission acknowledgement from durable importing state", async () => {
    const exported = migrationJournal("exported", {
      platform: "windows",
      sourceEngine: "webview2"
    });
    const harness = createCore([exported], { rejectBeginAfterCommit: true });
    const importRole = vi.fn(async () => applied(harness.stateByRole.get(ROLE_ID)!));

    await expect(coordinator(harness.core, importRole, "windows").start())
      .resolves.toMatchObject({
      results: [{
        status: "pending",
        stableErrorCode: "CHROMIUM_SESSION_MIGRATION_IMPORT_BEGIN_INDETERMINATE",
        lastKnownJournal: { phase: "exported", journalRevision: 3 }
      }]
      });
    expect(importRole).not.toHaveBeenCalled();
    expect(harness.stateByRole.get(ROLE_ID)).toMatchObject({
      phase: "importing",
      journalRevision: 4,
      targetRevision: 1
    });

    const recovered = await coordinator(harness.core, importRole, "windows").start();
    expect(harness.begin).toHaveBeenCalledTimes(1);
    expect(importRole).toHaveBeenCalledWith(expect.objectContaining({
      expectedJournalRevision: 4,
      targetRevision: 1
    }));
    expect(recovered).toMatchObject({
      results: [{ status: "v23-ready", journal: { phase: "v23Ready" } }]
    });
  });

  it.each([
    "ROLE_SESSION_MIGRATION_IMPORT_ADMISSION_UNAVAILABLE",
    "ROLE_SESSION_MIGRATION_PLATFORM_MISMATCH",
    "CORE_INPUT_INVALID"
  ])("fails startup on structured import admission rejection %s", async (code) => {
    const exported = migrationJournal("exported");
    const failure = new RionBridgeError({
      code,
      message: "Core rejected the exact import admission."
    });
    const harness = createCore([exported], { rejectBeginWith: failure });
    const importRole = vi.fn(async () => applied(exported));

    await expect(coordinator(harness.core, importRole).start()).rejects.toBe(failure);
    expect(importRole).not.toHaveBeenCalled();
    expect(harness.transitions).toHaveLength(0);
    expect(harness.stateByRole.get(ROLE_ID)).toEqual(exported);
  });

  it.each([
    "ROLE_SESSION_MIGRATION_TRANSITION_INVALID",
    "ROLE_SESSION_MIGRATION_PLATFORM_MISMATCH",
    "CORE_INPUT_INVALID"
  ])("fails startup on structured target transition rejection %s", async (code) => {
    const importing = migrationJournal("importing");
    const failure = new RionBridgeError({
      code,
      message: "Core rejected the exact target transition."
    });
    const harness = createCore([importing], { rejectTransitionWith: failure });
    const importRole = vi.fn(async () => applied(importing));

    await expect(coordinator(harness.core, importRole).start()).rejects.toBe(failure);
    expect(harness.transition).toHaveBeenCalledOnce();
    expect(harness.stateByRole.get(ROLE_ID)).toEqual(importing);
  });

  it.each(["exported", "importing", "verifying", "indeterminate"] as const)(
    "rejects an opposite-platform %s journal before any resume mutation",
    async (phase) => {
      const journal = migrationJournal(phase, {
        platform: "windows",
        sourceEngine: "webview2"
      });
      const harness = createCore([journal]);
      const importRole = vi.fn(async () => applied(journal));

      await expect(coordinator(harness.core, importRole).start()).rejects.toMatchObject({
        code: "ROLE_SESSION_MIGRATION_PLATFORM_MISMATCH"
      });
      expect(harness.begin).not.toHaveBeenCalled();
      expect(importRole).not.toHaveBeenCalled();
      expect(harness.transition).not.toHaveBeenCalled();
      expect(harness.stateByRole.get(ROLE_ID)).toEqual(journal);
    }
  );

  it("joins every started resume lane before rethrowing the first fatal error", async () => {
    const exported = migrationJournal("exported");
    const importing = migrationJournal("importing", {
      roleId: SECOND_ROLE_ID,
      transferId: SECOND_TRANSFER_ID
    });
    const failure = new RionBridgeError({
      code: "CORE_INPUT_INVALID",
      message: "Core rejected the exact import admission."
    });
    const harness = createCore([exported, importing], { rejectBeginWith: failure });
    let resolveImport!: (result: ChromiumSessionMigrationImportResult) => void;
    const importRole = vi.fn(() => new Promise<ChromiumSessionMigrationImportResult>((resolve) => {
      resolveImport = resolve;
    }));

    const start = coordinator(harness.core, importRole).start();
    const observed = vi.fn();
    void start.then(observed, observed);
    await vi.waitFor(() => expect(importRole).toHaveBeenCalledOnce());
    expect(observed).not.toHaveBeenCalled();

    resolveImport(applied(importing));
    await expect(start).rejects.toBe(failure);
    expect(harness.stateByRole.get(SECOND_ROLE_ID)).toMatchObject({
      phase: "v23Ready"
    });
  });

  it("joins the startup migration lane after quit cancellation without advancing Core", async () => {
    const journal = migrationJournal("importing");
    const harness = createCore([journal]);
    const startupAbort = new AbortController();
    let helperReaped = false;
    let resolveImport!: (result: ChromiumSessionMigrationImportResult) => void;
    const importRole = vi.fn(() =>
      new Promise<ChromiumSessionMigrationImportResult>((resolve) => {
        resolveImport = resolve;
      })
    );
    startupAbort.signal.addEventListener("abort", () => {
      queueMicrotask(() => {
        helperReaped = true;
        resolveImport({
          status: "indeterminate",
          stableErrorCode: "CHROMIUM_SESSION_MIGRATION_STARTUP_CANCELLED",
          rollback: "unknown"
        });
      });
    }, { once: true });
    const start = coordinator(
      harness.core,
      importRole,
      "macos",
      [FIRST_TRANSITION_ID, SECOND_TRANSITION_ID],
      [FIRST_TIME, SECOND_TIME],
      startupAbort.signal
    ).start();

    await vi.waitFor(() => expect(importRole).toHaveBeenCalledOnce());
    startupAbort.abort("application-before-quit");

    await expect(start).rejects.toMatchObject({
      code: "CHROMIUM_SESSION_MIGRATION_RESUME_CANCELLED"
    });
    expect(helperReaped).toBe(true);
    expect(harness.transition).not.toHaveBeenCalled();
    expect(harness.stateByRole.get(ROLE_ID)).toEqual(journal);
  });

  it("starts once and advances an exact cookie-only importing journal", async () => {
    const journal = migrationJournal();
    const harness = createCore([journal]);
    const importRole = vi.fn(async () => applied(journal));
    const resume = coordinator(harness.core, importRole);

    const first = resume.start();
    expect(resume.start()).toBe(first);
    const result = await first;

    expect(harness.invoke).toHaveBeenCalledOnce();
    expect(harness.transition).toHaveBeenCalledTimes(2);
    expect(importRole).toHaveBeenCalledWith({
      roleId: ROLE_ID,
      transferId: TRANSFER_ID,
      expectedJournalRevision: 4,
      targetRevision: 9
    });
    expect(harness.transitions).toEqual([
      {
        roleId: ROLE_ID,
        transferId: TRANSFER_ID,
        transitionId: FIRST_TRANSITION_ID,
        expectedPhase: "importing",
        expectedJournalRevision: 4,
        nextPhase: "verifying",
        cleanFlushReceiptId: `chromium-cookie-flush:${TRANSFER_ID}:9`,
        occurredAt: FIRST_TIME
      },
      {
        roleId: ROLE_ID,
        transferId: TRANSFER_ID,
        transitionId: SECOND_TRANSITION_ID,
        expectedPhase: "verifying",
        expectedJournalRevision: 5,
        nextPhase: "v23Ready",
        outcome: "verified",
        cleanFlushReceiptId: `chromium-cookie-flush:${TRANSFER_ID}:9`,
        occurredAt: SECOND_TIME
      }
    ]);
    expect(result).toMatchObject({
      eligibleRoleCount: 1,
      results: [{ status: "v23-ready", journal: {
        phase: "v23Ready",
        journalRevision: 6
      } }]
    });
  });

  it("re-verifies a durable verifying journal with one exact transition", async () => {
    const journal = migrationJournal("verifying");
    const harness = createCore([journal]);
    const importRole = vi.fn(async () => applied(journal));

    const result = await coordinator(harness.core, importRole).resume(journal);

    expect(harness.transitions).toHaveLength(1);
    expect(harness.transitions[0]).toMatchObject({
      expectedPhase: "verifying",
      expectedJournalRevision: 5,
      nextPhase: "v23Ready",
      outcome: "verified",
      cleanFlushReceiptId: `chromium-cookie-flush:${TRANSFER_ID}:9`
    });
    expect(result).toMatchObject({
      status: "v23-ready",
      journal: { phase: "v23Ready", journalRevision: 6 }
    });
  });

  it("reapplies an indeterminate journal without a pinned receipt before verifying", async () => {
    const journal = migrationJournal("indeterminate");
    const harness = createCore([journal]);
    const importRole = vi.fn(async () => applied(journal));

    const result = await coordinator(harness.core, importRole).resume(journal);

    expect(importRole).toHaveBeenCalledWith({
      roleId: ROLE_ID,
      transferId: TRANSFER_ID,
      expectedJournalRevision: 6,
      targetRevision: 9
    });
    expect(harness.transitions).toEqual([
      expect.objectContaining({
        expectedPhase: "indeterminate",
        expectedJournalRevision: 6,
        nextPhase: "verifying",
        cleanFlushReceiptId: `chromium-cookie-flush:${TRANSFER_ID}:9`
      }),
      expect.objectContaining({
        expectedPhase: "verifying",
        expectedJournalRevision: 7,
        nextPhase: "v23Ready",
        outcome: "verified"
      })
    ]);
    expect(result).toMatchObject({
      status: "v23-ready",
      journal: { phase: "v23Ready", journalRevision: 8 }
    });
  });

  it("reuses only the exact receipt when an indeterminate journal already pins one", async () => {
    const receiptId = `chromium-session-fresh:${"d".repeat(64)}`;
    const journal = migrationJournal("indeterminate", {
      localStorageOriginCount: 1,
      localStorageEntryCount: 1,
      cleanFlushReceiptId: receiptId
    });
    const harness = createCore([journal]);

    const result = await coordinator(
      harness.core,
      vi.fn(async () => appliedFresh(journal, receiptId))
    ).resume(journal);

    expect(harness.transitions.map((transition) => ({
      expectedPhase: transition.expectedPhase,
      nextPhase: transition.nextPhase,
      receipt: transition.cleanFlushReceiptId
    }))).toEqual([
      {
        expectedPhase: "indeterminate",
        nextPhase: "verifying",
        receipt: receiptId
      },
      {
        expectedPhase: "verifying",
        nextPhase: "v23Ready",
        receipt: receiptId
      }
    ]);
    expect(result).toMatchObject({ status: "v23-ready" });
  });

  it("leaves an indeterminate retry failure unchanged and never promotes it", async () => {
    const journal = migrationJournal("indeterminate");
    const harness = createCore([journal]);
    const failure: ChromiumSessionMigrationImportResult = {
      status: "failed",
      stableErrorCode: "CHROMIUM_SESSION_MIGRATION_COOKIE_APPLY_FAILED",
      rollback: "applied"
    };

    const result = await coordinator(
      harness.core,
      vi.fn(async () => failure)
    ).resume(journal);

    expect(result).toMatchObject({
      status: "pending",
      stableErrorCode: "CHROMIUM_SESSION_MIGRATION_COOKIE_APPLY_FAILED",
      lastKnownJournal: journal
    });
    expect(harness.transitions).toHaveLength(0);
    expect(harness.stateByRole.get(ROLE_ID)).toEqual(journal);
  });

  it("does not treat a source-side indeterminate journal as a target resume", async () => {
    const journal = migrationJournal("indeterminate", {
      targetRevision: undefined,
      envelopeSha256: undefined,
      inventorySha256: undefined,
      cookieCount: undefined,
      localStorageOriginCount: undefined,
      localStorageEntryCount: undefined,
      cleanFlushReceiptId: undefined
    });
    const harness = createCore([journal]);
    const importRole = vi.fn(async () => applied(journal));

    await expect(coordinator(harness.core, importRole).start()).resolves.toEqual({
      eligibleRoleCount: 0,
      results: []
    });
    expect(importRole).not.toHaveBeenCalled();
    expect(harness.transitions).toHaveLength(0);
    expect(harness.stateByRole.get(ROLE_ID)).toEqual(journal);
  });

  it("commits fresh-process LocalStorage durability evidence and reuses it on crash resume", async () => {
    const receiptId = `chromium-session-fresh:${"d".repeat(64)}`;
    const importing = migrationJournal("importing", {
      cookieCount: 1,
      localStorageOriginCount: 1,
      localStorageEntryCount: 2
    });
    const importingHarness = createCore([importing]);
    const imported = await coordinator(
      importingHarness.core,
      vi.fn(async () => appliedFresh(importing, receiptId))
    ).resume(importing);

    expect(importingHarness.transitions).toHaveLength(2);
    expect(importingHarness.transitions.map((transition) => ({
      phase: transition.nextPhase,
      receipt: transition.cleanFlushReceiptId
    }))).toEqual([
      { phase: "verifying", receipt: receiptId },
      { phase: "v23Ready", receipt: receiptId }
    ]);
    expect(importingHarness.transitions).toEqual([
      expect.not.objectContaining({ localStorageOriginCount: 1 }),
      expect.not.objectContaining({ localStorageOriginCount: 1 })
    ]);
    expect(importingHarness.stateByRole.get(ROLE_ID)).toMatchObject({
      localStorageOriginCount: 1,
      localStorageEntryCount: 2
    });
    expect(imported).toMatchObject({ status: "v23-ready" });

    const verifying = migrationJournal("verifying", {
      cookieCount: 1,
      localStorageOriginCount: 1,
      localStorageEntryCount: 2,
      cleanFlushReceiptId: receiptId
    });
    const verifyingHarness = createCore([verifying]);
    const resumed = await coordinator(
      verifyingHarness.core,
      vi.fn(async () => appliedFresh(verifying, receiptId))
    ).resume(verifying);

    expect(verifyingHarness.transitions).toHaveLength(1);
    expect(verifyingHarness.transitions[0]).toMatchObject({
      expectedPhase: "verifying",
      nextPhase: "v23Ready",
      cleanFlushReceiptId: receiptId
    });
    expect(resumed).toMatchObject({ status: "v23-ready" });
  });

  it("terminalizes LocalStorage flush failure and rejects forged success", async () => {
    const journal = migrationJournal("importing", {
      cookieCount: 0,
      localStorageOriginCount: 1,
      localStorageEntryCount: 1
    });
    const failure: ChromiumSessionMigrationImportResult = {
      status: "failed",
      stableErrorCode:
        "CHROMIUM_SESSION_MIGRATION_LOCAL_STORAGE_FLUSH_UNACKNOWLEDGED",
      rollback: "not-required"
    };
    const terminalHarness = createCore([journal]);
    const terminal = await coordinator(
      terminalHarness.core,
      vi.fn(async () => failure)
    ).resume(journal);

    expect(terminalHarness.transitions).toHaveLength(1);
    expect(terminalHarness.transitions[0]).toMatchObject({
      nextPhase: "failed",
      outcome: "failed",
      stableErrorCode:
        "CHROMIUM_SESSION_MIGRATION_LOCAL_STORAGE_FLUSH_UNACKNOWLEDGED"
    });
    expect(terminal).toMatchObject({
      status: "terminal",
      outcome: "failed",
      journal: { phase: "failed" }
    });

    const forgedHarness = createCore([journal]);
    const forged = await coordinator(
      forgedHarness.core,
      vi.fn(async () => applied(journal))
    ).resume(journal);
    expect(forged).toMatchObject({
      status: "pending",
      stableErrorCode: "CHROMIUM_SESSION_MIGRATION_RESUME_RECEIPT_INVALID"
    });
    expect(forgedHarness.transitions).toHaveLength(0);
  });

  it("commits an exact indeterminate terminal outcome from verifying", async () => {
    const journal = migrationJournal("verifying");
    const harness = createCore([journal]);
    const indeterminate: ChromiumSessionMigrationImportResult = {
      status: "indeterminate",
      stableErrorCode:
        "CHROMIUM_SESSION_MIGRATION_COOKIE_ROLLBACK_INDETERMINATE",
      rollback: "unknown"
    };
    const result = await coordinator(
      harness.core,
      vi.fn(async () => indeterminate)
    ).resume(journal);

    expect(harness.transitions[0]).toMatchObject({
      nextPhase: "indeterminate",
      outcome: "indeterminate",
      cleanFlushReceiptId: `chromium-cookie-flush:${TRANSFER_ID}:9`
    });
    expect(result).toMatchObject({
      status: "terminal",
      outcome: "indeterminate",
      journal: { phase: "indeterminate", journalRevision: 6 }
    });
  });

  it("coalesces an exact role lane and rejects a competing revision", async () => {
    const journal = migrationJournal();
    const harness = createCore([journal]);
    let resolveImport!: (result: ChromiumSessionMigrationImportResult) => void;
    const importRole = vi.fn(() => new Promise<ChromiumSessionMigrationImportResult>(
      (resolve) => { resolveImport = resolve; }
    ));
    const resume = coordinator(harness.core, importRole);

    const first = resume.resume(journal);
    expect(resume.resume({ ...journal })).toBe(first);
    await expect(resume.resume({
      ...journal,
      journalRevision: journal.journalRevision + 1
    })).rejects.toMatchObject({
      code: "CHROMIUM_SESSION_MIGRATION_RESUME_CONFLICT"
    });
    resolveImport(applied(journal));
    await expect(first).resolves.toMatchObject({ status: "v23-ready" });
    expect(importRole).toHaveBeenCalledTimes(1);
  });

  it("stays pending when a transition acknowledgement is unknown", async () => {
    const journal = migrationJournal();
    const harness = createCore([journal], { rejectTransitionAt: 2 });
    const result = await coordinator(
      harness.core,
      vi.fn(async () => applied(journal))
    ).resume(journal);

    expect(result).toMatchObject({
      status: "pending",
      stableErrorCode:
        "CHROMIUM_SESSION_MIGRATION_RESUME_TRANSITION_INDETERMINATE",
      lastKnownJournal: { phase: "verifying", journalRevision: 5 }
    });
    expect(harness.stateByRole.get(ROLE_ID)).toMatchObject({
      phase: "verifying",
      journalRevision: 5
    });
  });

  it("does not mutate Core with noncanonical injected transition ports", async () => {
    const journal = migrationJournal();
    const harness = createCore([journal]);
    const result = await coordinator(
      harness.core,
      vi.fn(async () => applied(journal)),
      "macos",
      ["NOT-A-UUID"],
      ["2026-08-30T00:00:02Z"]
    ).resume(journal);

    expect(result).toMatchObject({
      status: "pending",
      stableErrorCode: "CHROMIUM_SESSION_MIGRATION_RESUME_PORT_INVALID"
    });
    expect(harness.transitions).toHaveLength(0);
    expect(harness.invoke).not.toHaveBeenCalled();
    expect(harness.transition).not.toHaveBeenCalled();
  });

  it("rejects a verifying snapshot without its exact flush receipt", async () => {
    const journal = migrationJournal("verifying", {
      cleanFlushReceiptId: "wrong-receipt"
    });
    const harness = createCore([journal]);
    const importRole = vi.fn(async () => applied(journal));

    await expect(coordinator(harness.core, importRole).resume(journal))
      .rejects.toMatchObject({
        code: "CHROMIUM_SESSION_MIGRATION_RESUME_JOURNAL_INVALID"
      });
    expect(importRole).not.toHaveBeenCalled();
  });
});
