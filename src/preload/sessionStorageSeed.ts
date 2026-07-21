import { isSessionStorageSeed } from "../shared/internalIpc";

export type SessionStorageSeedRequester = (origin: string) => unknown;

export interface SessionStorageSeedWindow {
  location: Pick<Location, "origin">;
  top: SessionStorageSeedWindow | null;
}

interface SessionStorageLike {
  setItem: (key: string, value: string) => void;
}

export function installSessionStorageSeedAtDocumentStart(
  currentWindow: SessionStorageSeedWindow,
  storage: SessionStorageLike,
  requestSeed: SessionStorageSeedRequester
): void {
  if (currentWindow.top !== currentWindow) return;

  let values: unknown;
  try {
    values = requestSeed(currentWindow.location.origin);
  } catch {
    return;
  }
  if (!isSessionStorageSeed(values)) return;

  try {
    Object.entries(values).forEach(([key, value]) => storage.setItem(key, value));
  } catch {
    // Session storage may be unavailable for an opaque or restricted origin.
  }
}
