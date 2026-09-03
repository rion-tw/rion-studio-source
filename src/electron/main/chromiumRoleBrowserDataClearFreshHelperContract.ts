import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";

import type { RolePathsRecord } from "../../shared/generated";
import { RionBridgeError } from "../ipc/errors";

export const ROLE_BROWSER_DATA_CLEAR_FRESH_HELPER_FAMILY =
  "roleBrowserDataClear" as const;
export const ROLE_BROWSER_DATA_CLEAR_EVIDENCE_REVISION = 1 as const;

export interface ChromiumRoleBrowserDataClearFreshHelperRequest {
  readonly version: 1;
  readonly family: typeof ROLE_BROWSER_DATA_CLEAR_FRESH_HELPER_FAMILY;
  readonly kind: "clearAndVerify";
  readonly evidenceRevision: typeof ROLE_BROWSER_DATA_CLEAR_EVIDENCE_REVISION;
  readonly platform: "darwin" | "win32";
  readonly effectId: string;
  readonly operationId: string;
  readonly roleId: string;
  readonly rolePaths: RolePathsRecord;
  readonly chromiumPathSha256: string;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const ROLE_PATH_KEYS = Object.freeze([
  "browserUserDataDir",
  "systemBrowserDataDir",
  "webview2UserDataDir",
  "chromiumUserDataDir",
  "webkitDataStoreKey",
  "webkitDataStoreIdentifier"
] as const);

function metadataError(): RionBridgeError {
  return new RionBridgeError({
    code: "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_FRESH_HELPER_METADATA_INVALID",
    message: "The fresh browser-data clear helper metadata is not canonical."
  });
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw metadataError();
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[]
): void {
  const expected = new Set(keys);
  if (
    keys.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !expected.has(key))
  ) {
    throw metadataError();
  }
}

function boundedIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 160 &&
    value === value.trim() &&
    ![...value].some((character) => {
      const point = character.codePointAt(0)!;
      return point <= 0x1f || point === 0x7f;
    });
}

function pathsFor(platform: "darwin" | "win32"): typeof posix {
  return platform === "win32" ? win32 : posix;
}

function validateRolePaths(
  value: unknown,
  roleId: string,
  platform: "darwin" | "win32"
): RolePathsRecord {
  const rolePaths = record(value);
  exactKeys(rolePaths, ROLE_PATH_KEYS);
  const paths = pathsFor(platform);
  if (ROLE_PATH_KEYS.some((key) => {
    const path = rolePaths[key];
    return typeof path !== "string" || path.length === 0 ||
      path.length > 8_192 || path.includes("\0");
  })) {
    throw metadataError();
  }
  const browserRoot = rolePaths.browserUserDataDir as string;
  const chromiumPath = rolePaths.chromiumUserDataDir as string;
  const roleDirectory = paths.dirname(browserRoot);
  if (
    !paths.isAbsolute(browserRoot) || paths.normalize(browserRoot) !== browserRoot ||
    !paths.isAbsolute(chromiumPath) || paths.normalize(chromiumPath) !== chromiumPath ||
    paths.basename(browserRoot) !== "browser" ||
    paths.basename(roleDirectory) !== roleId ||
    paths.basename(paths.dirname(roleDirectory)) !== "roles" ||
    paths.join(browserRoot, "chromium") !== chromiumPath
  ) {
    throw metadataError();
  }
  return Object.freeze({ ...rolePaths }) as unknown as RolePathsRecord;
}

function parseJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw metadataError();
  }
}

export function chromiumRoleBrowserDataPathSha256(path: string): string {
  return createHash("sha256").update(path, "utf8").digest("hex");
}

export function isRoleBrowserDataClearFreshHelperMetadata(
  bytes: Buffer
): boolean {
  try {
    const value = parseJson(bytes);
    return typeof value === "object" && value !== null &&
      !Array.isArray(value) &&
      (value as { family?: unknown }).family ===
        ROLE_BROWSER_DATA_CLEAR_FRESH_HELPER_FAMILY;
  } catch {
    return false;
  }
}

export function parseChromiumRoleBrowserDataClearFreshHelperRequest(
  metadataBytes: Buffer
): ChromiumRoleBrowserDataClearFreshHelperRequest {
  const request = record(parseJson(metadataBytes));
  exactKeys(request, [
    "version",
    "family",
    "kind",
    "evidenceRevision",
    "platform",
    "effectId",
    "operationId",
    "roleId",
    "rolePaths",
    "chromiumPathSha256"
  ]);
  if (
    request.version !== 1 ||
    request.family !== ROLE_BROWSER_DATA_CLEAR_FRESH_HELPER_FAMILY ||
    request.kind !== "clearAndVerify" ||
    request.evidenceRevision !== ROLE_BROWSER_DATA_CLEAR_EVIDENCE_REVISION ||
    !new Set(["darwin", "win32"]).has(request.platform as string) ||
    !boundedIdentity(request.effectId) ||
    !boundedIdentity(request.operationId) ||
    typeof request.roleId !== "string" || !UUID.test(request.roleId) ||
    typeof request.chromiumPathSha256 !== "string" ||
    !SHA256.test(request.chromiumPathSha256)
  ) {
    throw metadataError();
  }
  const platform = request.platform as "darwin" | "win32";
  const rolePaths = validateRolePaths(request.rolePaths, request.roleId, platform);
  if (
    chromiumRoleBrowserDataPathSha256(rolePaths.chromiumUserDataDir) !==
      request.chromiumPathSha256
  ) {
    throw metadataError();
  }
  return Object.freeze({
    ...request,
    rolePaths
  }) as unknown as ChromiumRoleBrowserDataClearFreshHelperRequest;
}

export function encodeChromiumRoleBrowserDataClearFreshHelperRequest(
  request: ChromiumRoleBrowserDataClearFreshHelperRequest
): Buffer {
  return Buffer.from(JSON.stringify(request), "utf8");
}

export function chromiumRoleBrowserDataClearFreshHelperResponseMetadata(
  request: ChromiumRoleBrowserDataClearFreshHelperRequest,
  values: Readonly<Record<string, unknown>>
): Buffer {
  return Buffer.from(JSON.stringify({
    version: 1,
    family: ROLE_BROWSER_DATA_CLEAR_FRESH_HELPER_FAMILY,
    kind: request.kind,
    evidenceRevision: request.evidenceRevision,
    platform: request.platform,
    effectId: request.effectId,
    operationId: request.operationId,
    roleId: request.roleId,
    chromiumPathSha256: request.chromiumPathSha256,
    ...values
  }), "utf8");
}
