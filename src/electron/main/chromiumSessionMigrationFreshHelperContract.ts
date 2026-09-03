import type {
  RolePathsRecord,
  RoleSessionMigrationPlatform
} from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";

export const SESSION_MIGRATION_FRESH_HELPER_FAMILY =
  "roleSessionMigration" as const;
export const SESSION_MIGRATION_FRESH_HELPER_MAX_ENVELOPE_BYTES =
  64 * 1024 * 1024;

export type ChromiumSessionMigrationFreshHelperKind =
  | "apply"
  | "verify"
  | "resumeVerify"
  | "rollback"
  | "rollbackVerify";

export interface ChromiumSessionMigrationFreshHelperRequest {
  readonly version: 1;
  readonly family: typeof SESSION_MIGRATION_FRESH_HELPER_FAMILY;
  readonly kind: ChromiumSessionMigrationFreshHelperKind;
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
  readonly envelopeBytes: number;
  readonly parentExitEvidenceSha256?: string;
  readonly committedReceiptId?: string;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMITTED_RECEIPT = /^chromium-session-fresh:[0-9a-f]{64}$/u;
const ROLE_PATH_KEYS = Object.freeze([
  "browserUserDataDir",
  "systemBrowserDataDir",
  "webview2UserDataDir",
  "chromiumUserDataDir",
  "webkitDataStoreKey",
  "webkitDataStoreIdentifier"
] as const);

function helperError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function invalidMetadata(): RionBridgeError {
  return helperError(
    "CHROMIUM_SESSION_MIGRATION_FRESH_HELPER_METADATA_INVALID",
    "The fresh session-migration helper metadata is not canonical."
  );
}

function decodeUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalidMetadata();
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidMetadata();
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw invalidMetadata();
  }
}

function safeInteger(value: unknown, minimum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function validateRolePaths(value: unknown): RolePathsRecord {
  const paths = record(value);
  exactKeys(paths, ROLE_PATH_KEYS);
  if (ROLE_PATH_KEYS.some((key) => {
    const path = paths[key];
    return typeof path !== "string" || path.length === 0 ||
      path.length > 8_192 || path.includes("\0");
  })) {
    throw invalidMetadata();
  }
  return paths as unknown as RolePathsRecord;
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(decodeUtf8(bytes));
  } catch (error) {
    if (error instanceof RionBridgeError) throw error;
    throw invalidMetadata();
  }
}

export function isSessionMigrationFreshHelperMetadata(bytes: Buffer): boolean {
  try {
    const value = parseJson(bytes);
    return typeof value === "object" && value !== null &&
      !Array.isArray(value) &&
      (value as { family?: unknown }).family ===
        SESSION_MIGRATION_FRESH_HELPER_FAMILY;
  } catch {
    return false;
  }
}

export function parseChromiumSessionMigrationFreshHelperRequest(
  metadataBytes: Buffer
): ChromiumSessionMigrationFreshHelperRequest {
  const request = record(parseJson(metadataBytes));
  exactKeys(request, [
    "version",
    "family",
    "kind",
    "platform",
    "roleId",
    "transferId",
    "expectedJournalRevision",
    "targetRevision",
    "sourceRevision",
    "phase",
    "rolePaths",
    "envelopeSha256",
    "inventorySha256",
    "cookieCount",
    "localStorageOriginCount",
    "localStorageEntryCount",
    "envelopeBytes"
  ], ["parentExitEvidenceSha256", "committedReceiptId"]);

  const kind = request.kind as ChromiumSessionMigrationFreshHelperKind;
  const supportedKinds = new Set<ChromiumSessionMigrationFreshHelperKind>([
    "apply", "verify", "resumeVerify", "rollback", "rollbackVerify"
  ]);
  const counts = [
    request.cookieCount,
    request.localStorageOriginCount,
    request.localStorageEntryCount
  ];
  if (
    request.version !== 1 ||
    request.family !== SESSION_MIGRATION_FRESH_HELPER_FAMILY ||
    !supportedKinds.has(kind) ||
    !new Set(["macos", "windows"]).has(request.platform as string) ||
    typeof request.roleId !== "string" || !UUID.test(request.roleId) ||
    typeof request.transferId !== "string" || !UUID.test(request.transferId) ||
    !safeInteger(request.expectedJournalRevision, 1) ||
    !safeInteger(request.targetRevision, 1) ||
    !safeInteger(request.sourceRevision, 0) ||
    !new Set(["importing", "verifying", "indeterminate"])
      .has(request.phase as string) ||
    typeof request.envelopeSha256 !== "string" ||
    !SHA256.test(request.envelopeSha256) ||
    typeof request.inventorySha256 !== "string" ||
    !SHA256.test(request.inventorySha256) ||
    counts.some((count) => !safeInteger(count, 0)) ||
    !safeInteger(request.envelopeBytes, 1) ||
    request.envelopeBytes > SESSION_MIGRATION_FRESH_HELPER_MAX_ENVELOPE_BYTES
  ) {
    throw invalidMetadata();
  }

  const parentEvidence = request.parentExitEvidenceSha256;
  const committedReceipt = request.committedReceiptId;
  const needsParentEvidence = kind === "verify" || kind === "rollbackVerify";
  const needsCommittedReceipt = kind === "resumeVerify";
  if (
    (needsParentEvidence !== (typeof parentEvidence === "string")) ||
    (parentEvidence !== undefined && !SHA256.test(parentEvidence as string)) ||
    (needsCommittedReceipt !== (typeof committedReceipt === "string")) ||
    (committedReceipt !== undefined &&
      !COMMITTED_RECEIPT.test(committedReceipt as string)) ||
    (kind === "apply" &&
      !new Set(["importing", "indeterminate"]).has(request.phase as string)) ||
    (kind === "verify" &&
      !new Set(["importing", "indeterminate"]).has(request.phase as string)) ||
    (kind === "resumeVerify" &&
      !new Set(["verifying", "indeterminate"]).has(request.phase as string))
  ) {
    throw invalidMetadata();
  }

  const rolePaths = validateRolePaths(request.rolePaths);
  return Object.freeze({
    ...request,
    rolePaths: Object.freeze({ ...rolePaths })
  }) as unknown as ChromiumSessionMigrationFreshHelperRequest;
}

export function encodeChromiumSessionMigrationFreshHelperRequest(
  request: ChromiumSessionMigrationFreshHelperRequest
): Buffer {
  return Buffer.from(JSON.stringify(request), "utf8");
}

export function chromiumSessionMigrationFreshHelperResponseMetadata(
  request: ChromiumSessionMigrationFreshHelperRequest,
  values: Readonly<Record<string, unknown>>
): Buffer {
  return Buffer.from(JSON.stringify({
    version: 1,
    family: SESSION_MIGRATION_FRESH_HELPER_FAMILY,
    kind: request.kind,
    platform: request.platform,
    roleId: request.roleId,
    transferId: request.transferId,
    expectedJournalRevision: request.expectedJournalRevision,
    targetRevision: request.targetRevision,
    inventorySha256: request.inventorySha256,
    ...values
  }), "utf8");
}
