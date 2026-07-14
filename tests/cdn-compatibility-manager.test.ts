import type { Session } from "electron";
import { describe, expect, it, vi } from "vitest";

import {
  CdnCompatibilityManager,
  createCdnCompatibilityRequestPatterns,
  rewriteCdnCompatibilityUrl
} from "../src/main/game-browser/CdnCompatibilityManager";
import { DEFAULT_GAME_BROWSER_SETTINGS } from "../src/shared/browserFonts";
import type { BrowserCdnCompatibilityMode, GameBrowserSettings } from "../src/shared/types";

describe("CDN compatibility rules", () => {
  it.each([
    [
      "https://ajax.googleapis.com/ajax/libs/jquery/3.7.1/jquery.min.js?cache=1",
      "https://ajax.loli.net/ajax/libs/jquery/3.7.1/jquery.min.js?cache=1"
    ],
    [
      "https://fonts.googleapis.com/css2?family=Roboto:wght@400&display=swap",
      "https://fonts.googleapis.cn/css2?family=Roboto:wght@400&display=swap"
    ],
    [
      "https://themes.googleusercontent.com/static/fonts/example.woff2",
      "https://themes.loli.net/static/fonts/example.woff2"
    ],
    [
      "https://fonts.gstatic.com/s/roboto/v1/font.woff2",
      "https://fonts.gstatic.cn/s/roboto/v1/font.woff2"
    ],
    [
      "https://www.google.com/recaptcha/api.js?render=explicit",
      "https://www.recaptcha.net/recaptcha/api.js?render=explicit"
    ],
    [
      "https://secure.gravatar.com/avatar/hash?s=64",
      "https://gravatar.loli.net/avatar/hash?s=64"
    ],
    [
      "https://maxcdn.bootstrapcdn.com/bootstrap/3.4.1/css/bootstrap.min.css",
      "https://cdn.bootcdn.net/ajax/libs/twitter-bootstrap/3.4.1/css/bootstrap.min.css"
    ],
    [
      "https://code.jquery.com/jquery-3.7.1.min.js?cache=1",
      "https://fastly.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js?cache=1"
    ]
  ])("rewrites %s", (source, target) => {
    expect(rewriteCdnCompatibilityUrl(source)).toBe(target);
    expect(rewriteCdnCompatibilityUrl(target)).toBeUndefined();
  });

  it("does not rewrite navigation, analytics, HTTP, or unrelated CDN URLs", () => {
    expect(rewriteCdnCompatibilityUrl("https://www.google.com/search?q=flyff")).toBeUndefined();
    expect(rewriteCdnCompatibilityUrl("https://www.googletagmanager.com/gtm.js?id=GTM-1")).toBeUndefined();
    expect(rewriteCdnCompatibilityUrl("http://fonts.googleapis.com/css2?family=Roboto")).toBeUndefined();
    expect(rewriteCdnCompatibilityUrl("https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js")).toBeUndefined();
  });

  it("generates eight request-stage CDP patterns", () => {
    const patterns = createCdnCompatibilityRequestPatterns();

    expect(patterns).toHaveLength(8);
    expect(patterns).toContainEqual({
      requestStage: "Request",
      urlPattern: "https://www.google.com/*"
    });
    expect(patterns.every((pattern) => pattern.requestStage === "Request")).toBe(true);
  });
});

describe("CdnCompatibilityManager", () => {
  it("enables auto mode when Google is unavailable", async () => {
    const session = createSession(async () => createResponse(false));
    const manager = createManager("auto");

    await expect(manager.applyToSession(session.value)).resolves.toBe(true);
    expect(session.fetch).toHaveBeenCalledTimes(1);
    expect(session.onBeforeRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({ urls: expect.arrayContaining(["https://www.google.com/*"]) }),
      expect.any(Function)
    );

    const listener = session.onBeforeRequest.mock.calls.at(-1)?.[1];
    const callback = vi.fn();
    listener(
      {
        resourceType: "mainFrame",
        url: "https://www.google.com/recaptcha/api.js"
      },
      callback
    );
    expect(callback).toHaveBeenCalledWith({});
  });

  it("leaves auto mode disabled when Google succeeds", async () => {
    const googleAvailable = createSession(async () => createResponse(true));

    await expect(createManager("auto").applyToSession(googleAvailable.value)).resolves.toBe(false);
    expect(googleAvailable.onBeforeRequest).toHaveBeenLastCalledWith(null);
  });

  it("enables on probe timeout and caches results by proxy for ten minutes", async () => {
    let now = 1_000;
    const session = createSession(
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })
    );
    const manager = createManager("auto", { detectionTimeoutMs: 5, now: () => now });

    await expect(manager.applyToSession(session.value)).resolves.toBe(true);
    await expect(manager.applyToSession(session.value)).resolves.toBe(true);
    expect(session.fetch).toHaveBeenCalledTimes(1);

    now += 10 * 60 * 1_000 + 1;
    await expect(manager.applyToSession(session.value)).resolves.toBe(true);
    expect(session.fetch).toHaveBeenCalledTimes(2);
  });

  it("shares an in-flight auto detection across simultaneous sessions", async () => {
    let finishFetch!: (response: Response) => void;
    const session = createSession(
      async () => new Promise<Response>((resolve) => {
        finishFetch = resolve;
      })
    );
    const manager = createManager("auto");

    const first = manager.resolveForSession(session.value);
    const second = manager.resolveForSession(session.value);
    await vi.waitFor(() => expect(session.fetch).toHaveBeenCalledTimes(1));
    finishFetch(createResponse(false));

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(session.fetch).toHaveBeenCalledTimes(1);
  });

  it("forces on without probing and keeps off fail-open", async () => {
    const onSession = createSession(async () => createResponse(false));
    const offSession = createSession(async () => createResponse(true));

    await expect(createManager("on").applyToSession(onSession.value)).resolves.toBe(true);
    await expect(createManager("off").applyToSession(offSession.value)).resolves.toBe(false);
    expect(onSession.fetch).not.toHaveBeenCalled();
    expect(offSession.fetch).not.toHaveBeenCalled();
  });

  it("resolves external compatibility without registering an Electron request listener", async () => {
    const session = createSession(async () => createResponse(false));

    await expect(createManager("auto").resolveForSession(session.value)).resolves.toBe(true);
    expect(session.onBeforeRequest).not.toHaveBeenCalled();
  });
});

function createManager(
  mode: BrowserCdnCompatibilityMode,
  options: { detectionTimeoutMs?: number; now?: () => number } = {}
): CdnCompatibilityManager {
  const settings: GameBrowserSettings = {
    ...DEFAULT_GAME_BROWSER_SETTINGS,
    network: {
      ...DEFAULT_GAME_BROWSER_SETTINGS.network,
      cdnCompatibility: { mode }
    }
  };
  return new CdnCompatibilityManager({
    ...options,
    getSettings: async () => settings
  });
}

function createSession(fetchImplementation: (url: string, init?: RequestInit) => Promise<Response>) {
  const fetch = vi.fn(fetchImplementation);
  const onBeforeRequest = vi.fn();
  return {
    fetch,
    onBeforeRequest,
    value: {
      fetch,
      webRequest: { onBeforeRequest }
    } as unknown as Session
  };
}

function createResponse(ok: boolean): Response {
  return { ok } as Response;
}
