import type { Session } from "electron";
import { describe, expect, it, vi } from "vitest";

import { CdnCompatibilityManager } from "../src/main/game-browser/CdnCompatibilityManager";
import { ElectronHandleRegistry } from "../src/main/core/ElectronEffectExecutor";

describe("CdnCompatibilityManager", () => {
  it("installs only Rust-provided host filters and keeps the request callback primitive-only", async () => {
    const session = createSession(async () => createResponse(false));
    const matchCdnUrl = vi.fn((url: string) => `${url}?mirror=1`);
    const manager = createManager({
      invoke: vi.fn(async () => ({
        enabled: true,
        requestPatterns: ["https://www.google.com/*"]
      })),
      matchCdnUrl
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
      redirectURL: "https://www.google.com/a.js?mirror=1"
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
      return { enabled: true, requestPatterns: [] };
    });
    const session = createSession(async () => createResponse(false));
    const manager = createManager({ handles, invoke });

    await manager.resolveForSession(session.value);

    expect(invoke).toHaveBeenCalledWith({
      type: "cdnResolveSession",
      sessionHandleId: observedHandles[0]
    });
    expect(handles.get(observedHandles[0]!)).toBeUndefined();
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
      { cache: "no-store", credentials: "omit" }
    );
  });
});

function createManager(options: {
  handles?: ElectronHandleRegistry;
  invoke: ReturnType<typeof vi.fn>;
  matchCdnUrl?: (url: string) => string | undefined;
}): CdnCompatibilityManager {
  return new CdnCompatibilityManager({
    core: { invoke: options.invoke } as never,
    handles: options.handles ?? new ElectronHandleRegistry(),
    matchCdnUrl: options.matchCdnUrl ?? (() => undefined)
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
