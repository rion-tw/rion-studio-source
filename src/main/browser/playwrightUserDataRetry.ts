import { setTimeout as delay } from "node:timers/promises";

import { BrowserUserDataLockTimeoutError } from "./BrowserUserDataLockWatcher";

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_INTERVAL_MS = 500;

export interface PlaywrightUserDataRetryOptions {
  timeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (error: unknown, attempt: number) => void;
}

export async function withPlaywrightUserDataLockRetry<T>(
  operation: () => Promise<T>,
  options: PlaywrightUserDataRetryOptions = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  const startedAt = now();
  let attempt = 0;

  while (now() - startedAt <= timeoutMs) {
    try {
      return await operation();
    } catch (error) {
      if (!isPlaywrightUserDataInUseError(error)) {
        throw error;
      }

      attempt += 1;
      options.onRetry?.(error, attempt);

      const remainingMs = timeoutMs - (now() - startedAt);

      if (remainingMs <= 0) {
        break;
      }

      await sleep(Math.min(intervalMs, remainingMs));
    }
  }

  throw new BrowserUserDataLockTimeoutError();
}

export function isPlaywrightUserDataInUseError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();

  return (
    normalized.includes("opening in existing browser session") ||
    normalized.includes("profile is already in use") ||
    normalized.includes("user data directory is already in use") ||
    (normalized.includes("userdatadir") && normalized.includes("already in use"))
  );
}
