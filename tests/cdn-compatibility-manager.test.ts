import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Session } from "electron";
import { describe, expect, it, vi } from "vitest";

import {
  CdnCompatibilityManager,
  createDeclarativeNetRequestRules,
  rewriteCdnCompatibilityUrl
} from "../src/main/game-browser/CdnCompatibilityManager";
import { DEFAULT_GAME_BROWSER_SETTINGS } from "../src/shared/browserFonts";
import type { BrowserCdnCompatibilityMode, GameBrowserSettings } from "../src/shared/types";

const manifestTemplatePath = join(process.cwd(), "resources/cdn-compat-extension/manifest.json");

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
      "https://fonts.googleapis.cn/s/roboto/v1/font.woff2"
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
      "https://maxcdn.bootstrapcdn.com/bootstrap/5.3.3/css/bootstrap.min.css",
      "https://lib.baomitu.com/twitter-bootstrap/5.3.3/css/bootstrap.min.css"
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

  it("generates eight subresource-only Manifest V3 rules", () => {
    const rules = createDeclarativeNetRequestRules() as Array<{
      condition: { regexFilter: string; resourceTypes: string[] };
      id: number;
    }>;

    expect(rules).toHaveLength(8);
    expect(rules.map((rule) => rule.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(rules.every((rule) => !rule.condition.resourceTypes.includes("main_frame"))).toBe(true);
    expect(rules.every((rule) => !rule.condition.regexFilter.includes("(?:"))).toBe(true);
  });
});

describe("CdnCompatibilityManager", () => {
  it("enables auto mode only when Google fails and recaptcha.net succeeds", async () => {
    const session = createSession(async (url) => createResponse(url.includes("recaptcha.net")));
    const manager = createManager("auto");

    await expect(manager.applyToSession(session.value)).resolves.toBe(true);
    expect(session.fetch).toHaveBeenCalledTimes(2);
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

  it("leaves auto mode disabled when Google succeeds or the result is inconclusive", async () => {
    const googleAvailable = createSession(async () => createResponse(true));
    const unavailable = createSession(async () => createResponse(false));

    await expect(createManager("auto").applyToSession(googleAvailable.value)).resolves.toBe(false);
    await expect(createManager("auto").applyToSession(unavailable.value)).resolves.toBe(false);
    expect(googleAvailable.onBeforeRequest).toHaveBeenLastCalledWith(null);
    expect(unavailable.onBeforeRequest).toHaveBeenLastCalledWith(null);
  });

  it("times out inconclusive probes and caches results by proxy for ten minutes", async () => {
    let now = 1_000;
    const session = createSession(
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })
    );
    const manager = createManager("auto", { detectionTimeoutMs: 5, now: () => now });

    await expect(manager.applyToSession(session.value)).resolves.toBe(false);
    await expect(manager.applyToSession(session.value)).resolves.toBe(false);
    expect(session.fetch).toHaveBeenCalledTimes(2);

    now += 10 * 60 * 1_000 + 1;
    await expect(manager.applyToSession(session.value)).resolves.toBe(false);
    expect(session.fetch).toHaveBeenCalledTimes(4);
  });

  it("forces on without probing and keeps off fail-open", async () => {
    const onSession = createSession(async () => createResponse(false));
    const offSession = createSession(async () => createResponse(true));

    await expect(createManager("on").applyToSession(onSession.value)).resolves.toBe(true);
    await expect(createManager("off").applyToSession(offSession.value)).resolves.toBe(false);
    expect(onSession.fetch).not.toHaveBeenCalled();
    expect(offSession.fetch).not.toHaveBeenCalled();
  });

  it("writes a role-local extension atomically when compatibility is enabled", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "rion-cdn-extension-"));
    const browserUserDataDir = join(baseDir, "role-1", "browser");
    await mkdir(browserUserDataDir, { recursive: true });
    const session = createSession(async () => createResponse(false));

    const result = await createManager("on").prepareExternalExtension(session.value, browserUserDataDir);
    const manifest = JSON.parse(await readFile(join(result.extensionPath!, "manifest.json"), "utf8"));
    const generatedRules = JSON.parse(await readFile(join(result.extensionPath!, "rules.json"), "utf8"));

    expect(result).toMatchObject({ enabled: true, extensionPath: join(baseDir, "role-1", "cdn-compat-extension") });
    expect(manifest).toMatchObject({ manifest_version: 3, version: "1.0.0" });
    expect(manifest.host_permissions).toContain("https://www.google.com/*");
    expect(generatedRules).toHaveLength(8);
    await expect(readFile(join(result.extensionPath!, "rules.json.tmp"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });

    const disabled = await createManager("off").prepareExternalExtension(session.value, browserUserDataDir);
    expect(disabled).toEqual({ enabled: false });
    expect(JSON.parse(await readFile(join(result.extensionPath!, "rules.json"), "utf8"))).toEqual([]);
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
    extensionManifestTemplatePath: manifestTemplatePath,
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
