import type { Session } from "electron";
import { describe, expect, it, vi } from "vitest";

import { CdnCompatibilityManager } from "../src/main/game-browser/CdnCompatibilityManager";
import { ElectronHandleRegistry } from "../src/main/core/ElectronEffectExecutor";
import { v1Case } from "./helpers/v1Parity";

describe("CdnCompatibilityManager", () => {
  it("compiles the Rust rewrite plan once and keeps requests off the synchronous Node-API path", async () => {
    const session = createSession(async () => createResponse(false));
    const manager = createManager({
      invoke: vi.fn(async () => ({
        enabled: true,
        requestPatterns: ["https://www.google.com/*"],
        rewriteRules: [{
          id: "google",
          regexFilter: "^https://www\\.google\\.com/(.*)$",
          regexSubstitution: "https://www.recaptcha.net/\\1",
          sourceHost: "www.google.com"
        }]
      }))
    });

    await expect(manager.applyToSession(session.value)).resolves.toBe(true);
    expect(session.onBeforeRequest).toHaveBeenLastCalledWith(
      { urls: ["https://www.google.com/*"] },
      expect.any(Function)
    );

    const listener = session.onBeforeRequest.mock.calls.at(-1)?.[1];
    const callback = vi.fn();
    listener({ resourceType: "mainFrame", url: "https://www.google.com/a.js" }, callback);
    expect(callback).toHaveBeenLastCalledWith({});
    listener({ resourceType: "script", url: "https://www.google.com/a.js" }, callback);
    expect(callback).toHaveBeenLastCalledWith({
      redirectURL: "https://www.recaptcha.net/a.js"
    });
  });

  it("leaves the request listener disabled when Rust resolves the policy off", async () => {
    const session = createSession(async () => createResponse(true));
    const manager = createManager({
      invoke: vi.fn(async () => ({ enabled: false, requestPatterns: [] }))
    });

    await expect(manager.applyToSession(session.value)).resolves.toBe(false);
    expect(session.onBeforeRequest).toHaveBeenCalledOnce();
    expect(session.onBeforeRequest).toHaveBeenCalledWith(null);
  });

  it("registers the Electron session only for the duration of the Rust intent", async () => {
    const handles = new ElectronHandleRegistry();
    const observedHandles: string[] = [];
    const invoke = vi.fn(async (command: { sessionHandleId: string }) => {
      expect(handles.get(command.sessionHandleId)).toBeDefined();
      observedHandles.push(command.sessionHandleId);
      return { enabled: true, requestPatterns: [], rewriteRules: [] };
    });
    const session = createSession(async () => createResponse(false));
    const manager = createManager({ handles, invoke });

    await manager.resolveForSession(session.value);

    expect(invoke).toHaveBeenCalledWith({
      type: "cdnResolveSession",
      sessionHandleId: observedHandles[0]
    });
    expect(handles.get(observedHandles[0]!)).toBeUndefined();
    v1Case("external-chrome-cdn-dbf004db682c", () => {
      expect(session.onBeforeRequest).not.toHaveBeenCalled();
    });
  });

  it("executes only the raw session.fetch probe requested by Rust", async () => {
    const handles = new ElectronHandleRegistry();
    const session = createSession(async () => createResponse(true));
    handles.register("cdn-session-test", session.value as never);
    const manager = createManager({ handles, invoke: vi.fn() });

    await expect(manager.executeEffect({
      effectId: "effect-1",
      operationId: "operation-1",
      target: { kind: "session", handleId: "cdn-session-test" },
      deadlineMs: 100,
      action: {
        type: "cdnProbeGoogle",
        url: "https://www.google.com/recaptcha/api.js?render=explicit"
      }
    })).resolves.toEqual({ available: true });

    expect(session.fetch).toHaveBeenCalledWith(
      "https://www.google.com/recaptcha/api.js?render=explicit",
      {
        cache: "no-store",
        credentials: "omit",
        signal: expect.any(AbortSignal)
      }
    );
  });

  it("aborts a CDN probe when its Rust deadline elapses", async () => {
    vi.useFakeTimers();
    try {
      const handles = new ElectronHandleRegistry();
      const fetch = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>(
        (_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }
      ));
      const session = createSession(fetch);
      handles.register("cdn-session-timeout", session.value as never);
      const manager = createManager({
        createDeadlineSignal: (deadlineMs) => {
          const controller = new AbortController();
          globalThis.setTimeout(() => controller.abort(), deadlineMs);
          return controller.signal;
        },
        handles,
        invoke: vi.fn()
      });
      const pending = manager.executeEffect({
        effectId: "effect-timeout",
        operationId: "operation-timeout",
        target: { kind: "session", handleId: "cdn-session-timeout" },
        deadlineMs: 5,
        action: {
          type: "cdnProbeGoogle",
          url: "https://www.google.com/recaptcha/api.js?render=explicit"
        }
      });
      const rejection = pending.then(
        () => undefined,
        (error: unknown) => error
      );

      await vi.advanceTimersByTimeAsync(5);
      expect(await rejection).toEqual(expect.objectContaining({ message: "aborted" }));
      expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

function createManager(options: {
  createDeadlineSignal?: (deadlineMs: number) => AbortSignal;
  handles?: ElectronHandleRegistry;
  invoke: ReturnType<typeof vi.fn>;
}): CdnCompatibilityManager {
  return new CdnCompatibilityManager({
    core: { invoke: options.invoke } as never,
    ...(options.createDeadlineSignal
      ? { createDeadlineSignal: options.createDeadlineSignal }
      : {}),
    handles: options.handles ?? new ElectronHandleRegistry()
  });
}

function createSession(fetchImplementation: (url: string) => Promise<Response>) {
  const fetch = vi.fn(fetchImplementation);
  const onBeforeRequest = vi.fn();
  return {
    fetch,
    onBeforeRequest,
    value: {
      fetch,
      partition: "fixture",
      webRequest: { onBeforeRequest }
    } as unknown as Session
  };
}

function createResponse(ok: boolean): Response {
  return { ok } as Response;
}
