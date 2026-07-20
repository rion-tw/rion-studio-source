import {
  classifyAuthSession,
  type AuthSessionCheckResult
} from "./authSessionClassification";
import {
  createLoginStorageFingerprint,
  isPersistedLoginStorageReady,
  type LoginStorageSnapshot
} from "./loginEvidence";

export interface SettledAuthSessionSample {
  finalUrl: string;
  snapshot: LoginStorageSnapshot;
}

export interface SettledAuthSessionResult extends AuthSessionCheckResult {
  durationMs: number;
  snapshot?: LoginStorageSnapshot;
  stableSampleCount: number;
}

export interface WaitForSettledAuthSessionOptions {
  idleMs?: number;
  isIdle?: () => boolean;
  now?: () => number;
  pollIntervalMs?: number;
  requiredStableSamples?: number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

const DEFAULT_IDLE_MS = 1_500;
const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_REQUIRED_STABLE_SAMPLES = 2;
const DEFAULT_TIMEOUT_MS = 20_000;

export async function waitForSettledAuthSession(
  readSample: () => Promise<SettledAuthSessionSample>,
  options: WaitForSettledAuthSessionOptions = {}
): Promise<SettledAuthSessionResult> {
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const now = options.now ?? Date.now;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const requiredStableSamples = options.requiredStableSamples ?? DEFAULT_REQUIRED_STABLE_SAMPLES;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = now();
  let lastError: unknown;
  let lastFingerprint: string | undefined;
  let lastResult: AuthSessionCheckResult | undefined;
  let lastSnapshot: LoginStorageSnapshot | undefined;
  let stableSampleCount = 0;

  while (now() - startedAt <= timeoutMs) {
    const hasWaitedForInitialIdle = now() - startedAt >= idleMs;
    if (!hasWaitedForInitialIdle || options.isIdle?.() === false) {
      stableSampleCount = 0;
      lastFingerprint = undefined;
      await sleep(Math.min(pollIntervalMs, Math.max(1, timeoutMs - (now() - startedAt))));
      continue;
    }

    try {
      const sample = await readSample();
      const result = classifyAuthSession(
        sample.finalUrl,
        sample.snapshot.bodyText,
        isPersistedLoginStorageReady(sample.snapshot)
      );
      const fingerprint = JSON.stringify({
        authState: result.authState,
        finalUrl: sample.finalUrl,
        storage: createLoginStorageFingerprint(sample.snapshot)
      });

      lastResult = result;
      lastSnapshot = sample.snapshot;
      if (fingerprint === lastFingerprint) {
        stableSampleCount += 1;
      } else {
        lastFingerprint = fingerprint;
        stableSampleCount = 1;
      }

      if (stableSampleCount >= requiredStableSamples) {
        return {
          ...result,
          durationMs: now() - startedAt,
          snapshot: sample.snapshot,
          stableSampleCount
        };
      }
    } catch (error) {
      lastError = error;
      stableSampleCount = 0;
      lastFingerprint = undefined;
    }

    await sleep(Math.min(pollIntervalMs, Math.max(1, timeoutMs - (now() - startedAt))));
  }

  return {
    authState: "auth_failed",
    durationMs: now() - startedAt,
    finalUrl: lastResult?.finalUrl,
    message: lastError instanceof Error
      ? lastError.message
      : "Timed out while waiting for the login session to become stable.",
    snapshot: lastSnapshot,
    stableSampleCount
  };
}
