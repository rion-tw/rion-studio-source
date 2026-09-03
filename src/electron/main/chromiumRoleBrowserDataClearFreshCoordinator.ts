import type { ChromeProfileImportHelperProcessResultInternal } from
  "../core/coreAddonClient";
import type {
  ChromiumRoleBrowserDataClearInput
} from "./chromiumRoleBrowserDataClearCoordinator";
import {
  chromiumRoleBrowserDataPathSha256,
  encodeChromiumRoleBrowserDataClearFreshHelperRequest,
  ROLE_BROWSER_DATA_CLEAR_EVIDENCE_REVISION,
  ROLE_BROWSER_DATA_CLEAR_FRESH_HELPER_FAMILY,
  type ChromiumRoleBrowserDataClearFreshHelperRequest
} from "./chromiumRoleBrowserDataClearFreshHelperContract";

export interface ChromiumRoleBrowserDataClearFreshLauncherPort {
  launchChromeProfileImportHelperInternal: (
    metadataBytes: Buffer,
    secretBytes: Buffer,
    signal?: AbortSignal
  ) => Promise<ChromeProfileImportHelperProcessResultInternal>;
}

export type ChromiumRoleBrowserDataClearFreshResult =
  | Readonly<{ status: "applied" }>
  | Readonly<{
      status: "failed";
      stableErrorCode: string;
    }>
  | Readonly<{
      status: "indeterminate";
      stableErrorCode: string;
    }>;

const SHA256 = /^[0-9a-f]{64}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseJson(bytes: Buffer): Record<string, unknown> | null {
  try {
    return record(JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    ));
  } catch {
    return null;
  }
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  const expected = new Set(keys);
  return keys.every((key) => key in value) &&
    Object.keys(value).every((key) => expected.has(key));
}

function commonResponseMatches(
  response: Record<string, unknown>,
  request: ChromiumRoleBrowserDataClearFreshHelperRequest
): boolean {
  return response.version === 1 &&
    response.family === ROLE_BROWSER_DATA_CLEAR_FRESH_HELPER_FAMILY &&
    response.kind === request.kind &&
    response.evidenceRevision === request.evidenceRevision &&
    response.platform === request.platform &&
    response.effectId === request.effectId &&
    response.operationId === request.operationId &&
    response.roleId === request.roleId &&
    response.chromiumPathSha256 === request.chromiumPathSha256;
}

function parseApplied(
  result: ChromeProfileImportHelperProcessResultInternal,
  request: ChromiumRoleBrowserDataClearFreshHelperRequest
): ChromiumRoleBrowserDataClearFreshResult {
  if (
    result.outcome !== "applied" ||
    result.secretBytes.byteLength !== 0 ||
    !SHA256.test(result.exitEvidenceSha256)
  ) {
    return Object.freeze({
      status: "indeterminate",
      stableErrorCode:
        "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_FRESH_HELPER_RECEIPT_INVALID"
    });
  }
  const response = parseJson(result.metadataBytes);
  if (
    !response ||
    !exactKeys(response, [
      "version",
      "family",
      "kind",
      "evidenceRevision",
      "platform",
      "effectId",
      "operationId",
      "roleId",
      "chromiumPathSha256",
      "cookieReadbackCount",
      "storageClearAcknowledgement",
      "processInstanceId",
      "sessionDrainEvidenceSha256"
    ]) ||
    !commonResponseMatches(response, request) ||
    response.cookieReadbackCount !== 0 ||
    response.storageClearAcknowledgement !==
      "electron-clear-storage-data-promise" ||
    typeof response.processInstanceId !== "string" ||
    !UUID.test(response.processInstanceId) ||
    typeof response.sessionDrainEvidenceSha256 !== "string" ||
    !SHA256.test(response.sessionDrainEvidenceSha256)
  ) {
    return Object.freeze({
      status: "indeterminate",
      stableErrorCode:
        "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_FRESH_HELPER_RECEIPT_INVALID"
    });
  }
  return Object.freeze({ status: "applied" });
}

function parseFailure(
  result: ChromeProfileImportHelperProcessResultInternal,
  request: ChromiumRoleBrowserDataClearFreshHelperRequest
): ChromiumRoleBrowserDataClearFreshResult {
  if (
    result.outcome === "applied" ||
    result.secretBytes.byteLength !== 0 ||
    !SHA256.test(result.exitEvidenceSha256)
  ) {
    return Object.freeze({
      status: "indeterminate",
      stableErrorCode:
        "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_FRESH_HELPER_RECEIPT_INVALID"
    });
  }
  const response = parseJson(result.metadataBytes);
  if (
    !response ||
    !exactKeys(response, [
      "version",
      "family",
      "kind",
      "evidenceRevision",
      "platform",
      "effectId",
      "operationId",
      "roleId",
      "chromiumPathSha256",
      "stableErrorCode"
    ]) ||
    !commonResponseMatches(response, request) ||
    typeof response.stableErrorCode !== "string" ||
    !/^CHROMIUM_ROLE_BROWSER_DATA_CLEAR_[A-Z0-9_]{1,120}$/u
      .test(response.stableErrorCode)
  ) {
    return Object.freeze({
      status: "indeterminate",
      stableErrorCode:
        "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_FRESH_HELPER_RECEIPT_INVALID"
    });
  }
  return Object.freeze({
    status: result.outcome === "failed" ? "failed" : "indeterminate",
    stableErrorCode: response.stableErrorCode
  });
}

/** Launches one exact fixed-mode child and accepts only clean-exit evidence. */
export class ChromiumRoleBrowserDataClearFreshCoordinator {
  readonly #launcher: ChromiumRoleBrowserDataClearFreshLauncherPort;

  constructor(launcher: ChromiumRoleBrowserDataClearFreshLauncherPort) {
    this.#launcher = launcher;
  }

  async clearAndVerify(
    input: ChromiumRoleBrowserDataClearInput,
    platform: "darwin" | "win32",
    signal?: AbortSignal
  ): Promise<ChromiumRoleBrowserDataClearFreshResult> {
    if (signal?.aborted) {
      return Object.freeze({
        status: "failed",
        stableErrorCode: "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_CANCELLED"
      });
    }
    const request: ChromiumRoleBrowserDataClearFreshHelperRequest = Object.freeze({
      version: 1,
      family: ROLE_BROWSER_DATA_CLEAR_FRESH_HELPER_FAMILY,
      kind: "clearAndVerify",
      evidenceRevision: ROLE_BROWSER_DATA_CLEAR_EVIDENCE_REVISION,
      platform,
      effectId: input.effectId,
      operationId: input.operationId,
      roleId: input.roleId,
      rolePaths: input.rolePaths,
      chromiumPathSha256: chromiumRoleBrowserDataPathSha256(
        input.rolePaths.chromiumUserDataDir
      )
    });
    const metadataBytes = encodeChromiumRoleBrowserDataClearFreshHelperRequest(
      request
    );
    const secretBytes = Buffer.alloc(0);
    let result: ChromeProfileImportHelperProcessResultInternal;
    try {
      result = await this.#launcher.launchChromeProfileImportHelperInternal(
        metadataBytes,
        secretBytes,
        signal
      );
    } catch {
      return Object.freeze({
        status: "indeterminate",
        stableErrorCode: signal?.aborted
          ? "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_CANCELLED"
          : "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_FRESH_HELPER_LAUNCH_INDETERMINATE"
      });
    } finally {
      metadataBytes.fill(0);
      secretBytes.fill(0);
    }
    try {
      if (signal?.aborted) {
        return Object.freeze({
          status: "indeterminate",
          stableErrorCode: "CHROMIUM_ROLE_BROWSER_DATA_CLEAR_CANCELLED"
        });
      }
      return result.outcome === "applied"
        ? parseApplied(result, request)
        : parseFailure(result, request);
    } finally {
      result.metadataBytes.fill(0);
      result.secretBytes.fill(0);
    }
  }
}
