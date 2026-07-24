import type { Session } from "electron";

import type {
  CdnResolutionRecord,
  CdnRule,
  CoreEffectRequest,
  CoreJsonValue
} from "../../shared/generated";
import type { AppCoreClient } from "../core/nativeCore";
import {
  ElectronHandleRegistry,
  type CdnCoreEffectAction,
  type ElectronEffectHandle,
  type ElectronSessionEffectHandle
} from "../core/ElectronEffectExecutor";

export const CDN_COMPATIBILITY_EXTERNAL_NOTICE =
  "China CDN compatibility mode is active in external Chrome.";
export const CDN_COMPATIBILITY_UNAVAILABLE_NOTICE =
  "China CDN compatibility mode could not be prepared. The game opened with its original resource URLs.";

export type CdnCoreEffect = CoreEffectRequest & {
  action: CdnCoreEffectAction;
};

export interface CdnCompatibilityManagerOptions {
  core: Pick<AppCoreClient, "invoke">;
  createDeadlineSignal?: (deadlineMs: number) => AbortSignal;
  handles: ElectronHandleRegistry;
  recordPlan?: () => void;
}

/**
 * Electron session adapter for the Rust-owned CDN policy. Rust owns settings,
 * cache keys, TTL, in-flight deduplication, probe deadlines, and request rules.
 */
export class CdnCompatibilityManager {
  private nextSessionHandleId = 1;

  constructor(private readonly options: CdnCompatibilityManagerOptions) {}

  async applyToSession(session: Session): Promise<boolean> {
    session.webRequest.onBeforeRequest(null);
    const resolution = await this.resolve(session);
    if (!resolution.enabled) return false;
    const matchCdnUrl = createLocalCdnMatcher(resolution.rewriteRules);
    this.options.recordPlan?.();

    session.webRequest.onBeforeRequest(
      { urls: resolution.requestPatterns },
      (details, callback) => {
        const redirectURL = details.resourceType === "mainFrame"
          ? undefined
          : matchCdnUrl(details.url);
        callback(redirectURL ? { redirectURL } : {});
      }
    );
    return true;
  }

  async resolveForSession(session: Session): Promise<boolean> {
    return (await this.resolve(session)).enabled;
  }

  async executeEffect(effect: CdnCoreEffect): Promise<CoreJsonValue> {
    const session = requireFetchSession(this.options.handles.require(effect.target.handleId));
    const createDeadlineSignal =
      this.options.createDeadlineSignal ?? ((deadlineMs) => AbortSignal.timeout(deadlineMs));
    const response = await session.fetch(effect.action.url, {
      cache: "no-store",
      credentials: "omit",
      signal: createDeadlineSignal(Math.max(1, effect.deadlineMs))
    });
    return { available: response.ok };
  }

  private async resolve(session: Session): Promise<CdnResolutionRecord> {
    const handleId = `cdn-session-${this.nextSessionHandleId++}`;
    this.options.handles.register(handleId, session as unknown as ElectronEffectHandle);
    try {
      return await this.options.core.invoke({
        type: "cdnResolveSession",
        sessionHandleId: handleId
      });
    } finally {
      this.options.handles.unregister(handleId);
    }
  }
}

interface CompiledCdnRule {
  matcher: RegExp;
  sourceHost: string;
  substitution: string;
}

function createLocalCdnMatcher(rules: CdnRule[]): (url: string) => string | undefined {
  const compiledRules: CompiledCdnRule[] = rules.map((rule) => ({
    matcher: new RegExp(rule.regexFilter),
    sourceHost: rule.sourceHost.toLowerCase(),
    substitution: rule.regexSubstitution.replace(
      /\\([0-9]+)/g,
      (_match, index: string) => `$${index}`
    )
  }));
  return (url) => {
    let host: string;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return undefined;
    }
    for (const rule of compiledRules) {
      if (host !== rule.sourceHost || !rule.matcher.test(url)) continue;
      const rewritten = url.replace(rule.matcher, rule.substitution);
      if (rewritten !== url) return rewritten;
    }
    return undefined;
  };
}

function requireFetchSession(
  handle: ElectronEffectHandle
): ElectronSessionEffectHandle & Pick<Session, "fetch"> {
  if (!("fetch" in handle) || typeof handle.fetch !== "function") {
    throw Object.assign(new Error("The CDN effect target is not an Electron session."), {
      code: "ELECTRON_EFFECT_TARGET_TYPE"
    });
  }
  return handle as ElectronSessionEffectHandle & Pick<Session, "fetch">;
}
