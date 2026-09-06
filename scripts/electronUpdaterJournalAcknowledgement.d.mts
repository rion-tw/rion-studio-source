import type { access } from "node:fs/promises";
import type { FSWatcher } from "node:fs";

export interface UpdaterJournalObservationOperations {
  access: typeof access;
  watch(path: string, listener: (event: string, filename: string | Buffer | null) => void): FSWatcher;
}
export function waitForUpdaterJournalRemoval(
  path: string,
  timeoutMilliseconds: number,
  operations?: UpdaterJournalObservationOperations
): Promise<void>;
