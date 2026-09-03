import { createHash, randomUUID } from "node:crypto";

import type { Cookie, CookiesSetDetails } from "electron";

import type {
  ChromeProfileImportTransactionDescriptorInternal
} from "../core/coreAddonClient";
import { RionBridgeError } from "../ipc/errors";
import type {
  ChromeProfileImportLocalStorageEntry
} from "./chromeProfileImportLocalStorage";
import {
  ChromiumRoleSessionRegistry,
  type ChromiumRoleSessionChromeImportLease,
  type ChromiumRoleSessionPort,
  type ChromiumSessionFactoryPort
} from "./chromiumRoleSessionRegistry";
import { ChromiumSessionOwnershipLedger } from "./chromiumSessionOwnershipLedger";

type RuntimePlatform = "darwin" | "win32";
export type ChromeProfileImportFreshHelperKind =
  | "snapshot"
  | "apply"
  | "verify"
  | "rollback";

interface ChromeProfileImportPayloadCookie {
  readonly name: string;
  readonly value: string;
  readonly domain?: string;
  readonly path: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly sameSite: "none" | "lax" | "strict";
  readonly expiresUnixMs?: number;
}

interface ChromeProfileImportPayload {
  readonly cookies: readonly ChromeProfileImportPayloadCookie[];
  readonly localStorage: readonly ChromeProfileImportLocalStorageEntry[];
}

export interface ChromeProfileImportFreshHelperAuthProbe {
  readonly verificationUrl: string;
  readonly authenticatedPath: string;
  readonly loginPath: string;
}

export interface ChromeProfileImportFreshHelperRequest {
  readonly version: 1;
  readonly kind: ChromeProfileImportFreshHelperKind;
  readonly descriptor: ChromeProfileImportTransactionDescriptorInternal;
  readonly payloadBytes: number;
  readonly parentExitEvidenceSha256?: string;
  readonly authProbe?: ChromeProfileImportFreshHelperAuthProbe;
}

export interface ChromeProfileImportFreshHelperResult {
  readonly outcome: "applied" | "failed" | "indeterminate";
  readonly metadataBytes: Buffer;
  readonly secretBytes: Buffer;
}

export interface ChromeProfileImportLocalStoragePort {
  readback: (
    session: ChromiumRoleSessionPort,
    origin: string
  ) => Promise<readonly ChromeProfileImportLocalStorageEntry[]>;
  replaceAndReadback: (
    session: ChromiumRoleSessionPort,
    origin: string,
    entries: readonly ChromeProfileImportLocalStorageEntry[]
  ) => Promise<readonly ChromeProfileImportLocalStorageEntry[]>;
}

export interface ChromeProfileImportAuthProbePort {
  verify: (
    session: ChromiumRoleSessionPort,
    probe: ChromeProfileImportFreshHelperAuthProbe
  ) => Promise<"authenticated" | "notAuthenticated" | "indeterminate">;
}

export interface ChromeProfileImportFreshHelperInput {
  readonly auth: ChromeProfileImportAuthProbePort;
  readonly localStorage: ChromeProfileImportLocalStoragePort;
  readonly platform: RuntimePlatform;
  readonly sessions: ChromiumSessionFactoryPort;
}

const MAX_COOKIES = 20_000;
const MAX_LOCAL_STORAGE_ENTRIES = 10_000;
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/u;
const JOURNAL_PHASES = new Set([
  "prepared", "snapshotted", "applying", "verified", "metadataCommitted",
  "awaitingFreshVerification", "freshVerified", "committing"
]);

function helperError(code: string, message: string): RionBridgeError {
  return new RionBridgeError({ code, message });
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw helperError(
      "CHROMIUM_PROFILE_IMPORT_HELPER_METADATA_INVALID",
      "The fresh helper metadata is invalid."
    );
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
    throw helperError(
      "CHROMIUM_PROFILE_IMPORT_HELPER_METADATA_INVALID",
      "The fresh helper metadata is not canonical."
    );
  }
}

function decodeUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw helperError(
      "CHROMIUM_PROFILE_IMPORT_HELPER_METADATA_INVALID",
      "The fresh helper metadata is not canonical UTF-8."
    );
  }
}

function safeInteger(value: unknown, minimum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function validateDescriptor(value: unknown): ChromeProfileImportTransactionDescriptorInternal {
  const descriptor = record(value);
  exactKeys(descriptor, [
    "contractVersion", "leaseId", "operationId", "transactionId", "roleId",
    "journalPhase", "journalRevision", "launchUrl", "launchOrigin",
    "replaceExisting", "createdRole", "rolePaths", "chromiumPathSha256",
    "stagingSha256", "stagingBytes", "cookieCount", "localStorageCount",
    "unsupported", "warnings"
  ], ["commitMarkerSha256"]);
  const identities = [descriptor.leaseId, descriptor.transactionId, descriptor.roleId];
  const operationId = descriptor.operationId;
  if (
    descriptor.contractVersion !== 1 ||
    identities.some((identity) => typeof identity !== "string" ||
      !CANONICAL_UUID.test(identity)) ||
    typeof operationId !== "string" || operationId.length === 0 ||
    operationId.length > 300 || operationId !== operationId.trim() ||
    [...operationId].some((character) => {
      const point = character.codePointAt(0)!;
      return point <= 0x1f || point === 0x7f;
    }) ||
    typeof descriptor.journalPhase !== "string" ||
    !JOURNAL_PHASES.has(descriptor.journalPhase) ||
    !safeInteger(descriptor.journalRevision, 1) ||
    typeof descriptor.launchUrl !== "string" ||
    typeof descriptor.launchOrigin !== "string" ||
    typeof descriptor.replaceExisting !== "boolean" ||
    typeof descriptor.createdRole !== "boolean" ||
    descriptor.createdRole === descriptor.replaceExisting ||
    typeof descriptor.chromiumPathSha256 !== "string" ||
    !LOWERCASE_SHA256.test(descriptor.chromiumPathSha256) ||
    typeof descriptor.stagingSha256 !== "string" ||
    !LOWERCASE_SHA256.test(descriptor.stagingSha256) ||
    !safeInteger(descriptor.stagingBytes, 1) ||
    !safeInteger(descriptor.cookieCount, 0) ||
    !safeInteger(descriptor.localStorageCount, 0)
  ) {
    throw helperError(
      "CHROMIUM_PROFILE_IMPORT_HELPER_METADATA_INVALID",
      "The fresh helper descriptor identity is invalid."
    );
  }
  let launch: URL;
  try {
    launch = new URL(descriptor.launchUrl);
  } catch {
    throw helperError(
      "CHROMIUM_PROFILE_IMPORT_HELPER_METADATA_INVALID",
      "The fresh helper launch identity is invalid."
    );
  }
  if (!new Set(["http:", "https:"]).has(launch.protocol) ||
    launch.username.length > 0 || launch.password.length > 0 ||
    launch.origin !== descriptor.launchOrigin) {
    throw helperError(
      "CHROMIUM_PROFILE_IMPORT_HELPER_METADATA_INVALID",
      "The fresh helper launch identity is invalid."
    );
  }
  const rolePaths = record(descriptor.rolePaths);
  exactKeys(rolePaths, [
    "browserUserDataDir", "systemBrowserDataDir", "webview2UserDataDir",
    "chromiumUserDataDir", "webkitDataStoreKey", "webkitDataStoreIdentifier"
  ]);
  if (Object.values(rolePaths).some((path) =>
    typeof path !== "string" || path.length === 0 || path.includes("\0"))) {
    throw helperError(
      "CHROMIUM_PROFILE_IMPORT_HELPER_METADATA_INVALID",
      "The fresh helper path descriptor is invalid."
    );
  }
  const unsupported = record(descriptor.unsupported);
  exactKeys(unsupported, [
    "partitionedCookieCount", "appBoundCookieCount", "decryptFailureCount",
    "storageReadFailureCount"
  ]);
  if (Object.values(unsupported).some((count) => !safeInteger(count, 0)) ||
    !Array.isArray(descriptor.warnings) ||
    descriptor.warnings.some((warning) => typeof warning !== "string") ||
    (descriptor.commitMarkerSha256 !== undefined &&
      (typeof descriptor.commitMarkerSha256 !== "string" ||
        !LOWERCASE_SHA256.test(descriptor.commitMarkerSha256)))) {
    throw helperError(
      "CHROMIUM_PROFILE_IMPORT_HELPER_METADATA_INVALID",
      "The fresh helper evidence descriptor is invalid."
    );
  }
  return descriptor as unknown as ChromeProfileImportTransactionDescriptorInternal;
}

export function parseChromeProfileImportFreshHelperRequest(
  metadataBytes: Buffer
): ChromeProfileImportFreshHelperRequest {
  let value: unknown;
  try {
    value = JSON.parse(decodeUtf8(metadataBytes));
  } catch (error) {
    if (error instanceof RionBridgeError) throw error;
    throw helperError(
      "CHROMIUM_PROFILE_IMPORT_HELPER_METADATA_INVALID",
      "The fresh helper metadata is invalid JSON."
    );
  }
  const request = record(value);
  exactKeys(request, ["version", "kind", "descriptor", "payloadBytes"], [
    "parentExitEvidenceSha256",
    "authProbe"
  ]);
  if (
    request.version !== 1 ||
    !new Set(["snapshot", "apply", "verify", "rollback"]).has(request.kind as string) ||
    !Number.isSafeInteger(request.payloadBytes) ||
    (request.payloadBytes as number) < 0 ||
    (request.payloadBytes as number) > 64 * 1024 * 1024
  ) {
    throw helperError(
      "CHROMIUM_PROFILE_IMPORT_HELPER_METADATA_INVALID",
      "The fresh helper request identity is invalid."
    );
  }
  const descriptor = validateDescriptor(request.descriptor);
  if (request.parentExitEvidenceSha256 !== undefined &&
    (typeof request.parentExitEvidenceSha256 !== "string" ||
      !LOWERCASE_SHA256.test(request.parentExitEvidenceSha256))) {
    throw helperError(
      "CHROMIUM_PROFILE_IMPORT_HELPER_METADATA_INVALID",
      "The apply-helper exit evidence is invalid."
    );
  }
  if (
    (request.kind === "verify") !==
      (typeof request.parentExitEvidenceSha256 === "string") ||
    (request.kind !== "verify" && request.authProbe !== undefined)
  ) {
    throw helperError(
      "CHROMIUM_PROFILE_IMPORT_HELPER_METADATA_INVALID",
      "The helper verification evidence is inconsistent with its operation."
    );
  }
  if (request.authProbe !== undefined) {
    const authProbe = record(request.authProbe);
    exactKeys(authProbe, ["verificationUrl", "authenticatedPath", "loginPath"]);
    let verificationUrl: URL;
    try {
      verificationUrl = new URL(authProbe.verificationUrl as string);
    } catch {
      throw helperError(
        "CHROMIUM_PROFILE_IMPORT_HELPER_METADATA_INVALID",
        "The helper authentication probe is invalid."
      );
    }
    if (
      typeof authProbe.verificationUrl !== "string" ||
      typeof authProbe.authenticatedPath !== "string" ||
      typeof authProbe.loginPath !== "string" ||
      verificationUrl.origin !== descriptor.launchOrigin
    ) {
      throw helperError(
        "CHROMIUM_PROFILE_IMPORT_HELPER_METADATA_INVALID",
        "The helper authentication probe is invalid."
      );
    }
  }
  return request as unknown as ChromeProfileImportFreshHelperRequest;
}

export function encodeChromeProfileImportFreshHelperRequest(
  request: ChromeProfileImportFreshHelperRequest
): Buffer {
  return Buffer.from(JSON.stringify(request), "utf8");
}

function parsePayload(bytes: Buffer): ChromeProfileImportPayload {
  let value: unknown;
  try {
    value = JSON.parse(decodeUtf8(bytes));
  } catch (error) {
    if (error instanceof RionBridgeError) throw error;
    throw helperError(
      "CHROMIUM_PROFILE_IMPORT_PAYLOAD_INVALID",
      "The fresh helper payload is invalid."
    );
  }
  const payload = record(value);
  exactKeys(payload, ["cookies", "localStorage"]);
  if (
    !Array.isArray(payload.cookies) ||
    payload.cookies.length > MAX_COOKIES ||
    !Array.isArray(payload.localStorage) ||
    payload.localStorage.length > MAX_LOCAL_STORAGE_ENTRIES
  ) {
    throw helperError(
      "CHROMIUM_PROFILE_IMPORT_PAYLOAD_INVALID",
      "The fresh helper payload exceeds its canonical inventory limits."
    );
  }
  const cookies = payload.cookies.map((candidate) => {
    const cookie = record(candidate);
    exactKeys(cookie, [
      "name", "value", "path", "secure", "httpOnly", "sameSite"
    ], ["domain", "expiresUnixMs"]);
    if (
      typeof cookie.name !== "string" || typeof cookie.value !== "string" ||
      typeof cookie.path !== "string" || !cookie.path.startsWith("/") ||
      typeof cookie.secure !== "boolean" || typeof cookie.httpOnly !== "boolean" ||
      !new Set(["none", "lax", "strict"]).has(cookie.sameSite as string) ||
      (cookie.domain !== undefined && typeof cookie.domain !== "string") ||
      (cookie.expiresUnixMs !== undefined && !Number.isSafeInteger(cookie.expiresUnixMs))
    ) {
      throw helperError(
        "CHROMIUM_PROFILE_IMPORT_PAYLOAD_INVALID",
        "The fresh helper cookie inventory is invalid."
      );
    }
    return Object.freeze(cookie) as unknown as ChromeProfileImportPayloadCookie;
  });
  const localStorage = payload.localStorage.map((candidate) => {
    const entry = record(candidate);
    exactKeys(entry, ["key", "value"]);
    if (typeof entry.key !== "string" || typeof entry.value !== "string") {
      throw helperError(
        "CHROMIUM_PROFILE_IMPORT_PAYLOAD_INVALID",
        "The fresh helper LocalStorage inventory is invalid."
      );
    }
    return Object.freeze({ key: entry.key, value: entry.value });
  });
  return Object.freeze({ cookies: Object.freeze(cookies), localStorage: Object.freeze(localStorage) });
}

function sortCookies(
  cookies: readonly ChromeProfileImportPayloadCookie[]
): ChromeProfileImportPayloadCookie[] {
  return [...cookies].sort((left, right) =>
    (left.domain ?? "").localeCompare(right.domain ?? "") ||
    left.path.localeCompare(right.path) || left.name.localeCompare(right.name)
  );
}

function sortLocalStorage(
  entries: readonly ChromeProfileImportLocalStorageEntry[]
): ChromeProfileImportLocalStorageEntry[] {
  return [...entries].sort((left, right) => left.key.localeCompare(right.key));
}

function payloadBytes(payload: ChromeProfileImportPayload): Buffer {
  return Buffer.from(JSON.stringify({
    cookies: sortCookies(payload.cookies),
    localStorage: sortLocalStorage(payload.localStorage)
  }), "utf8");
}

function exactPayload(left: ChromeProfileImportPayload, right: ChromeProfileImportPayload): boolean {
  const leftBytes = payloadBytes(left);
  const rightBytes = payloadBytes(right);
  const exact = leftBytes.equals(rightBytes);
  leftBytes.fill(0);
  rightBytes.fill(0);
  return exact;
}

function cookieInOrigin(cookie: Cookie, origin: URL): boolean {
  if (typeof cookie.domain !== "string") return false;
  const domain = cookie.domain.replace(/^\./u, "").toLowerCase();
  const host = origin.hostname.toLowerCase();
  return cookie.hostOnly === true
    ? domain === host
    : domain === host || host.endsWith(`.${domain}`);
}

function normalizeCookie(cookie: Cookie): ChromeProfileImportPayloadCookie {
  if (
    typeof cookie.domain !== "string" || typeof cookie.path !== "string" ||
    typeof cookie.hostOnly !== "boolean" || typeof cookie.secure !== "boolean" ||
    typeof cookie.httpOnly !== "boolean" || typeof cookie.session !== "boolean" ||
    cookie.sameSite === "unspecified"
  ) {
    throw helperError(
      "CHROMIUM_PROFILE_IMPORT_COOKIE_UNSUPPORTED",
      "Electron did not expose an exact supported cookie inventory."
    );
  }
  const sameSite = cookie.sameSite === "no_restriction" ? "none" : cookie.sameSite;
  let expiresUnixMs: number | undefined;
  if (!cookie.session) {
    expiresUnixMs = Math.round(cookie.expirationDate! * 1000);
    if (!Number.isSafeInteger(expiresUnixMs)) {
      throw helperError(
        "CHROMIUM_PROFILE_IMPORT_COOKIE_UNSUPPORTED",
        "Electron returned an inexact cookie expiry."
      );
    }
  }
  return Object.freeze({
    name: cookie.name,
    value: cookie.value,
    ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite,
    ...(expiresUnixMs === undefined ? {} : { expiresUnixMs })
  });
}

function cookieSetDetails(
  cookie: ChromeProfileImportPayloadCookie,
  origin: URL
): CookiesSetDetails {
  return {
    url: `${origin.protocol}//${origin.host}${cookie.path}`,
    name: cookie.name,
    value: cookie.value,
    ...(cookie.domain === undefined ? {} : { domain: cookie.domain }),
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite === "none" ? "no_restriction" : cookie.sameSite,
    ...(cookie.expiresUnixMs === undefined
      ? {}
      : { expirationDate: cookie.expiresUnixMs / 1000 })
  };
}

async function readCookies(
  session: ChromiumRoleSessionPort,
  origin: URL
): Promise<ChromeProfileImportPayloadCookie[]> {
  return sortCookies((await session.cookies.get({}))
    .filter((cookie) => cookieInOrigin(cookie, origin))
    .map(normalizeCookie));
}

async function replaceCookies(
  session: ChromiumRoleSessionPort,
  origin: URL,
  expected: readonly ChromeProfileImportPayloadCookie[]
): Promise<void> {
  for (const cookie of await readCookies(session, origin)) {
    await session.cookies.remove(
      `${cookie.secure ? "https:" : "http:"}//${origin.host}${cookie.path}`,
      cookie.name
    );
  }
  await session.cookies.flushStore();
  if ((await readCookies(session, origin)).length !== 0) {
    throw helperError(
      "CHROMIUM_PROFILE_IMPORT_COOKIE_CLEAR_FAILED",
      "The helper could not prove the launch-origin cookie store was empty."
    );
  }
  for (const cookie of expected) {
    await session.cookies.set(cookieSetDetails(cookie, origin));
  }
  await session.cookies.flushStore();
  const actual = await readCookies(session, origin);
  if (!exactPayload(
    { cookies: actual, localStorage: [] },
    { cookies: expected, localStorage: [] }
  )) {
    throw helperError(
      "CHROMIUM_PROFILE_IMPORT_COOKIE_READBACK_FAILED",
      "The helper did not return the exact launch-origin cookie inventory."
    );
  }
}

function leaseInput(descriptor: ChromeProfileImportTransactionDescriptorInternal) {
  return {
    roleId: descriptor.roleId,
    coreLeaseId: descriptor.leaseId,
    operationId: descriptor.operationId,
    transactionId: descriptor.transactionId,
    journalPhase: descriptor.journalPhase,
    journalRevision: descriptor.journalRevision,
    launchOrigin: descriptor.launchOrigin,
    replaceExisting: descriptor.replaceExisting,
    chromiumUserDataDir: descriptor.rolePaths.chromiumUserDataDir,
    chromiumPathSha256: descriptor.chromiumPathSha256,
    stagingSha256: descriptor.stagingSha256
  };
}

function responseMetadata(
  request: ChromeProfileImportFreshHelperRequest,
  values: Record<string, unknown>
): Buffer {
  return Buffer.from(JSON.stringify({
    version: 1,
    kind: request.kind,
    transactionId: request.descriptor.transactionId,
    roleId: request.descriptor.roleId,
    journalPhase: request.descriptor.journalPhase,
    journalRevision: request.descriptor.journalRevision,
    ...values
  }), "utf8");
}

function surfaceDrainDigest(
  request: ChromeProfileImportFreshHelperRequest,
  inventorySha256: string
): string {
  return createHash("sha256").update([
    "rion-chrome-import-helper-drain-v1",
    request.kind,
    request.descriptor.transactionId,
    request.descriptor.roleId,
    request.descriptor.journalRevision,
    inventorySha256,
    process.pid
  ].join("\0"), "utf8").digest("hex");
}

export class ChromeProfileImportFreshHelper {
  readonly #input: ChromeProfileImportFreshHelperInput;

  constructor(input: ChromeProfileImportFreshHelperInput) {
    this.#input = input;
  }

  async run(
    request: ChromeProfileImportFreshHelperRequest,
    secretBytes: Buffer
  ): Promise<ChromeProfileImportFreshHelperResult> {
    const ownership = new ChromiumSessionOwnershipLedger(this.#input.platform);
    const registry = new ChromiumRoleSessionRegistry(
      this.#input.sessions,
      this.#input.platform,
      ownership
    );
    let lease: ChromiumRoleSessionChromeImportLease | null = null;
    let mutationStarted = false;
    try {
      const expectedPhase = request.kind === "snapshot"
        ? "prepared"
        : request.kind === "apply"
          ? "applying"
          : request.kind === "verify"
            ? "awaitingFreshVerification"
            : null;
      if (expectedPhase !== null && request.descriptor.journalPhase !== expectedPhase) {
        throw helperError(
          "CHROMIUM_PROFILE_IMPORT_HELPER_METADATA_INVALID",
          "The helper kind does not match its exact journal phase."
        );
      }
      const capabilityBytes = request.kind === "verify" ? 32 : 0;
      let expected: ChromeProfileImportPayload | null = null;
      if (request.kind === "snapshot") {
        if (secretBytes.byteLength !== 0 || request.payloadBytes !== 0) {
          throw helperError(
            "CHROMIUM_PROFILE_IMPORT_HELPER_SECRET_INVALID",
            "The snapshot helper received unexpected plaintext."
          );
        }
      } else {
        if (secretBytes.byteLength !== capabilityBytes + request.payloadBytes ||
          request.payloadBytes === 0) {
          throw helperError(
            "CHROMIUM_PROFILE_IMPORT_HELPER_SECRET_INVALID",
            "The helper plaintext does not match its exact bounded descriptor."
          );
        }
        const payloadSlice = Buffer.from(secretBytes.subarray(capabilityBytes));
        let canonicalPayload: Buffer | null = null;
        try {
          expected = parsePayload(payloadSlice);
          canonicalPayload = payloadBytes(expected);
          if (!canonicalPayload.equals(payloadSlice)) {
            throw helperError(
              "CHROMIUM_PROFILE_IMPORT_PAYLOAD_INVALID",
              "The helper plaintext is not the exact canonical inventory."
            );
          }
        } finally {
          canonicalPayload?.fill(0);
          payloadSlice.fill(0);
        }
      }
      lease = registry.acquireChromeImportSession(leaseInput(request.descriptor));
      const origin = new URL(request.descriptor.launchOrigin);
      let canonical: Buffer;
      let authState: string = "notApplicable";
      let capabilitySha256: string | undefined;
      if (request.kind === "snapshot") {
        canonical = payloadBytes({
          cookies: await readCookies(lease.session, origin),
          localStorage: await this.#input.localStorage.readback(
            lease.session,
            origin.origin
          )
        });
      } else {
        capabilitySha256 = request.kind === "verify"
          ? createHash("sha256").update(secretBytes.subarray(0, 32)).digest("hex")
          : undefined;
        if (!expected) {
          throw helperError(
            "CHROMIUM_PROFILE_IMPORT_PAYLOAD_INVALID",
            "The helper plaintext inventory is unavailable."
          );
        }
        if (request.kind === "apply" || request.kind === "rollback") {
          mutationStarted = true;
          await replaceCookies(lease.session, origin, expected.cookies);
          await this.#input.localStorage.replaceAndReadback(
            lease.session,
            origin.origin,
            expected.localStorage
          );
          // Electron exposes no DOMStorage flush acknowledgement. This helper
          // makes only an in-process receipt; durability is established solely
          // by the later fresh verifier process.
          lease.session.flushStorageData();
        } else if (request.authProbe) {
          authState = await this.#input.auth.verify(lease.session, request.authProbe);
        }
        const actual: ChromeProfileImportPayload = {
          cookies: await readCookies(lease.session, origin),
          localStorage: await this.#input.localStorage.readback(
            lease.session,
            origin.origin
          )
        };
        if (!exactPayload(actual, expected)) {
          throw helperError(
            "CHROMIUM_PROFILE_IMPORT_FRESH_READBACK_MISMATCH",
            "The fresh Chromium process did not return the exact canonical inventory."
          );
        }
        canonical = payloadBytes(expected);
      }
      const inventorySha256 = createHash("sha256").update(canonical).digest("hex");
      const inventory = parsePayload(canonical);
      await registry.releaseChromeImportSession(lease);
      lease = null;
      await registry.dispose();
      const drain = surfaceDrainDigest(request, inventorySha256);
      const metadataBytes = responseMetadata(request, {
        inventorySha256,
        cookieCount: inventory.cookies.length,
        localStorageCount: inventory.localStorage.length,
        surfaceDrainEvidenceSha256: drain,
        authState,
        ...(request.kind === "verify"
          ? {
              verifierInstanceId: randomUUID(),
              parentExitEvidenceSha256: request.parentExitEvidenceSha256,
              chromiumPathSha256: request.descriptor.chromiumPathSha256,
              capabilitySha256
            }
          : {})
      });
      const responseSecret = request.kind === "snapshot" ? Buffer.from(canonical) : Buffer.alloc(0);
      canonical.fill(0);
      secretBytes.fill(0);
      return { outcome: "applied", metadataBytes, secretBytes: responseSecret };
    } catch (error) {
      let releaseUnknown = false;
      if (lease) {
        try {
          await registry.releaseChromeImportSession(lease);
        } catch {
          releaseUnknown = true;
        }
      }
      secretBytes.fill(0);
      const stableErrorCode = releaseUnknown
        ? "CHROMIUM_PROFILE_IMPORT_HELPER_RELEASE_INDETERMINATE"
        : error instanceof RionBridgeError
          ? error.code
          : "CHROMIUM_PROFILE_IMPORT_HELPER_FAILED";
      return {
        outcome: mutationStarted || releaseUnknown ? "indeterminate" : "failed",
        metadataBytes: responseMetadata(request, { stableErrorCode }),
        secretBytes: Buffer.alloc(0)
      };
    }
  }
}
