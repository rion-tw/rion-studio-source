import type { Session } from "electron";

import { normalizeGameBrowserSettings } from "../../shared/browserFonts";
import type { BrowserProxySettings, GameBrowserSettings } from "../../shared/types";
import rulesDocument from "./cdnCompatibilityRules.json";

const AUTO_DETECTION_TIMEOUT_MS = 1_500;
const AUTO_DETECTION_CACHE_MS = 10 * 60 * 1_000;
const GOOGLE_CANARY_URL = "https://www.google.com/recaptcha/api.js?render=explicit";

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
  getSettings: () => Promise<GameBrowserSettings>;
  now?: () => number;
}

export const CDN_COMPATIBILITY_EXTERNAL_NOTICE =
  "China CDN compatibility mode is active in external Chrome.";
export const CDN_COMPATIBILITY_UNAVAILABLE_NOTICE =
  "China CDN compatibility mode could not be prepared. The game opened with its original resource URLs.";

const rules = rulesDocument.rules as CdnCompatibilityRule[];
const requestFilter = {
  urls: [...new Set(rules.map((rule) => `https://${rule.sourceHost}/*`))]
};

export class CdnCompatibilityManager {
  private readonly cache = new Map<string, DetectionCacheEntry>();
  private readonly inFlightDetections = new Map<string, Promise<boolean>>();
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

  resolveForSession(session: Session): Promise<boolean> {
    return this.resolveEnabled(session);
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

    const inFlight = this.inFlightDetections.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    const detection = detectRestrictedGoogleAccess(session, this.detectionTimeoutMs)
      .then((enabled) => {
        this.cache.set(cacheKey, {
          enabled,
          expiresAt: this.now() + AUTO_DETECTION_CACHE_MS
        });
        return enabled;
      })
      .finally(() => {
        if (this.inFlightDetections.get(cacheKey) === detection) {
          this.inFlightDetections.delete(cacheKey);
        }
      });
    this.inFlightDetections.set(cacheKey, detection);
    return detection;
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

export function createCdnCompatibilityRequestPatterns(): Array<{
  requestStage: "Request";
  urlPattern: string;
}> {
  return requestFilter.urls.map((urlPattern) => ({ requestStage: "Request", urlPattern }));
}

async function detectRestrictedGoogleAccess(session: Session, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const googleAvailable = await canFetch(session, GOOGLE_CANARY_URL, controller.signal);
    return !googleAvailable;
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

function createDetectionCacheKey(proxy: BrowserProxySettings): string {
  return `${proxy.mode}:${proxy.server}`;
}

function convertRegexSubstitution(value: string): string {
  return value.replace(/\\([0-9])/g, "$$$1");
}
