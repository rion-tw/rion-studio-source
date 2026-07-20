import { describe, expect, it, vi } from "vitest";

import { waitForSettledAuthSession } from "../src/main/auth/settledAuthSession";
import type { LoginStorageSnapshot } from "../src/main/auth/loginEvidence";

function createSnapshot(
  cookies: Record<string, string>,
  bodyText = "Game ready"
): LoginStorageSnapshot {
  return {
    bodyText,
    cookies,
    indexedDb: {},
    localStorage: {},
    sessionStorage: {}
  };
}

describe("waitForSettledAuthSession", () => {
  it("waits for two identical authenticated samples before accepting a session", async () => {
    let now = 0;
    const samples = [
      createSnapshot({ session: "renewing" }),
      createSnapshot({ session: "renewed" }),
      createSnapshot({ session: "renewed" })
    ];
    const readSample = vi.fn(async () => ({
      finalUrl: "https://example.test/play",
      snapshot: samples.shift() ?? createSnapshot({ session: "renewed" })
    }));

    const result = await waitForSettledAuthSession(readSample, {
      idleMs: 0,
      now: () => now,
      pollIntervalMs: 10,
      sleep: async (ms) => {
        now += ms;
      },
      timeoutMs: 100
    });

    expect(result).toMatchObject({
      authState: "authenticated",
      stableSampleCount: 2
    });
    expect(readSample).toHaveBeenCalledTimes(3);
  });

  it("does not sample until the page reports an idle network period", async () => {
    let now = 0;
    const readSample = vi.fn(async () => ({
      finalUrl: "https://example.test/play",
      snapshot: createSnapshot({ authToken: "ready" })
    }));

    const result = await waitForSettledAuthSession(readSample, {
      idleMs: 0,
      isIdle: () => now >= 20,
      now: () => now,
      pollIntervalMs: 10,
      requiredStableSamples: 1,
      sleep: async (ms) => {
        now += ms;
      },
      timeoutMs: 100
    });

    expect(result.authState).toBe("authenticated");
    expect(readSample).toHaveBeenCalledOnce();
    expect(result.durationMs).toBe(20);
  });

  it("returns auth_failed when the session never becomes readable", async () => {
    let now = 0;
    const result = await waitForSettledAuthSession(
      async () => {
        throw new Error("CDP disconnected");
      },
      {
        idleMs: 0,
        now: () => now,
        pollIntervalMs: 10,
        sleep: async (ms) => {
          now += ms;
        },
        timeoutMs: 25
      }
    );

    expect(result).toMatchObject({
      authState: "auth_failed",
      message: "CDP disconnected",
      stableSampleCount: 0
    });
  });
});
