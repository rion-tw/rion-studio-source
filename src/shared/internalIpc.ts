export const WORKSPACE_RESIZE_INDICATOR_CHANNEL = "workspace:resize-indicator";
export const EMBEDDED_DOCUMENT_STORAGE_SEED_CHANNEL = "embedded:document-storage-seed";
export const EMBEDDED_DOCUMENT_STORAGE_ACK_CHANNEL = "embedded:document-storage-ack";
export const EMBEDDED_STORAGE_BOOTSTRAP_SEED_CHANNEL = "embedded:storage-bootstrap-seed";
export const EMBEDDED_STORAGE_BOOTSTRAP_COMPLETE_CHANNEL = "embedded:storage-bootstrap-complete";

export interface EmbeddedSessionStorageSeedRequest {
  origin: string;
}

export function isEmbeddedSessionStorageSeedRequest(value: unknown): value is EmbeddedSessionStorageSeedRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    "origin" in value &&
    typeof (value as { origin?: unknown }).origin === "string"
  );
}

export function isSessionStorageSeed(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((storageValue) => typeof storageValue === "string");
}

export interface EmbeddedDocumentStorageSeed {
  localStorage?: Record<string, string>;
  sessionStorage?: Record<string, string>;
}

export interface EmbeddedDocumentStorageAcknowledgement {
  localStorageApplied: boolean;
  localStorageKeyCount: number;
  origin: string;
  sessionStorageApplied: boolean;
  sessionStorageKeyCount: number;
}

export function isEmbeddedDocumentStorageSeed(value: unknown): value is EmbeddedDocumentStorageSeed {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const seed = value as EmbeddedDocumentStorageSeed;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => key === "localStorage" || key === "sessionStorage") &&
    (seed.localStorage === undefined || isSessionStorageSeed(seed.localStorage)) &&
    (seed.sessionStorage === undefined || isSessionStorageSeed(seed.sessionStorage));
}

export function isEmbeddedDocumentStorageAcknowledgement(
  value: unknown
): value is EmbeddedDocumentStorageAcknowledgement {
  return typeof value === "object" && value !== null &&
    "origin" in value && typeof (value as { origin?: unknown }).origin === "string" &&
    "localStorageApplied" in value &&
      typeof (value as { localStorageApplied?: unknown }).localStorageApplied === "boolean" &&
    "sessionStorageApplied" in value &&
      typeof (value as { sessionStorageApplied?: unknown }).sessionStorageApplied === "boolean" &&
    "localStorageKeyCount" in value &&
      isNonNegativeInteger((value as { localStorageKeyCount?: unknown }).localStorageKeyCount) &&
    "sessionStorageKeyCount" in value &&
      isNonNegativeInteger((value as { sessionStorageKeyCount?: unknown }).sessionStorageKeyCount);
}

export interface EmbeddedStorageBootstrapSeedRequest {
  origin: string;
}

export interface EmbeddedStorageBootstrapCompleted {
  cacheEntryCount: number;
  failureStage?: "cache_storage" | "indexed_db";
  indexedDbRecordCount: number;
  origin: string;
  success: boolean;
}

export function isEmbeddedStorageBootstrapSeedRequest(value: unknown): value is EmbeddedStorageBootstrapSeedRequest {
  return isEmbeddedSessionStorageSeedRequest(value);
}

export function isEmbeddedStorageBootstrapCompleted(value: unknown): value is EmbeddedStorageBootstrapCompleted {
  return typeof value === "object" && value !== null &&
    "origin" in value && typeof (value as { origin?: unknown }).origin === "string" &&
    "success" in value && typeof (value as { success?: unknown }).success === "boolean" &&
    "indexedDbRecordCount" in value && isNonNegativeInteger((value as { indexedDbRecordCount?: unknown }).indexedDbRecordCount) &&
    "cacheEntryCount" in value && isNonNegativeInteger((value as { cacheEntryCount?: unknown }).cacheEntryCount) &&
    (!("failureStage" in value) || ["cache_storage", "indexed_db"].includes(
      String((value as { failureStage?: unknown }).failureStage)
    ));
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export {
  RUNTIME_TABS_ACTION_CHANNEL,
  RUNTIME_TABS_STATE_CHANNEL
} from "./runtimeTabs";
