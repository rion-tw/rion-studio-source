import { lstat, readlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const BROWSER_USER_DATA_LOCK_TIMEOUT_MESSAGE =
  "Chrome is still using this role's browser data. Quit the Chrome login window and try again.";

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_POLL_INTERVAL_MS = 500;

export interface BrowserUserDataLockState {
  locked: boolean;
  pid?: number;
  reason?: string;
  indicators: {
    singletonLock: boolean;
    singletonSocket: boolean;
    singletonCookie: boolean;
  };
}

export interface BrowserUserDataLockWatcherConfig {
  platform?: NodeJS.Platform;
  isProcessAlive?: (pid: number) => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface WaitForUserDataReleaseOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export class BrowserUserDataLockTimeoutError extends Error {
  readonly code = "BROWSER_USER_DATA_LOCK_TIMEOUT";

  constructor(readonly lastState?: BrowserUserDataLockState) {
    super(BROWSER_USER_DATA_LOCK_TIMEOUT_MESSAGE);
    this.name = "BrowserUserDataLockTimeoutError";
  }
}

export class BrowserUserDataLockWatcher {
  private readonly platform: NodeJS.Platform;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(config: BrowserUserDataLockWatcherConfig = {}) {
    this.platform = config.platform ?? process.platform;
    this.isProcessAlive = config.isProcessAlive ?? defaultIsProcessAlive;
    this.now = config.now ?? Date.now;
    this.sleep = config.sleep ?? ((ms) => delay(ms));
  }

  async getLockState(userDataDir: string): Promise<BrowserUserDataLockState> {
    const indicators = await readLockIndicators(userDataDir);

    if (this.platform === "win32") {
      return {
        locked: false,
        reason: indicators.singletonLock ? "windows_retry_launch_fallback" : "lock_missing",
        indicators
      };
    }

    if (!indicators.singletonLock) {
      return {
        locked: false,
        reason: "lock_missing",
        indicators
      };
    }

    const lockTarget = await readlink(join(userDataDir, "SingletonLock")).catch(() => undefined);
    const pid = lockTarget ? parseSingletonLockPid(lockTarget) : undefined;

    if (pid !== undefined && this.isProcessAlive(pid)) {
      return {
        locked: true,
        pid,
        reason: "singleton_lock_pid_alive",
        indicators
      };
    }

    return {
      locked: false,
      pid,
      reason: pid === undefined ? "singleton_lock_pid_unreadable" : "singleton_lock_pid_gone",
      indicators
    };
  }

  async waitForRelease(userDataDir: string, options: WaitForUserDataReleaseOptions = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const startedAt = this.now();
    let lastState: BrowserUserDataLockState | undefined;

    while (this.now() - startedAt <= timeoutMs) {
      lastState = await this.getLockState(userDataDir);

      if (!lastState.locked) {
        return;
      }

      const remainingMs = timeoutMs - (this.now() - startedAt);

      if (remainingMs <= 0) {
        break;
      }

      await this.sleep(Math.min(pollIntervalMs, remainingMs));
    }

    throw new BrowserUserDataLockTimeoutError(lastState);
  }
}

export function parseSingletonLockPid(lockTarget: string): number | undefined {
  const match = /-(\d+)$/.exec(lockTarget);

  if (!match) {
    return undefined;
  }

  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

async function readLockIndicators(userDataDir: string): Promise<BrowserUserDataLockState["indicators"]> {
  const [singletonLock, singletonSocket, singletonCookie] = await Promise.all([
    pathExists(join(userDataDir, "SingletonLock")),
    pathExists(join(userDataDir, "SingletonSocket")),
    pathExists(join(userDataDir, "SingletonCookie"))
  ]);

  return {
    singletonLock,
    singletonSocket,
    singletonCookie
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ESRCH") {
      return false;
    }

    if (isNodeError(error) && error.code === "EPERM") {
      return true;
    }

    return false;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
