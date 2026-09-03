import { createHash } from "node:crypto";

import type {
  RolePathsRecord,
  RoleSessionMigrationPlatform
} from "../../shared/generated";
import type { ChromeProfileImportHelperProcessResultInternal } from
  "../core/coreAddonClient";
import { RionBridgeError } from "../ipc/errors";
import {
  encodeChromiumSessionMigrationFreshHelperRequest,
  SESSION_MIGRATION_FRESH_HELPER_FAMILY,
  type ChromiumSessionMigrationFreshHelperKind,
  type ChromiumSessionMigrationFreshHelperRequest
} from "./chromiumSessionMigrationFreshHelperContract";

export interface ChromiumSessionMigrationFreshLauncherPort {
  launchChromeProfileImportHelperInternal: (
    metadataBytes: Buffer,
    secretBytes: Buffer,
    signal?: AbortSignal
  ) => Promise<ChromeProfileImportHelperProcessResultInternal>;
}

export interface ChromiumSessionMigrationFreshDescriptor {
  readonly platform: RoleSessionMigrationPlatform;
  readonly roleId: string;
  readonly transferId: string;
  readonly expectedJournalRevision: number;
  readonly targetRevision: number;
  readonly sourceRevision: number;
  readonly phase: "importing" | "verifying" | "indeterminate";
  readonly rolePaths: RolePathsRecord;
  readonly envelopeSha256: string;
  readonly inventorySha256: string;
  readonly cookieCount: number;
  readonly localStorageOriginCount: number;
  readonly localStorageEntryCount: number;
}

export interface ChromiumSessionMigrationFreshProcessReceipt {
  readonly exitEvidenceSha256: string;
  readonly surfaceDrainEvidenceSha256: string;
  readonly verifierInstanceId?: string;
}

const SHA256 = /^[0-9a-f]{64}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function coordinatorError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function invalidReceipt(): RionBridgeError {
  return coordinatorError(
    "CHROMIUM_SESSION_MIGRATION_FRESH_HELPER_RECEIPT_INVALID",
    "The fresh session-migration helper returned a non-canonical receipt."
  );
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidReceipt();
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const expected = new Set(keys);
  if (
    keys.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !expected.has(key))
  ) {
    throw invalidReceipt();
  }
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw invalidReceipt();
  }
}

function baseRequest(
  descriptor: ChromiumSessionMigrationFreshDescriptor,
  kind: ChromiumSessionMigrationFreshHelperKind,
  envelopeBytes: number,
  evidence?: string
): ChromiumSessionMigrationFreshHelperRequest {
  return Object.freeze({
    version: 1,
    family: SESSION_MIGRATION_FRESH_HELPER_FAMILY,
    kind,
    ...descriptor,
    envelopeBytes,
    ...(kind === "resumeVerify"
      ? { committedReceiptId: evidence }
      : kind === "verify" || kind === "rollbackVerify"
        ? { parentExitEvidenceSha256: evidence }
        : {})
  });
}

function commonResponseMatches(
  response: Record<string, unknown>,
  request: ChromiumSessionMigrationFreshHelperRequest
): boolean {
  return response.version === 1 &&
    response.family === SESSION_MIGRATION_FRESH_HELPER_FAMILY &&
    response.kind === request.kind &&
    response.platform === request.platform &&
    response.roleId === request.roleId &&
    response.transferId === request.transferId &&
    response.expectedJournalRevision === request.expectedJournalRevision &&
    response.targetRevision === request.targetRevision &&
    response.inventorySha256 === request.inventorySha256;
}

function successKeys(
  request: ChromiumSessionMigrationFreshHelperRequest
): string[] {
  const keys = [
    "version", "family", "kind", "platform", "roleId", "transferId",
    "expectedJournalRevision", "targetRevision", "inventorySha256",
    "readbackCookieCount", "checkedLocalStorageOriginCount",
    "readbackLocalStorageEntryCount", "surfaceDrainEvidenceSha256"
  ];
  if (new Set(["verify", "resumeVerify", "rollbackVerify"]).has(request.kind)) {
    keys.push("verifierInstanceId");
  }
  if (request.parentExitEvidenceSha256) keys.push("parentExitEvidenceSha256");
  if (request.committedReceiptId) keys.push("committedReceiptId");
  return keys;
}

function parseSuccess(
  result: ChromeProfileImportHelperProcessResultInternal,
  request: ChromiumSessionMigrationFreshHelperRequest
): ChromiumSessionMigrationFreshProcessReceipt {
  if (
    result.outcome !== "applied" ||
    result.secretBytes.byteLength !== 0 ||
    !SHA256.test(result.exitEvidenceSha256)
  ) {
    throw invalidReceipt();
  }
  const response = record(parseJson(result.metadataBytes));
  exactKeys(response, successKeys(request));
  const imported = new Set(["apply", "verify", "resumeVerify"])
    .has(request.kind);
  const expectedCookieCount = imported ? request.cookieCount : 0;
  const expectedEntryCount = imported ? request.localStorageEntryCount : 0;
  const verifier = response.verifierInstanceId;
  if (
    !commonResponseMatches(response, request) ||
    response.readbackCookieCount !== expectedCookieCount ||
    response.checkedLocalStorageOriginCount !==
      request.localStorageOriginCount ||
    response.readbackLocalStorageEntryCount !== expectedEntryCount ||
    typeof response.surfaceDrainEvidenceSha256 !== "string" ||
    !SHA256.test(response.surfaceDrainEvidenceSha256) ||
    (verifier !== undefined &&
      (typeof verifier !== "string" || !UUID.test(verifier))) ||
    response.parentExitEvidenceSha256 !==
      request.parentExitEvidenceSha256 ||
    response.committedReceiptId !== request.committedReceiptId
  ) {
    throw invalidReceipt();
  }
  return Object.freeze({
    exitEvidenceSha256: result.exitEvidenceSha256,
    surfaceDrainEvidenceSha256: response.surfaceDrainEvidenceSha256,
    ...(typeof verifier === "string" ? { verifierInstanceId: verifier } : {})
  });
}

function throwHelperFailure(
  result: ChromeProfileImportHelperProcessResultInternal,
  request: ChromiumSessionMigrationFreshHelperRequest
): never {
  if (
    result.outcome === "applied" ||
    result.secretBytes.byteLength !== 0 ||
    !SHA256.test(result.exitEvidenceSha256)
  ) {
    throw invalidReceipt();
  }
  const response = record(parseJson(result.metadataBytes));
  exactKeys(response, [
    "version", "family", "kind", "platform", "roleId", "transferId",
    "expectedJournalRevision", "targetRevision", "inventorySha256",
    "stableErrorCode"
  ]);
  if (
    !commonResponseMatches(response, request) ||
    typeof response.stableErrorCode !== "string" ||
    !/^CHROMIUM_SESSION_MIGRATION_[A-Z0-9_]{1,120}$/u
      .test(response.stableErrorCode)
  ) {
    throw invalidReceipt();
  }
  throw coordinatorError(
    response.stableErrorCode,
    result.outcome === "indeterminate"
      ? "The fresh helper ended without an exact target-state acknowledgement."
      : "The fresh helper rejected the exact session-migration operation."
  );
}

function cleanReceiptId(
  descriptor: ChromiumSessionMigrationFreshDescriptor,
  applyExitEvidenceSha256: string,
  verifyExitEvidenceSha256: string
): string {
  const digest = createHash("sha256").update([
    "rion-session-migration-fresh-receipt-v1",
    descriptor.roleId,
    descriptor.transferId,
    descriptor.expectedJournalRevision,
    descriptor.targetRevision,
    descriptor.inventorySha256,
    applyExitEvidenceSha256,
    verifyExitEvidenceSha256
  ].join("\0"), "utf8").digest("hex");
  return `chromium-session-fresh:${digest}`;
}

export class ChromiumSessionMigrationFreshCoordinator {
  readonly #launcher: ChromiumSessionMigrationFreshLauncherPort;

  constructor(launcher: ChromiumSessionMigrationFreshLauncherPort) {
    this.#launcher = launcher;
  }

  async run(
    descriptor: ChromiumSessionMigrationFreshDescriptor,
    kind: ChromiumSessionMigrationFreshHelperKind,
    envelopeBytes: Buffer,
    evidence?: string,
    signal?: AbortSignal
  ): Promise<ChromiumSessionMigrationFreshProcessReceipt> {
    if (signal?.aborted) {
      throw coordinatorError(
        "CHROMIUM_SESSION_MIGRATION_FRESH_HELPER_CANCELLED",
        "The startup session-migration helper was cancelled before launch."
      );
    }
    const request = baseRequest(
      descriptor,
      kind,
      envelopeBytes.byteLength,
      evidence
    );
    const metadataBytes = encodeChromiumSessionMigrationFreshHelperRequest(
      request
    );
    const secretBytes = Buffer.from(envelopeBytes);
    let result: ChromeProfileImportHelperProcessResultInternal;
    try {
      result = await this.#launcher.launchChromeProfileImportHelperInternal(
        metadataBytes,
        secretBytes,
        signal
      );
    } catch {
      throw coordinatorError(
        signal?.aborted
          ? "CHROMIUM_SESSION_MIGRATION_FRESH_HELPER_CANCELLED"
          : "CHROMIUM_SESSION_MIGRATION_FRESH_HELPER_LAUNCH_FAILED",
        signal?.aborted
          ? "The startup session-migration helper was cancelled and drained."
          : "The exact fresh Chromium helper process could not be launched."
      );
    } finally {
      metadataBytes.fill(0);
      secretBytes.fill(0);
    }
    try {
      if (result.outcome !== "applied") throwHelperFailure(result, request);
      return parseSuccess(result, request);
    } finally {
      result.metadataBytes.fill(0);
      result.secretBytes.fill(0);
    }
  }

  async applyAndVerify(
    descriptor: ChromiumSessionMigrationFreshDescriptor,
    envelopeBytes: Buffer,
    assertCurrent: () => Promise<void>,
    signal?: AbortSignal
  ): Promise<string> {
    const applied = await this.run(
      descriptor,
      "apply",
      envelopeBytes,
      undefined,
      signal
    );
    await assertCurrent();
    const verified = await this.run(
      descriptor,
      "verify",
      envelopeBytes,
      applied.exitEvidenceSha256,
      signal
    );
    if (applied.exitEvidenceSha256 === verified.exitEvidenceSha256) {
      throw invalidReceipt();
    }
    return cleanReceiptId(
      descriptor,
      applied.exitEvidenceSha256,
      verified.exitEvidenceSha256
    );
  }

  async verifyCommitted(
    descriptor: ChromiumSessionMigrationFreshDescriptor,
    envelopeBytes: Buffer,
    committedReceiptId: string,
    signal?: AbortSignal
  ): Promise<void> {
    await this.run(
      descriptor,
      "resumeVerify",
      envelopeBytes,
      committedReceiptId,
      signal
    );
  }

  async rollbackAndVerify(
    descriptor: ChromiumSessionMigrationFreshDescriptor,
    envelopeBytes: Buffer,
    signal?: AbortSignal
  ): Promise<boolean> {
    try {
      const rolledBack = await this.run(
        descriptor,
        "rollback", envelopeBytes, undefined, signal
      );
      const verified = await this.run(
        descriptor,
        "rollbackVerify",
        envelopeBytes,
        rolledBack.exitEvidenceSha256,
        signal
      );
      return rolledBack.exitEvidenceSha256 !== verified.exitEvidenceSha256;
    } catch {
      return false;
    }
  }
}
