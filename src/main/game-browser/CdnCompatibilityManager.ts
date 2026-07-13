import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Session } from "electron";

import { normalizeGameBrowserSettings } from "../../shared/browserFonts";
import type { BrowserProxySettings, GameBrowserSettings } from "../../shared/types";
import rulesDocument from "./cdnCompatibilityRules.json";

const AUTO_DETECTION_TIMEOUT_MS = 1_500;
const AUTO_DETECTION_CACHE_MS = 10 * 60 * 1_000;
const GOOGLE_CANARY_URL = "https://www.google.com/recaptcha/api.js?render=explicit";
const RECAPTCHA_CANARY_URL = "https://www.recaptcha.net/recaptcha/api.js?render=explicit";

interface CdnCompatibilityRule {
  id: string;
  regexFilter: string;
  regexSubstitution: string;
  sourceHost: string;
}

interface DetectionCacheEntry {
  enabled: boolean;
  expiresAt: number;
}

export interface CdnCompatibilityManagerOptions {
  detectionTimeoutMs?: number;
  extensionManifestTemplatePath: string;
  getSettings: () => Promise<GameBrowserSettings>;
  now?: () => number;
}

export interface ExternalCdnCompatibilityResult {
  extensionPath?: string;
  enabled: boolean;
}

export const CDN_COMPATIBILITY_EXTERNAL_NOTICE =
  "China CDN compatibility mode is active in external Chrome. Chrome may show a developer extension warning.";
export const CDN_COMPATIBILITY_UNAVAILABLE_NOTICE =
  "China CDN compatibility mode could not be prepared. The game opened with its original resource URLs.";

const rules = rulesDocument.rules as CdnCompatibilityRule[];
const requestFilter = {
  urls: [...new Set(rules.map((rule) => `https://${rule.sourceHost}/*`))]
};

export class CdnCompatibilityManager {
  private readonly cache = new Map<string, DetectionCacheEntry>();
  private readonly detectionTimeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly options: CdnCompatibilityManagerOptions) {
    this.detectionTimeoutMs = options.detectionTimeoutMs ?? AUTO_DETECTION_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
  }

  async applyToSession(session: Session): Promise<boolean> {
    session.webRequest.onBeforeRequest(null);
    const enabled = await this.resolveEnabled(session);

    if (!enabled) {
      return false;
    }

    session.webRequest.onBeforeRequest(requestFilter, (details, callback) => {
      const redirectURL =
        details.resourceType === "mainFrame" ? undefined : rewriteCdnCompatibilityUrl(details.url);
      callback(redirectURL ? { redirectURL } : {});
    });
    return true;
  }

  async prepareExternalExtension(session: Session, browserUserDataDir: string): Promise<ExternalCdnCompatibilityResult> {
    const enabled = await this.resolveEnabled(session);
    if (!enabled) {
      await disableExistingExternalExtension(browserUserDataDir);
      return { enabled: false };
    }

    return {
      enabled: true,
      extensionPath: await writeExternalExtension(
        browserUserDataDir,
        this.options.extensionManifestTemplatePath
      )
    };
  }

  private async resolveEnabled(session: Session): Promise<boolean> {
    const settings = normalizeGameBrowserSettings(await this.options.getSettings());
    const mode = settings.network.cdnCompatibility.mode;
    if (mode === "off") {
      return false;
    }
    if (mode === "on") {
      return true;
    }

    const cacheKey = createDetectionCacheKey(settings.network.proxy);
    const cached = this.cache.get(cacheKey);
    const now = this.now();
    if (cached && cached.expiresAt > now) {
      return cached.enabled;
    }

    const enabled = await detectRestrictedGoogleAccess(session, this.detectionTimeoutMs);
    this.cache.set(cacheKey, { enabled, expiresAt: now + AUTO_DETECTION_CACHE_MS });
    return enabled;
  }
}

export function rewriteCdnCompatibilityUrl(url: string): string | undefined {
  for (const rule of rules) {
    const matcher = new RegExp(rule.regexFilter);
    if (matcher.test(url)) {
      return url.replace(matcher, convertRegexSubstitution(rule.regexSubstitution));
    }
  }
  return undefined;
}

export function createDeclarativeNetRequestRules(): unknown[] {
  return rules.map((rule, index) => ({
    id: index + 1,
    priority: 1,
    action: {
      type: "redirect",
      redirect: { regexSubstitution: rule.regexSubstitution }
    },
    condition: {
      regexFilter: rule.regexFilter,
      resourceTypes: [
        "csp_report",
        "font",
        "image",
        "media",
        "object",
        "other",
        "ping",
        "script",
        "stylesheet",
        "sub_frame",
        "webbundle",
        "websocket",
        "xmlhttprequest"
      ]
    }
  }));
}

async function detectRestrictedGoogleAccess(session: Session, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const [googleAvailable, recaptchaAvailable] = await Promise.all([
      canFetch(session, GOOGLE_CANARY_URL, controller.signal),
      canFetch(session, RECAPTCHA_CANARY_URL, controller.signal)
    ]);
    return !googleAvailable && recaptchaAvailable;
  } finally {
    clearTimeout(timeout);
  }
}

async function canFetch(session: Session, url: string, signal: AbortSignal): Promise<boolean> {
  try {
    const response = await session.fetch(url, {
      cache: "no-store",
      credentials: "omit",
      signal
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function writeExternalExtension(browserUserDataDir: string, manifestTemplatePath: string): Promise<string> {
  const extensionPath = join(dirname(browserUserDataDir), "cdn-compat-extension");
  await mkdir(extensionPath, { recursive: true });

  const manifestTemplate = JSON.parse(await readFile(manifestTemplatePath, "utf8")) as Record<string, unknown>;
  const manifest = {
    ...manifestTemplate,
    version: `${rulesDocument.version}.0.0`,
    host_permissions: [...new Set(rules.map((rule) => `https://${rule.sourceHost}/*`))]
  };

  await Promise.all([
    writeJsonAtomically(join(extensionPath, "manifest.json"), manifest),
    writeJsonAtomically(join(extensionPath, "rules.json"), createDeclarativeNetRequestRules())
  ]);
  return extensionPath;
}

async function disableExistingExternalExtension(browserUserDataDir: string): Promise<void> {
  const rulesPath = join(dirname(browserUserDataDir), "cdn-compat-extension", "rules.json");
  try {
    await access(rulesPath);
    await writeJsonAtomically(rulesPath, []);
  } catch {
    // The extension has not been generated yet, or cannot be updated. Either case is fail-open.
  }
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

function createDetectionCacheKey(proxy: BrowserProxySettings): string {
  return `${proxy.mode}:${proxy.server}`;
}

function convertRegexSubstitution(value: string): string {
  return value.replace(/\\([0-9])/g, "$$$1");
}
