import { access, rm } from "node:fs/promises";
import { join } from "node:path";

import { writeJsonFileAtomically } from "../persistence/atomicJsonFile";

export const IMPORTED_CHROME_PROFILE_MARKER = ".rion-studio-imported-profile.json";

interface ImportedChromeProfileMarker {
  version: 1;
}

export function getImportedChromeProfileMarkerPath(browserUserDataDir: string): string {
  return join(browserUserDataDir, IMPORTED_CHROME_PROFILE_MARKER);
}

export async function markImportedChromeProfilePending(browserUserDataDir: string): Promise<void> {
  const marker: ImportedChromeProfileMarker = { version: 1 };
  await writeJsonFileAtomically(getImportedChromeProfileMarkerPath(browserUserDataDir), marker);
}

export async function hasPendingImportedChromeProfile(browserUserDataDir: string): Promise<boolean> {
  try {
    await access(getImportedChromeProfileMarkerPath(browserUserDataDir));
    return true;
  } catch (error) {
    if (isMissingFile(error)) {
      return false;
    }
    throw error;
  }
}

export async function completeImportedChromeProfileVerification(browserUserDataDir: string): Promise<void> {
  await rm(getImportedChromeProfileMarkerPath(browserUserDataDir), { force: true });
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
