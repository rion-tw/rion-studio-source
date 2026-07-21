export const WORKSPACE_RESIZE_INDICATOR_CHANNEL = "workspace:resize-indicator";
export const EMBEDDED_SESSION_STORAGE_SEED_CHANNEL = "embedded:session-storage-seed";

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

export {
  RUNTIME_TABS_ACTION_CHANNEL,
  RUNTIME_TABS_STATE_CHANNEL
} from "./runtimeTabs";
