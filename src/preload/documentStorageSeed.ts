import type {
  EmbeddedDocumentStorageAcknowledgement,
  EmbeddedDocumentStorageSeed
} from "../shared/internalIpc";

export type DocumentStorageSeedRequester = (origin: string) => unknown;
export type DocumentStorageAcknowledgementSender = (
  acknowledgement: EmbeddedDocumentStorageAcknowledgement
) => void;

export interface DocumentStorageSeedWindow {
  location: Pick<Location, "origin">;
}

export interface StorageLike {
  setItem: (key: string, value: string) => void;
}

export type StorageGetter = () => StorageLike;

export function installDocumentStorageSeedAtDocumentStart(
  currentWindow: DocumentStorageSeedWindow,
  getLocalStorage: StorageGetter,
  getSessionStorage: StorageGetter,
  requestSeed: DocumentStorageSeedRequester,
  acknowledge: DocumentStorageAcknowledgementSender,
  isMainFrame = true
): void {
  if (!isMainFrame) return;

  const origin = currentWindow.location.origin;
  let seed: unknown;
  try {
    seed = requestSeed(origin);
  } catch {
    return;
  }
  if (!isEmbeddedDocumentStorageSeed(seed)) return;

  const localResult = applyStorage(getLocalStorage, seed.localStorage ?? {});
  const sessionResult = applyStorage(getSessionStorage, seed.sessionStorage ?? {});
  try {
    acknowledge({
      localStorageApplied: localResult.applied,
      localStorageKeyCount: localResult.keyCount,
      origin,
      sessionStorageApplied: sessionResult.applied,
      sessionStorageKeyCount: sessionResult.keyCount
    });
  } catch {
    // The main process retains unacknowledged localStorage for a later retry.
  }
}

function applyStorage(getStorage: StorageGetter, values: Record<string, string>): {
  applied: boolean;
  keyCount: number;
} {
  let storage: StorageLike;
  try {
    storage = getStorage();
  } catch {
    return { applied: false, keyCount: 0 };
  }
  let applied = true;
  let keyCount = 0;
  for (const [key, value] of Object.entries(values)) {
    try {
      storage.setItem(key, value);
      keyCount += 1;
    } catch {
      applied = false;
    }
  }
  return { applied, keyCount };
}

function isEmbeddedDocumentStorageSeed(value: unknown): value is EmbeddedDocumentStorageSeed {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const seed = value as EmbeddedDocumentStorageSeed;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => key === "localStorage" || key === "sessionStorage") &&
    (seed.localStorage === undefined || isStringStorage(seed.localStorage)) &&
    (seed.sessionStorage === undefined || isStringStorage(seed.sessionStorage));
}

function isStringStorage(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.values(value).every((storageValue) => typeof storageValue === "string");
}
