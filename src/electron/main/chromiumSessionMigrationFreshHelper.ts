import { createHash, randomUUID } from "node:crypto";

import type { Cookie, CookiesSetDetails } from "electron";

import type { RoleSessionMigrationRecord } from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";
import {
  parseChromiumSessionMigrationEnvelope,
  type ChromiumSessionMigrationCookie,
  type ChromiumSessionMigrationLocalStorageEntry,
  type ParsedChromiumSessionMigrationInventory
} from "./chromiumSessionMigrationCodec";
import {
  chromiumSessionMigrationFreshHelperResponseMetadata,
  type ChromiumSessionMigrationFreshHelperRequest
} from "./chromiumSessionMigrationFreshHelperContract";
import {
  ChromiumSessionMigrationLocalStorageCodec,
  type ChromiumMigrationWebContentsViewFactoryPort
} from "./chromiumSessionMigrationLocalStorage";
import {
  ChromiumRoleSessionRegistry,
  type ChromiumRoleSessionMigrationLease,
  type ChromiumRoleSessionPort,
  type ChromiumSessionFactoryPort
} from "./chromiumRoleSessionRegistry";
import { ChromiumSessionOwnershipLedger } from
  "./chromiumSessionOwnershipLedger";

type RuntimePlatform = "darwin" | "win32";

export interface ChromiumSessionMigrationFreshHelperInput {
  readonly platform: RuntimePlatform;
  readonly sessions: ChromiumSessionFactoryPort;
  readonly views: ChromiumMigrationWebContentsViewFactoryPort;
}

export interface ChromiumSessionMigrationFreshHelperResult {
  readonly outcome: "applied" | "failed" | "indeterminate";
  readonly metadataBytes: Buffer;
  readonly secretBytes: Buffer;
}

function helperError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function expectedPlatform(platform: RuntimePlatform): "macos" | "windows" {
  return platform === "darwin" ? "macos" : "windows";
}

function cookieUrl(cookie: ChromiumSessionMigrationCookie): string {
  const scheme = cookie.secure ? "https" : "http";
  const host = cookie.domain.includes(":") && !cookie.domain.startsWith("[")
    ? `[${cookie.domain}]`
    : cookie.domain;
  return `${scheme}://${host}${cookie.path}`;
}

function cookieSetDetails(
  cookie: ChromiumSessionMigrationCookie
): CookiesSetDetails {
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
    sameSite: cookie.sameSite === "none" ? "no_restriction" : cookie.sameSite
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

function normalizeCookie(cookie: Cookie): ChromiumSessionMigrationCookie {
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
    throw helperError(
      "CHROMIUM_SESSION_MIGRATION_FRESH_COOKIE_READBACK_INVALID",
      "The fresh helper could not represent Chromium's cookie readback exactly."
    );
  }
  const sameSite = cookie.sameSite === "no_restriction"
    ? "none"
    : cookie.sameSite;
  if (!new Set(["unspecified", "none", "lax", "strict"]).has(sameSite)) {
    throw helperError(
      "CHROMIUM_SESSION_MIGRATION_FRESH_COOKIE_READBACK_INVALID",
      "The fresh helper could not represent Chromium's cookie readback exactly."
    );
  }
  let expiryUnixMs: number | null = null;
  if (!cookie.session) {
    if (!Number.isFinite(cookie.expirationDate)) {
      throw helperError(
        "CHROMIUM_SESSION_MIGRATION_FRESH_COOKIE_READBACK_INVALID",
        "The fresh helper received an inexact cookie expiry."
      );
    }
    expiryUnixMs = Math.round(cookie.expirationDate! * 1_000);
    if (!Number.isSafeInteger(expiryUnixMs) || expiryUnixMs < 0) {
      throw helperError(
        "CHROMIUM_SESSION_MIGRATION_FRESH_COOKIE_READBACK_INVALID",
        "The fresh helper received an inexact cookie expiry."
      );
    }
  }
  return Object.freeze({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain.replace(/^\./u, ""),
    path: cookie.path,
    hostOnly: cookie.hostOnly,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    expiryUnixMs,
    sameSite: sameSite as ChromiumSessionMigrationCookie["sameSite"]
  });
}

async function readCookies(
  session: ChromiumRoleSessionPort
): Promise<ChromiumSessionMigrationCookie[]> {
  return sortCookies((await session.cookies.get({})).map(normalizeCookie));
}

function exactCookies(
  actual: readonly ChromiumSessionMigrationCookie[],
  expected: readonly ChromiumSessionMigrationCookie[]
): boolean {
  return JSON.stringify(sortCookies(actual)) ===
    JSON.stringify(sortCookies(expected));
}

function sortEntries(
  entries: readonly ChromiumSessionMigrationLocalStorageEntry[]
): ChromiumSessionMigrationLocalStorageEntry[] {
  return [...entries].sort((left, right) => compareText(left.key, right.key));
}

function exactEntries(
  actual: readonly ChromiumSessionMigrationLocalStorageEntry[],
  expected: readonly ChromiumSessionMigrationLocalStorageEntry[]
): boolean {
  return JSON.stringify(sortEntries(actual)) ===
    JSON.stringify(sortEntries(expected));
}

function expectationJournal(
  request: ChromiumSessionMigrationFreshHelperRequest
): RoleSessionMigrationRecord {
  return {
    roleId: request.roleId,
    transferId: request.transferId,
    phase: request.phase,
    journalRevision: request.expectedJournalRevision,
    platform: request.platform,
    sourceEngine: request.platform === "macos" ? "wkwebview" : "webview2",
    targetEngine: "chromium",
    sourceRevision: request.sourceRevision,
    targetRevision: request.targetRevision,
    envelopeSha256: request.envelopeSha256,
    inventorySha256: request.inventorySha256,
    cookieCount: request.cookieCount,
    localStorageOriginCount: request.localStorageOriginCount,
    localStorageEntryCount: request.localStorageEntryCount,
    startedAt: "1970-01-01T00:00:00.000Z",
    phaseChangedAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
    ...(request.committedReceiptId
      ? { cleanFlushReceiptId: request.committedReceiptId }
      : {})
  };
}

function parseInventory(
  request: ChromiumSessionMigrationFreshHelperRequest,
  envelopeBytes: Buffer
): ParsedChromiumSessionMigrationInventory {
  if (
    envelopeBytes.byteLength !== request.envelopeBytes ||
    request.localStorageOriginCount < 1 ||
    request.localStorageEntryCount < 1
  ) {
    throw helperError(
      "CHROMIUM_SESSION_MIGRATION_FRESH_HELPER_SECRET_INVALID",
      "The helper did not receive its exact non-empty LocalStorage envelope."
    );
  }
  return parseChromiumSessionMigrationEnvelope(envelopeBytes, {
    journal: expectationJournal(request),
    platform: request.platform
  });
}

function wantsImportedState(
  request: ChromiumSessionMigrationFreshHelperRequest
): boolean {
  return request.kind === "apply" || request.kind === "verify" ||
    request.kind === "resumeVerify";
}

async function replaceState(
  session: ChromiumRoleSessionPort,
  localStorage: ChromiumSessionMigrationLocalStorageCodec,
  inventory: ParsedChromiumSessionMigrationInventory,
  imported: boolean
): Promise<void> {
  await session.clearStorageData({ storages: ["cookies", "localstorage"] });
  await session.cookies.flushStore();
  if ((await readCookies(session)).length !== 0) {
    throw helperError(
      "CHROMIUM_SESSION_MIGRATION_FRESH_CLEAR_FAILED",
      "The helper could not prove that the destination cookie store was empty."
    );
  }
  if (imported) {
    for (const cookie of inventory.cookies) {
      await session.cookies.set(cookieSetDetails(cookie));
    }
    await session.cookies.flushStore();
    if (!exactCookies(await readCookies(session), inventory.cookies)) {
      throw helperError(
        "CHROMIUM_SESSION_MIGRATION_FRESH_COOKIE_READBACK_MISMATCH",
        "The helper did not read back the exact imported cookie inventory."
      );
    }
  }
  for (const origin of inventory.localStorage) {
    const expected = imported ? origin.entries : [];
    const actual = imported
      ? await localStorage.replaceAndReadback(session, origin.origin, expected)
      : await localStorage.readback(session, origin.origin);
    if (!exactEntries(actual, expected)) {
      throw helperError(
        "CHROMIUM_SESSION_MIGRATION_FRESH_LOCAL_STORAGE_READBACK_MISMATCH",
        "The helper did not read back the exact LocalStorage inventory."
      );
    }
  }
  session.flushStorageData();
}

async function verifyState(
  session: ChromiumRoleSessionPort,
  localStorage: ChromiumSessionMigrationLocalStorageCodec,
  inventory: ParsedChromiumSessionMigrationInventory,
  imported: boolean
): Promise<void> {
  const expectedCookies = imported ? inventory.cookies : [];
  if (!exactCookies(await readCookies(session), expectedCookies)) {
    throw helperError(
      "CHROMIUM_SESSION_MIGRATION_FRESH_COOKIE_READBACK_MISMATCH",
      "The fresh verifier did not return the exact cookie inventory."
    );
  }
  for (const origin of inventory.localStorage) {
    const expected = imported ? origin.entries : [];
    const actual = await localStorage.readback(session, origin.origin);
    if (!exactEntries(actual, expected)) {
      throw helperError(
        "CHROMIUM_SESSION_MIGRATION_FRESH_LOCAL_STORAGE_READBACK_MISMATCH",
        "The fresh verifier did not return the exact LocalStorage inventory."
      );
    }
  }
}

function surfaceDrainDigest(
  request: ChromiumSessionMigrationFreshHelperRequest,
  imported: boolean
): string {
  return createHash("sha256").update([
    "rion-session-migration-helper-drain-v1",
    request.kind,
    request.roleId,
    request.transferId,
    request.expectedJournalRevision,
    request.targetRevision,
    request.inventorySha256,
    imported ? "imported" : "empty",
    process.pid
  ].join("\0"), "utf8").digest("hex");
}

function stableErrorCode(error: unknown): string {
  return error instanceof RionBridgeError &&
    /^CHROMIUM_SESSION_MIGRATION_[A-Z0-9_]+$/u.test(error.code)
    ? error.code
    : "CHROMIUM_SESSION_MIGRATION_FRESH_HELPER_FAILED";
}

export class ChromiumSessionMigrationFreshHelper {
  readonly #input: ChromiumSessionMigrationFreshHelperInput;

  constructor(input: ChromiumSessionMigrationFreshHelperInput) {
    this.#input = input;
  }

  async run(
    request: ChromiumSessionMigrationFreshHelperRequest,
    envelopeBytes: Buffer
  ): Promise<ChromiumSessionMigrationFreshHelperResult> {
    const ownership = new ChromiumSessionOwnershipLedger(this.#input.platform);
    const registry = new ChromiumRoleSessionRegistry(
      this.#input.sessions,
      this.#input.platform,
      ownership
    );
    let inventory: ParsedChromiumSessionMigrationInventory;
    try {
      if (request.platform !== expectedPlatform(this.#input.platform)) {
        throw helperError(
          "CHROMIUM_SESSION_MIGRATION_FRESH_HELPER_PLATFORM_MISMATCH",
          "The helper process platform does not match the migration journal."
        );
      }
      inventory = parseInventory(request, envelopeBytes);
    } catch (error) {
      envelopeBytes.fill(0);
      return Object.freeze({
        outcome: "failed",
        metadataBytes: chromiumSessionMigrationFreshHelperResponseMetadata(
          request,
          { stableErrorCode: stableErrorCode(error) }
        ),
        secretBytes: Buffer.alloc(0)
      });
    }
    envelopeBytes.fill(0);

    let lease: ChromiumRoleSessionMigrationLease | null = null;
    let mutationStarted = false;
    let releaseUnknown = false;
    try {
      lease = registry.acquireMigrationSession({
        roleId: request.roleId,
        rolePaths: request.rolePaths,
        transferId: request.transferId,
        targetRevision: request.targetRevision
      });
      const localStorage = new ChromiumSessionMigrationLocalStorageCodec(
        this.#input.views
      );
      const imported = wantsImportedState(request);
      if (request.kind === "apply" || request.kind === "rollback") {
        mutationStarted = true;
        await replaceState(lease.session, localStorage, inventory, imported);
      } else {
        await verifyState(lease.session, localStorage, inventory, imported);
      }
      const released = await registry.releaseMigrationSession(lease);
      if (!released) {
        throw helperError(
          "CHROMIUM_SESSION_MIGRATION_FRESH_HELPER_RELEASE_INDETERMINATE",
          "The helper could not prove exact native session release."
        );
      }
      lease = null;
      await registry.dispose();
      const readbackEntryCount = imported
        ? inventory.localStorage.reduce(
          (total, origin) => total + origin.entries.length,
          0
        )
        : 0;
      return Object.freeze({
        outcome: "applied",
        metadataBytes: chromiumSessionMigrationFreshHelperResponseMetadata(
          request,
          {
            readbackCookieCount: imported ? inventory.cookies.length : 0,
            checkedLocalStorageOriginCount: inventory.localStorage.length,
            readbackLocalStorageEntryCount: readbackEntryCount,
            surfaceDrainEvidenceSha256: surfaceDrainDigest(request, imported),
            ...(
              request.kind === "verify" ||
              request.kind === "resumeVerify" ||
              request.kind === "rollbackVerify"
                ? { verifierInstanceId: randomUUID() }
                : {}
            ),
            ...(request.parentExitEvidenceSha256
              ? { parentExitEvidenceSha256: request.parentExitEvidenceSha256 }
              : {}),
            ...(request.committedReceiptId
              ? { committedReceiptId: request.committedReceiptId }
              : {})
          }
        ),
        secretBytes: Buffer.alloc(0)
      });
    } catch (error) {
      if (lease) {
        try {
          await registry.releaseMigrationSession(lease);
          lease = null;
        } catch {
          releaseUnknown = true;
        }
      }
      return Object.freeze({
        outcome: mutationStarted || releaseUnknown ? "indeterminate" : "failed",
        metadataBytes: chromiumSessionMigrationFreshHelperResponseMetadata(
          request,
          {
            stableErrorCode: releaseUnknown
              ? "CHROMIUM_SESSION_MIGRATION_FRESH_HELPER_RELEASE_INDETERMINATE"
              : stableErrorCode(error)
          }
        ),
        secretBytes: Buffer.alloc(0)
      });
    }
  }
}
