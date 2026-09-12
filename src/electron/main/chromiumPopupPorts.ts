import { Buffer } from "node:buffer";

import type { ChromiumRoleSessionPort } from "./chromiumRoleSessionRegistry";
import type { ChromiumRoleSurfaceParentPort } from "./chromiumRoleSurfacePorts";

const MAX_POST_DATA_ENTRIES = 64;
const MAX_POST_FILE_ENTRIES = 16;
const MAX_POST_RAW_BYTES = 1_024 * 1_024;
const MAX_POST_BOUNDARY_BYTES = 70;
const MAX_POST_FILE_PATH_BYTES = 4_096;

export type ChromiumPopupPostData =
  | Readonly<{ type: "rawData"; bytes: Buffer }>
  | Readonly<{
      type: "file";
      filePath: string;
      length?: number;
      modificationTime?: number;
      offset?: number;
    }>;

export interface ChromiumPopupPostBody {
  readonly contentType:
    | "application/x-www-form-urlencoded"
    | "multipart/form-data";
  readonly boundary?: string;
  readonly data: readonly ChromiumPopupPostData[];
}

export interface ChromiumWindowOpenDetails {
  readonly url: string;
  readonly disposition?: string;
  readonly frameName?: string;
  readonly features?: string;
  readonly referrer?: Readonly<{
    url: string;
    policy: string;
  }>;
  readonly postBody?: unknown;
}

/** Electron reports a missing popup POST payload as either null or undefined. */
export function hasChromiumWindowOpenPostBody(
  details: ChromiumWindowOpenDetails
): boolean {
  return details.postBody !== null && details.postBody !== undefined;
}

function boundedOptionalNumber(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/**
 * Copies Electron's ephemeral POST envelope before popup admission awaits Core.
 * Undefined means GET/no body, while null means a present but unsafe envelope.
 */
export function normalizeChromiumWindowOpenPostBody(
  details: ChromiumWindowOpenDetails
): ChromiumPopupPostBody | null | undefined {
  if (!hasChromiumWindowOpenPostBody(details)) return undefined;
  const input = details.postBody;
  if (!input || typeof input !== "object") return null;
  const body = input as Readonly<Record<string, unknown>>;
  const contentType = body.contentType;
  if (
    contentType !== "application/x-www-form-urlencoded" &&
    contentType !== "multipart/form-data"
  ) return null;
  const boundary = body.boundary;
  if (contentType === "multipart/form-data") {
    if (
      typeof boundary !== "string" || boundary.length === 0 ||
      Buffer.byteLength(boundary) > MAX_POST_BOUNDARY_BYTES ||
      !/^[0-9A-Za-z'()+_,./:=?-]+$/u.test(boundary)
    ) return null;
  } else if (boundary !== undefined) {
    return null;
  }
  if (!Array.isArray(body.data) || body.data.length > MAX_POST_DATA_ENTRIES) {
    return null;
  }
  const data: ChromiumPopupPostData[] = [];
  let fileEntries = 0;
  let rawBytes = 0;
  const reject = (): null => {
    for (const entry of data) {
      if (entry.type === "rawData") entry.bytes.fill(0);
    }
    return null;
  };
  for (const candidate of body.data) {
    if (!candidate || typeof candidate !== "object") return reject();
    const entry = candidate as Readonly<Record<string, unknown>>;
    if (entry.type === "rawData") {
      if (!Buffer.isBuffer(entry.bytes)) return reject();
      rawBytes += entry.bytes.byteLength;
      if (rawBytes > MAX_POST_RAW_BYTES) return reject();
      data.push(Object.freeze({
        type: "rawData" as const,
        bytes: Buffer.from(entry.bytes)
      }));
      continue;
    }
    if (entry.type !== "file") return reject();
    fileEntries += 1;
    const filePath = entry.filePath;
    const offset = boundedOptionalNumber(entry.offset);
    const length = boundedOptionalNumber(entry.length);
    const modificationTime = boundedOptionalNumber(entry.modificationTime);
    if (
      fileEntries > MAX_POST_FILE_ENTRIES || typeof filePath !== "string" ||
      filePath.length === 0 || filePath !== filePath.trim() ||
      Buffer.byteLength(filePath) > MAX_POST_FILE_PATH_BYTES ||
      /[\r\n\0]/u.test(filePath) || offset === null || length === null ||
      modificationTime === null
    ) return reject();
    data.push(Object.freeze({
      type: "file" as const,
      filePath,
      ...(offset === undefined ? {} : { offset }),
      ...(length === undefined ? {} : { length }),
      ...(modificationTime === undefined ? {} : { modificationTime })
    }));
  }
  return Object.freeze({
    contentType,
    ...(typeof boundary === "string" ? { boundary } : {}),
    data: Object.freeze(data)
  });
}

/** Clears only the private raw-data copies owned by the popup coordinator. */
export function clearChromiumPopupPostBody(
  body: ChromiumPopupPostBody | undefined
): void {
  for (const entry of body?.data ?? []) {
    if (entry.type === "rawData") entry.bytes.fill(0);
  }
}

export type ChromiumPopupOwnerSource = Readonly<{
  ownerKind: "role" | "globalWeb";
  ownerId: string;
  slotId?: string;
  nativeGeneration: number;
  parent: ChromiumRoleSurfaceParentPort;
  session: ChromiumRoleSessionPort;
}>;

export interface ChromiumPopupOwnerLifecyclePort {
  requestOpen: (
    source: ChromiumPopupOwnerSource,
    details: ChromiumWindowOpenDetails
  ) => void;
  retireOwner: (owner: Readonly<{
    ownerKind: "role" | "globalWeb";
    ownerId: string;
    nativeGeneration: number;
  }>) => Promise<void>;
  /** Close the owner's current popups while temporarily fencing new admission. */
  retireOwnerPopupsForMove: (owner: Readonly<{
    ownerKind: "role" | "globalWeb";
    ownerId: string;
    nativeGeneration: number;
  }>) => Promise<void>;
  prepareOwnerReload?: (owner: Readonly<{
    ownerKind: "role";
    ownerId: string;
    nativeGeneration: number;
  }>, operationId: string) => Promise<void>;
  releaseOwnerReload?: (owner: Readonly<{
    ownerKind: "role";
    ownerId: string;
    nativeGeneration: number;
  }>, operationId: string) => boolean;
}

export interface ChromiumPopupHostLifecycleObserver {
  readonly closeRequested: () => void;
  readonly closed: () => void;
  readonly layoutChanged: (bounds: Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>) => void;
}
