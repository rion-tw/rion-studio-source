import { randomUUID } from "node:crypto";

import type {
  RoleSessionMigrationPlatform,
  RoleSessionMigrationRecord
} from "../../shared/generated";
import type {
  RoleSessionMigrationImportBeginInputInternal,
  RoleSessionMigrationTargetTransitionInputInternal
} from "../core/coreAddonClient";
import { RionBridgeError } from "../ipc/errors";
import type {
  ChromiumSessionMigrationImportInput,
  ChromiumSessionMigrationImportResult
} from "./chromiumSessionMigrationImporter";

export interface ChromiumSessionMigrationResumeCorePort {
  invoke: (
    command: Readonly<{ type: "roleSessionMigrationsList" }>
  ) => Promise<RoleSessionMigrationRecord[]>;
  beginRoleSessionMigrationImportInternal: (
    input: RoleSessionMigrationImportBeginInputInternal
  ) => Promise<RoleSessionMigrationRecord>;
  transitionRoleSessionMigrationTargetInternal: (
    input: RoleSessionMigrationTargetTransitionInputInternal
  ) => Promise<RoleSessionMigrationRecord>;
}

export interface ChromiumSessionMigrationResumeImporterPort {
  importRole: (
    input: ChromiumSessionMigrationImportInput
  ) => Promise<ChromiumSessionMigrationImportResult>;
}

export interface ChromiumSessionMigrationResumeCoordinatorInput {
  readonly core: ChromiumSessionMigrationResumeCorePort;
  readonly expectedPlatform: RoleSessionMigrationPlatform;
  readonly importer: ChromiumSessionMigrationResumeImporterPort;
  readonly nextTransitionId?: () => string;
  readonly now?: () => string;
  readonly startupSignal?: AbortSignal;
}

export type ChromiumSessionMigrationRoleResumeResult =
  | Readonly<{
    status: "v23-ready";
    journal: RoleSessionMigrationRecord;
  }>
  | Readonly<{
    status: "terminal";
    outcome: "failed" | "indeterminate";
    journal: RoleSessionMigrationRecord;
  }>
  | Readonly<{
    status: "pending";
    stableErrorCode: string;
    lastKnownJournal: RoleSessionMigrationRecord;
  }>;

export interface ChromiumSessionMigrationResumeStartResult {
  readonly eligibleRoleCount: number;
  readonly results: readonly ChromiumSessionMigrationRoleResumeResult[];
}

interface ResumeLane {
  readonly identityKey: string;
  readonly promise: Promise<ChromiumSessionMigrationRoleResumeResult>;
}

type ExportJournalEvidence = Required<Pick<
  RoleSessionMigrationRecord,
  | "envelopeSha256"
  | "inventorySha256"
  | "cookieCount"
  | "localStorageOriginCount"
  | "localStorageEntryCount"
>>;

type CompleteJournalEvidence = ExportJournalEvidence & Readonly<{
  targetRevision: number;
}>;

type TransitionSubmission = Readonly<{
  nextPhase: "verifying" | "v23Ready" | "failed" | "indeterminate";
  stableErrorCode?: string;
  outcome?: "verified" | "failed" | "indeterminate";
  cleanFlushReceiptId?: string;
}>;

type TransitionResult =
  | Readonly<{ ok: true; journal: RoleSessionMigrationRecord }>
  | Readonly<{ ok: false; stableErrorCode: string }>;

type ImportBeginResult =
  | Readonly<{ ok: true; journal: RoleSessionMigrationRecord }>
  | Readonly<{ ok: false; stableErrorCode: string }>;

function coordinatorError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function canonicalUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
      .test(value);
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function stableCode(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 96 &&
    /^[A-Z][A-Z0-9_]*$/u.test(value);
}

function exportEvidence(
  journal: RoleSessionMigrationRecord
): ExportJournalEvidence {
  const evidence = {
    envelopeSha256: journal.envelopeSha256,
    inventorySha256: journal.inventorySha256,
    cookieCount: journal.cookieCount,
    localStorageOriginCount: journal.localStorageOriginCount,
    localStorageEntryCount: journal.localStorageEntryCount
  };
  const countIsValid = (value: unknown): value is number =>
    Number.isSafeInteger(value) && (value as number) >= 0;
  if (
    !/^[0-9a-f]{64}$/u.test(evidence.envelopeSha256 ?? "") ||
    !/^[0-9a-f]{64}$/u.test(evidence.inventorySha256 ?? "") ||
    !countIsValid(evidence.cookieCount) ||
    !countIsValid(evidence.localStorageOriginCount) ||
    !countIsValid(evidence.localStorageEntryCount)
  ) {
    throw coordinatorError(
      "CHROMIUM_SESSION_MIGRATION_RESUME_JOURNAL_INVALID",
      "The resumable migration journal lacks complete canonical export evidence."
    );
  }
  return evidence as ExportJournalEvidence;
}

function completeEvidence(
  journal: RoleSessionMigrationRecord
): CompleteJournalEvidence {
  if (!Number.isSafeInteger(journal.targetRevision) ||
    (journal.targetRevision as number) < 1) {
    throw coordinatorError(
      "CHROMIUM_SESSION_MIGRATION_RESUME_JOURNAL_INVALID",
      "The resumable migration journal lacks its Rust-owned target revision."
    );
  }
  return Object.freeze({
    ...exportEvidence(journal),
    targetRevision: journal.targetRevision as number
  });
}

function validateResumableJournal(
  journal: RoleSessionMigrationRecord,
  expectedPlatform: RoleSessionMigrationPlatform
): void {
  if (
    !canonicalUuid(journal.roleId) ||
    !canonicalUuid(journal.transferId) ||
    !Number.isSafeInteger(journal.journalRevision) ||
    journal.journalRevision < 1 ||
    journal.journalRevision === Number.MAX_SAFE_INTEGER ||
    !Number.isSafeInteger(journal.sourceRevision) ||
    journal.sourceRevision < 0 ||
    !["exported", "importing", "verifying", "indeterminate"]
      .includes(journal.phase) ||
    journal.targetEngine !== "chromium" ||
    !(
      (journal.platform === "macos" && journal.sourceEngine === "wkwebview") ||
      (journal.platform === "windows" && journal.sourceEngine === "webview2")
    ) ||
    (journal.phase === "indeterminate"
      ? !stableCode(journal.stableErrorCode) ||
        journal.outcome !== "indeterminate" ||
        !canonicalTimestamp(journal.outcomeAt) ||
        journal.outcomeAt !== journal.phaseChangedAt
      : journal.stableErrorCode !== undefined ||
        journal.outcome !== undefined ||
        journal.outcomeAt !== undefined) ||
    journal.firstVerifiedLaunchAt !== undefined ||
    journal.resetReceiptId !== undefined ||
    !canonicalTimestamp(journal.startedAt) ||
    !canonicalTimestamp(journal.phaseChangedAt) ||
    !canonicalTimestamp(journal.updatedAt) ||
    (journal.phase === "exported" && (
      journal.targetRevision !== undefined ||
      journal.cleanFlushReceiptId !== undefined
    )) ||
    (journal.phase === "importing" && journal.cleanFlushReceiptId !== undefined) ||
    (journal.phase === "verifying" && !journal.cleanFlushReceiptId)
  ) {
    throw coordinatorError(
      "CHROMIUM_SESSION_MIGRATION_RESUME_JOURNAL_INVALID",
      "Only an exact exported, importing, verifying, or indeterminate Chromium migration can resume."
    );
  }
  if (journal.platform !== expectedPlatform) {
    throw coordinatorError(
      "ROLE_SESSION_MIGRATION_PLATFORM_MISMATCH",
      "The resumable migration journal does not match the compiled target platform."
    );
  }
  if (journal.phase === "exported") {
    exportEvidence(journal);
    return;
  }
  const evidence = completeEvidence(journal);
  const hasLocalStorage = evidence.localStorageOriginCount > 0 ||
    evidence.localStorageEntryCount > 0;
  const receiptMatches = hasLocalStorage
    ? typeof journal.cleanFlushReceiptId === "string" &&
      /^chromium-session-fresh:[0-9a-f]{64}$/u
        .test(journal.cleanFlushReceiptId)
    : journal.cleanFlushReceiptId ===
      `chromium-cookie-flush:${journal.transferId}:${evidence.targetRevision}`;
  if (
    (journal.phase === "verifying" ||
      (journal.phase === "indeterminate" && journal.cleanFlushReceiptId)) &&
    !receiptMatches
  ) {
    throw coordinatorError(
      "CHROMIUM_SESSION_MIGRATION_RESUME_JOURNAL_INVALID",
      "The verifying journal lacks its exact Chromium cookie flush receipt."
    );
  }
}

function resumeIdentity(journal: RoleSessionMigrationRecord): string {
  return [
    journal.roleId,
    journal.transferId,
    journal.journalRevision,
    journal.targetRevision
  ].join(":");
}

function importerInput(
  journal: RoleSessionMigrationRecord,
  evidence: CompleteJournalEvidence
): ChromiumSessionMigrationImportInput {
  return {
    roleId: journal.roleId,
    transferId: journal.transferId,
    expectedJournalRevision: journal.journalRevision,
    targetRevision: evidence.targetRevision
  };
}

function pending(
  journal: RoleSessionMigrationRecord,
  code: string
): ChromiumSessionMigrationRoleResumeResult {
  return Object.freeze({
    status: "pending",
    stableErrorCode: code,
    lastKnownJournal: journal
  });
}

function importerFailureCode(error: unknown): string {
  return error instanceof RionBridgeError &&
    error.code.startsWith("CHROMIUM_SESSION_MIGRATION_") &&
    stableCode(error.code)
    ? error.code
    : "CHROMIUM_SESSION_MIGRATION_RESUME_IMPORT_FAILED";
}

function appliedReceiptMatches(
  journal: RoleSessionMigrationRecord,
  evidence: CompleteJournalEvidence,
  result: Extract<ChromiumSessionMigrationImportResult, { status: "applied" }>
): boolean {
  const receipt = result.receipt;
  if (!receipt || typeof receipt !== "object") return false;
  const hasLocalStorage = evidence.localStorageOriginCount > 0 ||
    evidence.localStorageEntryCount > 0;
  const receiptIdMatches = hasLocalStorage
    ? typeof receipt.cleanFlushReceiptId === "string" &&
      /^chromium-session-fresh:[0-9a-f]{64}$/u
        .test(receipt.cleanFlushReceiptId) &&
      (!journal.cleanFlushReceiptId ||
        receipt.cleanFlushReceiptId === journal.cleanFlushReceiptId)
    : receipt.cleanFlushReceiptId ===
      `chromium-cookie-flush:${journal.transferId}:${evidence.targetRevision}`;
  return receipt.roleId === journal.roleId &&
    receipt.transferId === journal.transferId &&
    receipt.targetRevision === evidence.targetRevision &&
    receipt.inventorySha256 === evidence.inventorySha256 &&
    receipt.cookieCount === evidence.cookieCount &&
    receipt.localStorageOriginCount === evidence.localStorageOriginCount &&
    receipt.localStorageEntryCount === evidence.localStorageEntryCount &&
    receiptIdMatches;
}

function transitionResponseMatches(
  current: RoleSessionMigrationRecord,
  evidence: CompleteJournalEvidence,
  input: RoleSessionMigrationTargetTransitionInputInternal,
  committed: RoleSessionMigrationRecord
): boolean {
  const terminal = ["v23Ready", "failed", "indeterminate"]
    .includes(input.nextPhase);
  return committed.roleId === current.roleId &&
    committed.transferId === current.transferId &&
    committed.platform === current.platform &&
    committed.sourceEngine === current.sourceEngine &&
    committed.targetEngine === current.targetEngine &&
    committed.sourceRevision === current.sourceRevision &&
    committed.startedAt === current.startedAt &&
    committed.phase === input.nextPhase &&
    committed.journalRevision === current.journalRevision + 1 &&
    committed.targetRevision === evidence.targetRevision &&
    committed.envelopeSha256 === evidence.envelopeSha256 &&
    committed.inventorySha256 === evidence.inventorySha256 &&
    committed.cookieCount === evidence.cookieCount &&
    committed.localStorageOriginCount === evidence.localStorageOriginCount &&
    committed.localStorageEntryCount === evidence.localStorageEntryCount &&
    committed.stableErrorCode === input.stableErrorCode &&
    committed.outcome === input.outcome &&
    committed.cleanFlushReceiptId === input.cleanFlushReceiptId &&
    committed.resetReceiptId === undefined &&
    committed.firstVerifiedLaunchAt === undefined &&
    committed.phaseChangedAt === input.occurredAt &&
    committed.updatedAt === input.occurredAt &&
    committed.outcomeAt === (terminal ? input.occurredAt : undefined);
}

function importBeginResponseMatches(
  exported: RoleSessionMigrationRecord,
  committed: RoleSessionMigrationRecord
): boolean {
  return committed.roleId === exported.roleId &&
    committed.transferId === exported.transferId &&
    committed.platform === exported.platform &&
    committed.sourceEngine === exported.sourceEngine &&
    committed.targetEngine === exported.targetEngine &&
    committed.sourceRevision === exported.sourceRevision &&
    committed.startedAt === exported.startedAt &&
    committed.phase === "importing" &&
    committed.journalRevision === exported.journalRevision + 1 &&
    committed.targetRevision === 1 &&
    committed.envelopeSha256 === exported.envelopeSha256 &&
    committed.inventorySha256 === exported.inventorySha256 &&
    committed.cookieCount === exported.cookieCount &&
    committed.localStorageOriginCount === exported.localStorageOriginCount &&
    committed.localStorageEntryCount === exported.localStorageEntryCount &&
    committed.stableErrorCode === undefined &&
    committed.outcome === undefined &&
    committed.cleanFlushReceiptId === undefined &&
    committed.resetReceiptId === undefined &&
    committed.firstVerifiedLaunchAt === undefined &&
    committed.outcomeAt === undefined &&
    committed.phaseChangedAt === committed.updatedAt;
}

/**
 * One instance performs one startup scan. Its lanes prevent same-process
 * re-entry only; a fresh process creates a new instance and re-reads Rust's
 * durable journal. No in-memory lane or same-process reopen is durability proof.
 */
export class ChromiumSessionMigrationResumeCoordinator {
  readonly #input: ChromiumSessionMigrationResumeCoordinatorInput;
  readonly #lanesByRole = new Map<string, ResumeLane>();
  #startPromise: Promise<ChromiumSessionMigrationResumeStartResult> | null = null;

  constructor(input: ChromiumSessionMigrationResumeCoordinatorInput) {
    this.#input = input;
  }

  start(): Promise<ChromiumSessionMigrationResumeStartResult> {
    this.#throwIfStartupCancelled();
    if (!this.#startPromise) this.#startPromise = this.#startOnce();
    return this.#startPromise;
  }

  resume(
    journal: RoleSessionMigrationRecord
  ): Promise<ChromiumSessionMigrationRoleResumeResult> {
    this.#throwIfStartupCancelled();
    const snapshot = Object.freeze({ ...journal });
    try {
      validateResumableJournal(snapshot, this.#input.expectedPlatform);
    } catch (error) {
      return Promise.reject(error);
    }
    const key = resumeIdentity(snapshot);
    const existing = this.#lanesByRole.get(snapshot.roleId);
    if (existing) {
      if (existing.identityKey === key) return existing.promise;
      return Promise.reject(coordinatorError(
        "CHROMIUM_SESSION_MIGRATION_RESUME_CONFLICT",
        "Another exact migration revision owns this role's resume lane."
      ));
    }
    const promise = this.#resume(snapshot).finally(() => {
      if (this.#lanesByRole.get(snapshot.roleId)?.promise === promise) {
        this.#lanesByRole.delete(snapshot.roleId);
      }
    });
    this.#lanesByRole.set(snapshot.roleId, { identityKey: key, promise });
    return promise;
  }

  async #startOnce(): Promise<ChromiumSessionMigrationResumeStartResult> {
    this.#throwIfStartupCancelled();
    let journals: RoleSessionMigrationRecord[];
    try {
      journals = await this.#input.core.invoke({
        type: "roleSessionMigrationsList"
      });
    } catch {
      throw coordinatorError(
        "CHROMIUM_SESSION_MIGRATION_RESUME_LIST_FAILED",
        "Durable role session migration journals could not be listed."
      );
    }
    this.#throwIfStartupCancelled();
    if (!Array.isArray(journals)) {
      throw coordinatorError(
        "CHROMIUM_SESSION_MIGRATION_RESUME_JOURNAL_INVALID",
        "The durable migration journal list is not canonical."
      );
    }
    const eligible = journals.filter((journal) =>
      journal.phase === "exported" ||
      journal.phase === "importing" ||
      journal.phase === "verifying" ||
      (journal.phase === "indeterminate" && journal.targetRevision !== undefined)
    );
    if (new Set(eligible.map((journal) => journal.roleId)).size !== eligible.length) {
      throw coordinatorError(
        "CHROMIUM_SESSION_MIGRATION_RESUME_JOURNAL_INVALID",
        "The startup migration journal list contains duplicate role ownership."
      );
    }
    for (const journal of eligible) {
      validateResumableJournal(journal, this.#input.expectedPlatform);
    }
    const settled = await Promise.allSettled(
      eligible.map((journal) => this.resume(journal))
    );
    this.#throwIfStartupCancelled();
    const firstFailure = settled.find((result) => result.status === "rejected");
    if (firstFailure?.status === "rejected") throw firstFailure.reason;
    const results = settled.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    return Object.freeze({
      eligibleRoleCount: eligible.length,
      results: Object.freeze(results)
    });
  }

  async #resume(
    initialJournal: RoleSessionMigrationRecord
  ): Promise<ChromiumSessionMigrationRoleResumeResult> {
    this.#throwIfStartupCancelled();
    let importJournal = initialJournal;
    if (initialJournal.phase === "exported") {
      const begun = await this.#beginImport(initialJournal);
      this.#throwIfStartupCancelled();
      if (!begun.ok) return pending(initialJournal, begun.stableErrorCode);
      importJournal = begun.journal;
    }
    const evidence = completeEvidence(importJournal);
    let imported: ChromiumSessionMigrationImportResult;
    try {
      imported = await this.#input.importer.importRole(
        importerInput(importJournal, evidence)
      );
    } catch (error) {
      return pending(importJournal, importerFailureCode(error));
    }
    this.#throwIfStartupCancelled();

    if (!new Set(["applied", "failed", "indeterminate"]).has(
      (imported as { status?: string } | null)?.status ?? ""
    )) {
      return pending(
        importJournal,
        "CHROMIUM_SESSION_MIGRATION_RESUME_RESULT_INVALID"
      );
    }

    if (imported.status !== "applied") {
      const rollbackIsValid = imported.status === "failed"
        ? imported.rollback === "not-required" || imported.rollback === "applied"
        : imported.rollback === "unknown";
      if (!stableCode(imported.stableErrorCode) || !rollbackIsValid) {
        return pending(
          importJournal,
          "CHROMIUM_SESSION_MIGRATION_RESUME_RESULT_INVALID"
        );
      }
      if (importJournal.phase === "indeterminate") {
        return pending(importJournal, imported.stableErrorCode);
      }
      const terminal = await this.#transition(importJournal, evidence, {
        nextPhase: imported.status,
        stableErrorCode: imported.stableErrorCode,
        outcome: imported.status,
        ...(importJournal.cleanFlushReceiptId
          ? { cleanFlushReceiptId: importJournal.cleanFlushReceiptId }
          : {})
      });
      this.#throwIfStartupCancelled();
      if (!terminal.ok) return pending(importJournal, terminal.stableErrorCode);
      return Object.freeze({
        status: "terminal",
        outcome: imported.status,
        journal: terminal.journal
      });
    }

    if (!appliedReceiptMatches(importJournal, evidence, imported)) {
      return pending(
        importJournal,
        "CHROMIUM_SESSION_MIGRATION_RESUME_RECEIPT_INVALID"
      );
    }
    let verifying = importJournal;
    if (importJournal.phase === "importing" ||
      importJournal.phase === "indeterminate") {
      const committed = await this.#transition(importJournal, evidence, {
        nextPhase: "verifying",
        cleanFlushReceiptId: imported.receipt.cleanFlushReceiptId
      });
      this.#throwIfStartupCancelled();
      if (!committed.ok) return pending(importJournal, committed.stableErrorCode);
      verifying = committed.journal;
    }
    const ready = await this.#transition(verifying, evidence, {
      nextPhase: "v23Ready",
      outcome: "verified",
      cleanFlushReceiptId: imported.receipt.cleanFlushReceiptId
    });
    this.#throwIfStartupCancelled();
    if (!ready.ok) return pending(verifying, ready.stableErrorCode);
    return Object.freeze({ status: "v23-ready", journal: ready.journal });
  }

  async #beginImport(
    exported: RoleSessionMigrationRecord
  ): Promise<ImportBeginResult> {
    this.#throwIfStartupCancelled();
    const input: RoleSessionMigrationImportBeginInputInternal = {
      roleId: exported.roleId,
      transferId: exported.transferId,
      expectedJournalRevision: exported.journalRevision
    };
    let committed: RoleSessionMigrationRecord;
    try {
      committed = await this.#input.core.beginRoleSessionMigrationImportInternal(input);
    } catch (error) {
      if (error instanceof RionBridgeError) throw error;
      return Object.freeze({
        ok: false,
        stableErrorCode:
          "CHROMIUM_SESSION_MIGRATION_IMPORT_BEGIN_INDETERMINATE"
      });
    }
    this.#throwIfStartupCancelled();
    const snapshot = committed && Object.freeze({ ...committed });
    try {
      if (!snapshot || !importBeginResponseMatches(exported, snapshot)) {
        throw new Error("The Rust import admission acknowledgement is not exact.");
      }
      validateResumableJournal(snapshot, this.#input.expectedPlatform);
    } catch {
      return Object.freeze({
        ok: false,
        stableErrorCode:
          "CHROMIUM_SESSION_MIGRATION_IMPORT_BEGIN_INDETERMINATE"
      });
    }
    return Object.freeze({ ok: true, journal: snapshot });
  }

  async #transition(
    current: RoleSessionMigrationRecord,
    evidence: CompleteJournalEvidence,
    submission: TransitionSubmission
  ): Promise<TransitionResult> {
    this.#throwIfStartupCancelled();
    let transitionId: string;
    let occurredAt: string;
    try {
      transitionId = (this.#input.nextTransitionId ?? randomUUID)();
      occurredAt = (this.#input.now ?? (() => new Date().toISOString()))();
    } catch {
      return Object.freeze({
        ok: false,
        stableErrorCode: "CHROMIUM_SESSION_MIGRATION_RESUME_PORT_INVALID"
      });
    }
    if (!canonicalUuid(transitionId) || !canonicalTimestamp(occurredAt)) {
      return Object.freeze({
        ok: false,
        stableErrorCode: "CHROMIUM_SESSION_MIGRATION_RESUME_PORT_INVALID"
      });
    }
    const input: RoleSessionMigrationTargetTransitionInputInternal = {
      roleId: current.roleId,
      transferId: current.transferId,
      transitionId,
      expectedPhase: current.phase,
      expectedJournalRevision: current.journalRevision,
      nextPhase: submission.nextPhase,
      ...(submission.stableErrorCode
        ? { stableErrorCode: submission.stableErrorCode }
        : {}),
      ...(submission.outcome ? { outcome: submission.outcome } : {}),
      ...(submission.cleanFlushReceiptId
        ? { cleanFlushReceiptId: submission.cleanFlushReceiptId }
        : {}),
      occurredAt
    };
    let committed: RoleSessionMigrationRecord;
    try {
      committed = await this.#input.core
        .transitionRoleSessionMigrationTargetInternal(input);
    } catch (error) {
      if (error instanceof RionBridgeError) throw error;
      return Object.freeze({
        ok: false,
        stableErrorCode:
          "CHROMIUM_SESSION_MIGRATION_RESUME_TRANSITION_INDETERMINATE"
      });
    }
    this.#throwIfStartupCancelled();
    const snapshot = committed && Object.freeze({ ...committed });
    if (!snapshot || !transitionResponseMatches(current, evidence, input, snapshot)) {
      return Object.freeze({
        ok: false,
        stableErrorCode:
          "CHROMIUM_SESSION_MIGRATION_RESUME_TRANSITION_INDETERMINATE"
      });
    }
    return Object.freeze({ ok: true, journal: snapshot });
  }

  #throwIfStartupCancelled(): void {
    if (!this.#input.startupSignal?.aborted) return;
    throw coordinatorError(
      "CHROMIUM_SESSION_MIGRATION_RESUME_CANCELLED",
      "Application shutdown cancelled startup migration after native work drained."
    );
  }
}
