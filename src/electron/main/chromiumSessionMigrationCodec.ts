import { createHash } from "node:crypto";

import type {
  RoleSessionMigrationPlatform,
  RoleSessionMigrationRecord
} from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";

const MAX_ENVELOPE_BYTES = 64 * 1024 * 1024;
const MAX_COOKIES = 10_000;
const MAX_LOCAL_STORAGE_ORIGINS = 4_096;
const MAX_LOCAL_STORAGE_ENTRIES = 100_000;

type CookieSameSite = "unspecified" | "none" | "lax" | "strict";

export interface ChromiumSessionMigrationCookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly hostOnly: boolean;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly expiryUnixMs: number | null;
  readonly sameSite: CookieSameSite;
}

export interface ChromiumSessionMigrationLocalStorageEntry {
  readonly key: string;
  readonly value: string;
}

export interface ChromiumSessionMigrationLocalStorageOrigin {
  readonly origin: string;
  readonly entries: readonly ChromiumSessionMigrationLocalStorageEntry[];
}

export interface ChromiumSessionMigrationWindowsSourceEvidence {
  /**
   * Canonical v1 source policy also rejects partitioned cookies and anything
   * outside Medium priority, a secure-matched scheme, and effective port 80/443.
   * Electron's public Cookie readback does not expose those hidden fields.
   */
  readonly kind: "webview2StorageGetCookies";
  readonly runtimeVersion: string;
  readonly protocolVersion: string;
  readonly partitionCapability: "networkCookiePartitionKeyAndOpaque";
}

export interface ParsedChromiumSessionMigrationInventory {
  readonly roleId: string;
  readonly transferId: string;
  readonly sourceRevision: number;
  readonly platform: RoleSessionMigrationPlatform;
  readonly envelopeSha256: string;
  readonly inventorySha256: string;
  readonly sourceEvidence: ChromiumSessionMigrationWindowsSourceEvidence | null;
  readonly cookies: readonly ChromiumSessionMigrationCookie[];
  readonly localStorage: readonly ChromiumSessionMigrationLocalStorageOrigin[];
}

export interface ChromiumSessionMigrationEnvelopeExpectation {
  readonly journal: RoleSessionMigrationRecord;
  readonly platform: RoleSessionMigrationPlatform;
}

function migrationError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function invalidEnvelope(): RionBridgeError {
  return migrationError(
    "CHROMIUM_SESSION_MIGRATION_ENVELOPE_INVALID",
    "The committed session-transfer inventory is not a valid canonical envelope."
  );
}

function invalidSourceEvidence(): RionBridgeError {
  return migrationError(
    "CHROMIUM_SESSION_MIGRATION_SOURCE_EVIDENCE_INVALID",
    "The source runtime did not provide exact supported migration capability evidence."
  );
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidEnvelope();
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
    throw invalidEnvelope();
  }
}

function stringField(value: unknown): string {
  if (typeof value !== "string") throw invalidEnvelope();
  return value;
}

function booleanField(value: unknown): boolean {
  if (typeof value !== "boolean") throw invalidEnvelope();
  return value;
}

function safeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalidEnvelope();
  }
  return value as number;
}

function canonicalBase64(value: unknown, encoding: string): Buffer {
  const bytes = record(value);
  exactKeys(bytes, ["encoding", "data"]);
  if (bytes.encoding !== encoding || typeof bytes.data !== "string") {
    throw invalidEnvelope();
  }
  const decoded = Buffer.from(bytes.data, "base64");
  if (decoded.toString("base64") !== bytes.data) {
    decoded.fill(0);
    throw invalidEnvelope();
  }
  return decoded;
}

function utf8CookieValue(value: unknown): string {
  const bytes = canonicalBase64(value, "base64");
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    bytes.fill(0);
    throw migrationError(
      "CHROMIUM_SESSION_MIGRATION_COOKIE_UNSUPPORTED",
      "A cookie cannot be represented losslessly by the Chromium cookie API."
    );
  }
  const roundTrip = Buffer.from(decoded, "utf8");
  const isExact = roundTrip.equals(bytes);
  roundTrip.fill(0);
  bytes.fill(0);
  if (!isExact) {
    throw migrationError(
      "CHROMIUM_SESSION_MIGRATION_COOKIE_UNSUPPORTED",
      "A cookie cannot be represented losslessly by the Chromium cookie API."
    );
  }
  return decoded;
}

function utf16LocalStorageValue(value: unknown): string {
  const bytes = canonicalBase64(value, "base64Utf16Le");
  if (bytes.byteLength % 2 !== 0) {
    bytes.fill(0);
    throw invalidEnvelope();
  }
  const decoded = bytes.toString("utf16le");
  const roundTrip = Buffer.from(decoded, "utf16le");
  const isExact = roundTrip.equals(bytes);
  roundTrip.fill(0);
  bytes.fill(0);
  if (!isExact) throw invalidEnvelope();
  return decoded;
}

function parseSourceEvidence(
  value: unknown,
  platform: RoleSessionMigrationPlatform
): ChromiumSessionMigrationWindowsSourceEvidence | null {
  if (platform === "macos") {
    if (value !== undefined) throw invalidSourceEvidence();
    return null;
  }
  let evidence: Record<string, unknown>;
  try {
    evidence = record(value);
    exactKeys(evidence, [
      "kind",
      "runtimeVersion",
      "protocolVersion",
      "partitionCapability"
    ]);
  } catch {
    throw invalidSourceEvidence();
  }
  const runtimeVersionIsExact = typeof evidence.runtimeVersion === "string" &&
    evidence.runtimeVersion.length > 0 &&
    evidence.runtimeVersion.length <= 64 &&
    /^[\x21-\x7e]+$/u.test(evidence.runtimeVersion);
  const protocolVersionIsExact = typeof evidence.protocolVersion === "string" &&
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(evidence.protocolVersion);
  if (
    evidence.kind !== "webview2StorageGetCookies" ||
    evidence.partitionCapability !== "networkCookiePartitionKeyAndOpaque" ||
    !runtimeVersionIsExact ||
    !protocolVersionIsExact
  ) {
    throw invalidSourceEvidence();
  }
  return Object.freeze({
    kind: "webview2StorageGetCookies",
    runtimeVersion: evidence.runtimeVersion as string,
    protocolVersion: evidence.protocolVersion as string,
    partitionCapability: "networkCookiePartitionKeyAndOpaque"
  });
}

function parseCookie(value: unknown): ChromiumSessionMigrationCookie {
  const cookie = record(value);
  exactKeys(cookie, [
    "name",
    "value",
    "domain",
    "path",
    "hostOnly",
    "secure",
    "httpOnly",
    "expiry",
    "sameSite",
    "partition"
  ], ["unsupportedAttributeCodes"]);
  const partition = record(cookie.partition);
  if (partition.kind === "unpartitioned") {
    exactKeys(partition, ["kind"]);
  } else if (partition.kind === "partitioned") {
    exactKeys(partition, ["kind"], [
      "partitionKey",
      "hasCrossSiteAncestor"
    ]);
    throw migrationError(
      "CHROMIUM_SESSION_MIGRATION_COOKIE_UNSUPPORTED",
      "Partitioned or unevidenced cookies cannot be imported losslessly."
    );
  } else if (partition.kind === "unknown") {
    exactKeys(partition, ["kind"]);
    throw migrationError(
      "CHROMIUM_SESSION_MIGRATION_COOKIE_UNSUPPORTED",
      "Partitioned or unevidenced cookies cannot be imported losslessly."
    );
  } else {
    throw invalidEnvelope();
  }
  if (
    cookie.unsupportedAttributeCodes !== undefined &&
    (!Array.isArray(cookie.unsupportedAttributeCodes) ||
      cookie.unsupportedAttributeCodes.length > 0)
  ) {
    throw migrationError(
      "CHROMIUM_SESSION_MIGRATION_COOKIE_UNSUPPORTED",
      "A cookie contains attributes unsupported by the Chromium cookie API."
    );
  }
  const expiry = record(cookie.expiry);
  let expiryUnixMs: number | null;
  if (expiry.kind === "session") {
    exactKeys(expiry, ["kind"]);
    expiryUnixMs = null;
  } else if (expiry.kind === "absolute") {
    exactKeys(expiry, ["kind", "unixMs"]);
    expiryUnixMs = safeInteger(expiry.unixMs);
  } else {
    throw invalidEnvelope();
  }
  if (!new Set(["unspecified", "none", "lax", "strict"])
    .has(cookie.sameSite as string)) {
    throw invalidEnvelope();
  }
  return Object.freeze({
    name: utf8CookieValue(cookie.name),
    value: utf8CookieValue(cookie.value),
    domain: stringField(cookie.domain),
    path: stringField(cookie.path),
    hostOnly: booleanField(cookie.hostOnly),
    secure: booleanField(cookie.secure),
    httpOnly: booleanField(cookie.httpOnly),
    expiryUnixMs,
    sameSite: cookie.sameSite as CookieSameSite
  });
}

function parseLocalStorageOrigin(
  value: unknown
): ChromiumSessionMigrationLocalStorageOrigin {
  const item = record(value);
  exactKeys(item, ["origin", "entries"]);
  const origin = stringField(item.origin);
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw invalidEnvelope();
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.origin !== origin ||
    !Array.isArray(item.entries) ||
    item.entries.length === 0
  ) {
    throw invalidEnvelope();
  }
  const entries = item.entries.map((value) => {
    const entry = record(value);
    exactKeys(entry, ["key", "value"]);
    return Object.freeze({
      key: utf16LocalStorageValue(entry.key),
      value: utf16LocalStorageValue(entry.value)
    });
  });
  return Object.freeze({ origin, entries: Object.freeze(entries) });
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireJournalEvidence(journal: RoleSessionMigrationRecord): {
  envelopeSha256: string;
  inventorySha256: string;
  cookieCount: number;
  localStorageOriginCount: number;
  localStorageEntryCount: number;
} {
  const evidence = {
    envelopeSha256: journal.envelopeSha256,
    inventorySha256: journal.inventorySha256,
    cookieCount: journal.cookieCount,
    localStorageOriginCount: journal.localStorageOriginCount,
    localStorageEntryCount: journal.localStorageEntryCount
  };
  if (
    typeof evidence.envelopeSha256 !== "string" ||
    typeof evidence.inventorySha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(evidence.envelopeSha256) ||
    !/^[0-9a-f]{64}$/u.test(evidence.inventorySha256) ||
    !Number.isSafeInteger(evidence.cookieCount) ||
    !Number.isSafeInteger(evidence.localStorageOriginCount) ||
    !Number.isSafeInteger(evidence.localStorageEntryCount)
  ) {
    throw migrationError(
      "CHROMIUM_SESSION_MIGRATION_EVIDENCE_MISSING",
      "The migration journal does not contain complete canonical inventory evidence."
    );
  }
  return evidence as {
    envelopeSha256: string;
    inventorySha256: string;
    cookieCount: number;
    localStorageOriginCount: number;
    localStorageEntryCount: number;
  };
}

export function parseChromiumSessionMigrationEnvelope(
  envelopeBytes: Buffer,
  expectation: ChromiumSessionMigrationEnvelopeExpectation
): ParsedChromiumSessionMigrationInventory {
  if (
    !Buffer.isBuffer(envelopeBytes) ||
    envelopeBytes.byteLength === 0 ||
    envelopeBytes.byteLength > MAX_ENVELOPE_BYTES
  ) {
    throw invalidEnvelope();
  }
  const evidence = requireJournalEvidence(expectation.journal);
  if (sha256(envelopeBytes) !== evidence.envelopeSha256) {
    throw migrationError(
      "CHROMIUM_SESSION_MIGRATION_EVIDENCE_MISMATCH",
      "The committed transfer envelope does not match its journal evidence."
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(envelopeBytes.toString("utf8"));
  } catch {
    throw invalidEnvelope();
  }
  const canonicalEnvelopeBytes = Buffer.from(JSON.stringify(decoded));
  const envelopeIsCanonical = canonicalEnvelopeBytes.equals(envelopeBytes);
  canonicalEnvelopeBytes.fill(0);
  if (!envelopeIsCanonical) {
    throw invalidEnvelope();
  }
  const envelope = record(decoded);
  exactKeys(envelope, ["metadata", "inventory"]);
  const metadata = record(envelope.metadata);
  exactKeys(metadata, [
    "format",
    "version",
    "transferId",
    "roleId",
    "platform",
    "sourceEngine",
    "targetEngine",
    "sourceRevision"
  ], ["sourceEvidence"]);
  const expectedSourceEngine = expectation.platform === "macos"
    ? "wkwebview"
    : "webview2";
  if (
    metadata.format !== "rion-role-session-transfer" ||
    metadata.version !== 1 ||
    metadata.roleId !== expectation.journal.roleId ||
    metadata.transferId !== expectation.journal.transferId ||
    metadata.platform !== expectation.platform ||
    metadata.sourceEngine !== expectedSourceEngine ||
    metadata.targetEngine !== "chromium" ||
    metadata.sourceRevision !== expectation.journal.sourceRevision
  ) {
    throw migrationError(
      "CHROMIUM_SESSION_MIGRATION_IDENTITY_MISMATCH",
      "The committed transfer envelope does not match the current migration identity."
    );
  }
  const sourceEvidence = parseSourceEvidence(
    metadata.sourceEvidence,
    expectation.platform
  );

  const inventory = record(envelope.inventory);
  exactKeys(inventory, ["cookies", "localStorage"]);
  if (
    !Array.isArray(inventory.cookies) ||
    !Array.isArray(inventory.localStorage) ||
    inventory.cookies.length > MAX_COOKIES ||
    inventory.localStorage.length > MAX_LOCAL_STORAGE_ORIGINS
  ) {
    throw invalidEnvelope();
  }
  const inventoryBytes = Buffer.from(JSON.stringify(inventory));
  const inventorySha256 = sha256(inventoryBytes);
  inventoryBytes.fill(0);
  if (inventorySha256 !== evidence.inventorySha256) {
    throw migrationError(
      "CHROMIUM_SESSION_MIGRATION_EVIDENCE_MISMATCH",
      "The committed transfer inventory does not match its journal evidence."
    );
  }
  const cookies = inventory.cookies.map(parseCookie);
  const localStorage = inventory.localStorage.map(parseLocalStorageOrigin);
  const localStorageEntryCount = localStorage.reduce(
    (total, origin) => total + origin.entries.length,
    0
  );
  if (
    localStorageEntryCount > MAX_LOCAL_STORAGE_ENTRIES ||
    cookies.length !== evidence.cookieCount ||
    localStorage.length !== evidence.localStorageOriginCount ||
    localStorageEntryCount !== evidence.localStorageEntryCount
  ) {
    throw migrationError(
      "CHROMIUM_SESSION_MIGRATION_EVIDENCE_MISMATCH",
      "The committed transfer counts do not match their journal evidence."
    );
  }
  return Object.freeze({
    roleId: stringField(metadata.roleId),
    transferId: stringField(metadata.transferId),
    sourceRevision: safeInteger(metadata.sourceRevision),
    platform: metadata.platform as RoleSessionMigrationPlatform,
    envelopeSha256: evidence.envelopeSha256,
    inventorySha256: evidence.inventorySha256,
    sourceEvidence,
    cookies: Object.freeze(cookies),
    localStorage: Object.freeze(localStorage)
  });
}
