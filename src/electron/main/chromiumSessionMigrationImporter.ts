import type { Cookie, CookiesSetDetails } from "electron";

import type {
  CoreCommand,
  CoreCommandResult,
  RolePathsRecord,
  RoleSessionMigrationPlatform,
  RoleSessionMigrationRecord
} from "../../shared/generated";
import type { ChromeProfileImportHelperProcessResultInternal } from
  "../core/coreAddonClient";
import { RionBridgeError } from "../ipc/errors";
import {
  parseChromiumSessionMigrationEnvelope,
  type ChromiumSessionMigrationCookie,
  type ParsedChromiumSessionMigrationInventory
} from "./chromiumSessionMigrationCodec";
import {
  ChromiumRoleSessionRegistry,
  type ChromiumRoleSessionPort
} from "./chromiumRoleSessionRegistry";
import {
  ChromiumSessionMigrationFreshCoordinator,
  type ChromiumSessionMigrationFreshDescriptor
} from "./chromiumSessionMigrationFreshCoordinator";

type RuntimePlatform = "darwin" | "win32";

export interface ChromiumSessionMigrationCorePort {
  invoke: <Command extends CoreCommand>(
    command: Command
  ) => Promise<CoreCommandResult<Command>>;
  readRoleSessionTransferVaultInternal: (
    roleId: string,
    transferId: string
  ) => Promise<Buffer>;
  launchChromeProfileImportHelperInternal: (
    metadataBytes: Buffer,
    secretBytes: Buffer,
    signal?: AbortSignal
  ) => Promise<ChromeProfileImportHelperProcessResultInternal>;
}

export interface ChromiumSessionMigrationImportInput {
  readonly roleId: string;
  readonly transferId: string;
  readonly expectedJournalRevision: number;
  readonly targetRevision: number;
}

export interface ChromiumSessionMigrationAppliedReceipt {
  readonly roleId: string;
  readonly transferId: string;
  readonly targetRevision: number;
  readonly inventorySha256: string;
  readonly cookieCount: number;
  readonly localStorageOriginCount: number;
  readonly localStorageEntryCount: number;
  readonly cleanFlushReceiptId: string;
}

export type ChromiumSessionMigrationImportResult =
  | Readonly<{
    status: "applied";
    receipt: ChromiumSessionMigrationAppliedReceipt;
  }>
  | Readonly<{
    status: "failed";
    stableErrorCode: string;
    rollback: "not-required" | "applied";
  }>
  | Readonly<{
    status: "indeterminate";
    stableErrorCode: string;
    rollback: "unknown";
  }>;

interface InFlightImport {
  readonly identityKey: string;
  readonly promise: Promise<ChromiumSessionMigrationImportResult>;
}

function migrationError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function validateIdentity(input: ChromiumSessionMigrationImportInput): void {
  const canonicalUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
  if (
    !canonicalUuid.test(input.roleId) ||
    !canonicalUuid.test(input.transferId)
  ) {
    throw migrationError(
      "CHROMIUM_SESSION_MIGRATION_IDENTITY_INVALID",
      "Canonical Rust-owned role and transfer IDs are required for session migration."
    );
  }
  if (
    !Number.isSafeInteger(input.expectedJournalRevision) ||
    input.expectedJournalRevision < 1 ||
    !Number.isSafeInteger(input.targetRevision) ||
    input.targetRevision < 1
  ) {
    throw migrationError(
      "CHROMIUM_SESSION_MIGRATION_REVISION_INVALID",
      "Positive Rust-owned journal and target revisions are required for session migration."
    );
  }
}

function expectedPlatform(platform: RuntimePlatform): RoleSessionMigrationPlatform {
  return platform === "darwin" ? "macos" : "windows";
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function validateJournal(
  journal: RoleSessionMigrationRecord | null,
  input: ChromiumSessionMigrationImportInput,
  platform: RoleSessionMigrationPlatform
): asserts journal is RoleSessionMigrationRecord {
  if (!journal) {
    throw migrationError(
      "CHROMIUM_SESSION_MIGRATION_JOURNAL_NOT_FOUND",
      "The current role session migration journal is not available."
    );
  }
  const expectedSourceEngine = platform === "macos" ? "wkwebview" : "webview2";
  if (
    journal.roleId !== input.roleId ||
    journal.transferId !== input.transferId ||
    journal.platform !== platform ||
    journal.sourceEngine !== expectedSourceEngine ||
    journal.targetEngine !== "chromium"
  ) {
    throw migrationError(
      "CHROMIUM_SESSION_MIGRATION_IDENTITY_MISMATCH",
      "The current migration journal does not match the requested Chromium import."
    );
  }
  if (
    journal.journalRevision !== input.expectedJournalRevision ||
    journal.targetRevision !== input.targetRevision
  ) {
    throw migrationError(
      "CHROMIUM_SESSION_MIGRATION_REVISION_STALE",
      "The Chromium import revision is no longer current."
    );
  }
  if (
    journal.phase !== "importing" &&
    journal.phase !== "verifying" &&
    journal.phase !== "indeterminate"
  ) {
    throw migrationError(
      "CHROMIUM_SESSION_MIGRATION_PHASE_STALE",
      "The Chromium import phase is no longer current."
    );
  }
  if (journal.phase === "indeterminate" && (
    typeof journal.stableErrorCode !== "string" ||
    !/^[A-Z][A-Z0-9_]{0,95}$/u.test(journal.stableErrorCode) ||
    journal.outcome !== "indeterminate" ||
    !canonicalTimestamp(journal.outcomeAt) ||
    journal.outcomeAt !== journal.phaseChangedAt ||
    journal.firstVerifiedLaunchAt !== undefined ||
    journal.resetReceiptId !== undefined
  )) {
    throw migrationError(
      "CHROMIUM_SESSION_MIGRATION_JOURNAL_INVALID",
      "The indeterminate Chromium import journal is not a complete terminal record."
    );
  }
  const receiptId = cleanFlushReceiptId(input.transferId, input.targetRevision);
  const hasLocalStorage = (journal.localStorageOriginCount ?? 0) > 0 ||
    (journal.localStorageEntryCount ?? 0) > 0;
  const verifyingReceiptMatches = hasLocalStorage
    ? typeof journal.cleanFlushReceiptId === "string" &&
      /^chromium-session-fresh:[0-9a-f]{64}$/u
        .test(journal.cleanFlushReceiptId)
    : journal.cleanFlushReceiptId === receiptId;
  if (
    (journal.phase === "importing" && journal.cleanFlushReceiptId !== undefined) ||
    (journal.phase === "verifying" && !verifyingReceiptMatches) ||
    (journal.phase === "indeterminate" &&
      journal.cleanFlushReceiptId !== undefined &&
      !verifyingReceiptMatches)
  ) {
    throw migrationError(
      "CHROMIUM_SESSION_MIGRATION_RECEIPT_MISMATCH",
      "The current migration journal does not contain the exact Chromium flush receipt."
    );
  }
}

function identityKey(input: ChromiumSessionMigrationImportInput): string {
  return [
    input.roleId,
    input.transferId,
    input.expectedJournalRevision,
    input.targetRevision
  ].join(":");
}

function cleanFlushReceiptId(transferId: string, targetRevision: number): string {
  return `chromium-cookie-flush:${transferId}:${targetRevision}`;
}

function cookieUrl(cookie: ChromiumSessionMigrationCookie): string {
  const scheme = cookie.secure ? "https" : "http";
  const host = cookie.domain.includes(":") && !cookie.domain.startsWith("[")
    ? `[${cookie.domain}]`
    : cookie.domain;
  return `${scheme}://${host}${cookie.path}`;
}

function cookieSetDetails(cookie: ChromiumSessionMigrationCookie): CookiesSetDetails {
  const sameSite = cookie.sameSite === "none"
    ? "no_restriction"
    : cookie.sameSite;
  return {
    url: cookieUrl(cookie),
    name: cookie.name,
    value: cookie.value,
    ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    ...(cookie.expiryUnixMs === null
      ? {}
      : { expirationDate: cookie.expiryUnixMs / 1_000 }),
    sameSite
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortCookies(
  cookies: readonly ChromiumSessionMigrationCookie[]
): ChromiumSessionMigrationCookie[] {
  return [...cookies].sort((left, right) =>
    compareText(left.domain, right.domain) ||
    compareText(left.path, right.path) ||
    compareText(left.name, right.name)
  );
}

function normalizeReadbackCookie(cookie: Cookie): ChromiumSessionMigrationCookie | null {
  if (
    typeof cookie.name !== "string" ||
    typeof cookie.value !== "string" ||
    typeof cookie.domain !== "string" ||
    typeof cookie.path !== "string" ||
    typeof cookie.hostOnly !== "boolean" ||
    typeof cookie.secure !== "boolean" ||
    typeof cookie.httpOnly !== "boolean" ||
    typeof cookie.session !== "boolean"
  ) {
    return null;
  }
  const domain = cookie.domain.startsWith(".")
    ? cookie.domain.slice(1)
    : cookie.domain;
  const sameSite = cookie.sameSite === "no_restriction"
    ? "none"
    : cookie.sameSite;
  if (!new Set(["unspecified", "none", "lax", "strict"]).has(sameSite)) {
    return null;
  }
  let expiryUnixMs: number | null = null;
  if (!cookie.session) {
    if (!Number.isFinite(cookie.expirationDate)) return null;
    expiryUnixMs = Math.round(cookie.expirationDate! * 1_000);
    if (!Number.isSafeInteger(expiryUnixMs) || expiryUnixMs < 0) return null;
  }
  return {
    name: cookie.name,
    value: cookie.value,
    domain,
    path: cookie.path,
    hostOnly: cookie.hostOnly,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    expiryUnixMs,
    sameSite: sameSite as ChromiumSessionMigrationCookie["sameSite"]
  };
}

async function cookiesMatch(
  session: ChromiumRoleSessionPort,
  expected: readonly ChromiumSessionMigrationCookie[]
): Promise<boolean> {
  const readback = await session.cookies.get({});
  const normalized = readback.map(normalizeReadbackCookie);
  if (normalized.some((cookie) => cookie === null)) return false;
  return JSON.stringify(sortCookies(normalized as ChromiumSessionMigrationCookie[])) ===
    JSON.stringify(sortCookies(expected));
}

async function rollbackCookies(session: ChromiumRoleSessionPort): Promise<boolean> {
  try {
    await session.clearStorageData({ storages: ["cookies", "localstorage"] });
    await session.cookies.flushStore();
    return (await session.cookies.get({})).length === 0;
  } catch {
    return false;
  }
}

async function applyCookies(
  session: ChromiumRoleSessionPort,
  inventory: ParsedChromiumSessionMigrationInventory,
  targetRevision: number
): Promise<ChromiumSessionMigrationImportResult> {
  try {
    await session.clearStorageData({ storages: ["cookies", "localstorage"] });
    await session.cookies.flushStore();
    if ((await session.cookies.get({})).length !== 0) {
      throw new Error("target-cookie-store-not-empty");
    }
    for (const cookie of inventory.cookies) {
      await session.cookies.set(cookieSetDetails(cookie));
    }
    await session.cookies.flushStore();
    if (!await cookiesMatch(session, inventory.cookies)) {
      throw new Error("cookie-readback-mismatch");
    }
    return Object.freeze({
      status: "applied",
      receipt: Object.freeze({
        roleId: inventory.roleId,
        transferId: inventory.transferId,
        targetRevision,
        inventorySha256: inventory.inventorySha256,
        cookieCount: inventory.cookies.length,
        localStorageOriginCount: 0 as const,
        localStorageEntryCount: 0 as const,
        cleanFlushReceiptId: cleanFlushReceiptId(
          inventory.transferId,
          targetRevision
        )
      })
    });
  } catch {
    if (await rollbackCookies(session)) {
      return Object.freeze({
        status: "failed",
        stableErrorCode: "CHROMIUM_SESSION_MIGRATION_COOKIE_APPLY_FAILED",
        rollback: "applied"
      });
    }
    return Object.freeze({
      status: "indeterminate",
      stableErrorCode: "CHROMIUM_SESSION_MIGRATION_COOKIE_ROLLBACK_INDETERMINATE",
      rollback: "unknown"
    });
  }
}

function freshDescriptor(
  journal: RoleSessionMigrationRecord,
  rolePaths: RolePathsRecord,
  inventory: ParsedChromiumSessionMigrationInventory,
  input: ChromiumSessionMigrationImportInput
): ChromiumSessionMigrationFreshDescriptor {
  return Object.freeze({
    platform: journal.platform,
    roleId: input.roleId,
    transferId: input.transferId,
    expectedJournalRevision: input.expectedJournalRevision,
    targetRevision: input.targetRevision,
    sourceRevision: journal.sourceRevision,
    phase: journal.phase as "importing" | "verifying" | "indeterminate",
    rolePaths: Object.freeze({ ...rolePaths }),
    envelopeSha256: inventory.envelopeSha256,
    inventorySha256: inventory.inventorySha256,
    cookieCount: inventory.cookies.length,
    localStorageOriginCount: inventory.localStorage.length,
    localStorageEntryCount: inventory.localStorage.reduce(
      (total, origin) => total + origin.entries.length,
      0
    )
  });
}

function stableFreshFailureCode(error: unknown): string {
  return error instanceof RionBridgeError &&
    /^CHROMIUM_SESSION_MIGRATION_[A-Z0-9_]+$/u.test(error.code)
    ? error.code
    : "CHROMIUM_SESSION_MIGRATION_FRESH_HELPER_FAILED";
}

function freshAppliedResult(
  inventory: ParsedChromiumSessionMigrationInventory,
  input: ChromiumSessionMigrationImportInput,
  receiptId: string
): ChromiumSessionMigrationImportResult {
  return Object.freeze({
    status: "applied",
    receipt: Object.freeze({
      roleId: inventory.roleId,
      transferId: inventory.transferId,
      targetRevision: input.targetRevision,
      inventorySha256: inventory.inventorySha256,
      cookieCount: inventory.cookies.length,
      localStorageOriginCount: inventory.localStorage.length,
      localStorageEntryCount: inventory.localStorage.reduce(
        (total, origin) => total + origin.entries.length,
        0
      ),
      cleanFlushReceiptId: receiptId
    })
  });
}

export class ChromiumSessionMigrationImporter {
  readonly #core: ChromiumSessionMigrationCorePort;
  readonly #platform: RuntimePlatform;
  readonly #sessions: ChromiumRoleSessionRegistry;
  readonly #startupSignal?: AbortSignal;
  readonly #inFlightByRole = new Map<string, InFlightImport>();

  constructor(
    core: ChromiumSessionMigrationCorePort,
    sessions: ChromiumRoleSessionRegistry,
    platform: RuntimePlatform,
    startupSignal?: AbortSignal
  ) {
    this.#core = core;
    this.#sessions = sessions;
    this.#platform = platform;
    this.#startupSignal = startupSignal;
  }

  importRole(
    input: ChromiumSessionMigrationImportInput
  ): Promise<ChromiumSessionMigrationImportResult> {
    validateIdentity(input);
    this.#throwIfStartupCancelled();
    const key = identityKey(input);
    const existing = this.#inFlightByRole.get(input.roleId);
    if (existing) {
      if (existing.identityKey === key) return existing.promise;
      return Promise.reject(migrationError(
        "CHROMIUM_SESSION_MIGRATION_OPERATION_CONFLICT",
        "Another Chromium session migration operation owns this role."
      ));
    }
    const promise = this.#importRole(input).finally(() => {
      if (this.#inFlightByRole.get(input.roleId)?.promise === promise) {
        this.#inFlightByRole.delete(input.roleId);
      }
    });
    this.#inFlightByRole.set(input.roleId, { identityKey: key, promise });
    return promise;
  }

  async #importRole(
    input: ChromiumSessionMigrationImportInput
  ): Promise<ChromiumSessionMigrationImportResult> {
    this.#throwIfStartupCancelled();
    const platform = expectedPlatform(this.#platform);
    const journal = await this.#readCurrentJournal(input, platform);
    this.#throwIfStartupCancelled();
    let rolePaths: RolePathsRecord;
    try {
      rolePaths = await this.#core.invoke({
        type: "rolePathsResolve",
        id: input.roleId
      });
    } catch {
      throw migrationError(
        "CHROMIUM_SESSION_MIGRATION_PATH_READ_FAILED",
        "The Rust-owned Chromium role-session path could not be read."
      );
    }
    this.#throwIfStartupCancelled();
    let envelopeBytes: Buffer;
    try {
      envelopeBytes = await this.#core.readRoleSessionTransferVaultInternal(
        input.roleId,
        input.transferId
      );
    } catch {
      throw migrationError(
        "CHROMIUM_SESSION_MIGRATION_VAULT_READ_FAILED",
        "The committed session-transfer inventory could not be read."
      );
    }
    let inventory: ParsedChromiumSessionMigrationInventory;
    try {
      this.#throwIfStartupCancelled();
      inventory = parseChromiumSessionMigrationEnvelope(envelopeBytes, {
        journal,
        platform
      });
      await this.#readCurrentJournal(input, platform);
      this.#throwIfStartupCancelled();
      return inventory.localStorage.length > 0
        ? await this.#importFreshLocalStorage(
          input,
          journal,
          rolePaths,
          inventory,
          envelopeBytes,
          platform
        )
        : await this.#importCookieOnly(
          input,
          journal,
          rolePaths,
          inventory,
          platform
        );
    } finally {
      envelopeBytes.fill(0);
    }
  }

  async #importFreshLocalStorage(
    input: ChromiumSessionMigrationImportInput,
    journal: RoleSessionMigrationRecord,
    rolePaths: RolePathsRecord,
    inventory: ParsedChromiumSessionMigrationInventory,
    envelopeBytes: Buffer,
    platform: RoleSessionMigrationPlatform
  ): Promise<ChromiumSessionMigrationImportResult> {
    const launch = this.#core.launchChromeProfileImportHelperInternal;
    const coordinator = new ChromiumSessionMigrationFreshCoordinator({
      launchChromeProfileImportHelperInternal: launch.bind(this.#core)
    });
    const descriptor = freshDescriptor(journal, rolePaths, inventory, input);
    let receiptId: string;
    try {
      if (journal.cleanFlushReceiptId) {
        receiptId = journal.cleanFlushReceiptId!;
        await coordinator.verifyCommitted(
          descriptor,
          envelopeBytes,
          receiptId,
          this.#startupSignal
        );
      } else {
        receiptId = await coordinator.applyAndVerify(
          descriptor,
          envelopeBytes,
          async () => {
            try {
              await this.#readCurrentJournal(input, platform);
            } catch {
              throw migrationError(
                "CHROMIUM_SESSION_MIGRATION_REVISION_FENCE_FAILED",
                "The migration journal changed before fresh verification."
              );
            }
          },
          this.#startupSignal
        );
      }
      try {
        await this.#readCurrentJournal(input, platform);
      } catch {
        throw migrationError(
          "CHROMIUM_SESSION_MIGRATION_REVISION_FENCE_FAILED",
          "The migration journal changed after fresh verification."
        );
      }
    } catch (error) {
      if (this.#startupSignal?.aborted) {
        return Object.freeze({
          status: "indeterminate",
          stableErrorCode: "CHROMIUM_SESSION_MIGRATION_STARTUP_CANCELLED",
          rollback: "unknown"
        });
      }
      if (journal.phase === "indeterminate" && journal.cleanFlushReceiptId) {
        return Object.freeze({
          status: "indeterminate",
          stableErrorCode: stableFreshFailureCode(error),
          rollback: "unknown"
        });
      }
      const rolledBack = await coordinator.rollbackAndVerify(
        descriptor,
        envelopeBytes,
        this.#startupSignal
      );
      if (!rolledBack) {
        return Object.freeze({
          status: "indeterminate",
          stableErrorCode:
            "CHROMIUM_SESSION_MIGRATION_LOCAL_STORAGE_ROLLBACK_INDETERMINATE",
          rollback: "unknown"
        });
      }
      return Object.freeze({
        status: "failed",
        stableErrorCode: stableFreshFailureCode(error),
        rollback: "applied"
      });
    }
    return freshAppliedResult(inventory, input, receiptId);
  }

  async #importCookieOnly(
    input: ChromiumSessionMigrationImportInput,
    journal: RoleSessionMigrationRecord,
    rolePaths: RolePathsRecord,
    inventory: ParsedChromiumSessionMigrationInventory,
    platform: RoleSessionMigrationPlatform
  ): Promise<ChromiumSessionMigrationImportResult> {
    let lease;
    try {
      lease = this.#sessions.acquireMigrationSession({
        roleId: input.roleId,
        rolePaths,
        transferId: input.transferId,
        targetRevision: input.targetRevision
      });
    } catch (error) {
      const stableCode = error instanceof RionBridgeError && new Set([
        "CHROMIUM_SESSION_MIGRATION_LEASE_CONFLICT",
        "CHROMIUM_SESSION_MIGRATION_SESSION_ACTIVE"
      ]).has(error.code)
        ? error.code
        : "CHROMIUM_SESSION_MIGRATION_SESSION_ACQUIRE_FAILED";
      throw migrationError(
        stableCode,
        "The exact Chromium role session could not be leased for migration."
      );
    }
    let result: ChromiumSessionMigrationImportResult;
    if (journal.cleanFlushReceiptId) {
      try {
        if (!await cookiesMatch(lease.session, inventory.cookies)) {
          throw new Error("cookie-readback-mismatch");
        }
        result = freshAppliedResult(
          inventory,
          input,
          journal.cleanFlushReceiptId
        );
      } catch {
        if (journal.phase === "indeterminate") {
          result = Object.freeze({
            status: "indeterminate",
            stableErrorCode:
              "CHROMIUM_SESSION_MIGRATION_COOKIE_VERIFY_INDETERMINATE",
            rollback: "unknown"
          });
        } else if (await rollbackCookies(lease.session)) {
          result = Object.freeze({
            status: "failed",
            stableErrorCode: "CHROMIUM_SESSION_MIGRATION_COOKIE_VERIFY_FAILED",
            rollback: "applied"
          });
        } else {
          result = Object.freeze({
            status: "indeterminate",
            stableErrorCode:
              "CHROMIUM_SESSION_MIGRATION_COOKIE_ROLLBACK_INDETERMINATE",
            rollback: "unknown"
          });
        }
      }
    } else {
      result = await applyCookies(
        lease.session,
        inventory,
        input.targetRevision
      );
    }
    if (result.status === "applied") {
      try {
        await this.#readCurrentJournal(input, platform);
      } catch {
        if (journal.phase === "indeterminate" && journal.cleanFlushReceiptId) {
          result = Object.freeze({
            status: "indeterminate",
            stableErrorCode:
              "CHROMIUM_SESSION_MIGRATION_REVISION_FENCE_FAILED",
            rollback: "unknown"
          });
        } else if (!await rollbackCookies(lease.session)) {
          result = Object.freeze({
            status: "indeterminate",
            stableErrorCode:
              "CHROMIUM_SESSION_MIGRATION_REVISION_ROLLBACK_INDETERMINATE",
            rollback: "unknown"
          });
        } else {
          result = Object.freeze({
            status: "failed",
            stableErrorCode: "CHROMIUM_SESSION_MIGRATION_REVISION_FENCE_FAILED",
            rollback: "applied"
          });
        }
      }
    }
    try {
      if (await this.#sessions.releaseMigrationSession(lease) !== true) {
        throw new Error("migration-session-release-not-exact");
      }
    } catch {
      result = Object.freeze({
        status: "indeterminate",
        stableErrorCode: "CHROMIUM_SESSION_MIGRATION_RELEASE_INDETERMINATE",
        rollback: "unknown"
      });
    }
    this.#throwIfStartupCancelled();
    return result;
  }

  #throwIfStartupCancelled(): void {
    if (!this.#startupSignal?.aborted) return;
    throw migrationError(
      "CHROMIUM_SESSION_MIGRATION_STARTUP_CANCELLED",
      "Startup cancelled session migration after its active native work drained."
    );
  }

  async #readCurrentJournal(
    input: ChromiumSessionMigrationImportInput,
    platform: RoleSessionMigrationPlatform
  ): Promise<RoleSessionMigrationRecord> {
    let journal: RoleSessionMigrationRecord | null;
    try {
      journal = await this.#core.invoke({
        type: "roleSessionMigrationGet",
        roleId: input.roleId
      });
    } catch {
      throw migrationError(
        "CHROMIUM_SESSION_MIGRATION_JOURNAL_READ_FAILED",
        "The current role session migration journal could not be read."
      );
    }
    validateJournal(journal, input, platform);
    return journal;
  }
}
