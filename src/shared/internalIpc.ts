export const WORKSPACE_RESIZE_INDICATOR_CHANNEL = "workspace:resize-indicator";
export const EMBEDDED_SESSION_STORAGE_SEED_CHANNEL = "embedded:session-storage-seed";
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

export interface EmbeddedStorageBootstrapSeedRequest {
  origin: string;
}

export interface EmbeddedStorageBootstrapCompleted {
  cacheEntryCount: number;
  indexedDbRecordCount: number;
  localStorageKeyCount: number;
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
    "localStorageKeyCount" in value && isNonNegativeInteger((value as { localStorageKeyCount?: unknown }).localStorageKeyCount);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export {
  RUNTIME_TABS_ACTION_CHANNEL,
  RUNTIME_TABS_STATE_CHANNEL
} from "./runtimeTabs";
