import type {
  EmbeddedBrowserEngine,
  EngineFallbackReason,
  ResolvedBrowserEngine,
  RoleStatus
} from "../../../shared/types";
import type { TranslationKey, Translator } from "../i18n";

const resolvedEngineLabelKeys: Record<ResolvedBrowserEngine, TranslationKey> = {
  webview2: "browserEngine.actual.webview2",
  wkwebview: "browserEngine.actual.wkwebview",
  electron: "browserEngine.actual.electron",
  "external-chrome": "browserEngine.actual.externalChrome"
};

const preferredEngineLabelKeys: Record<EmbeddedBrowserEngine, TranslationKey> = {
  system: "games.engine.system",
  electron: "games.engine.electron"
};

const fallbackReasonLabelKeys: Record<EngineFallbackReason, TranslationKey> = {
  "legacy-role-pin": "browserEngine.fallbackReason.legacyRolePin",
  "chrome-profile-session": "browserEngine.fallbackReason.chromeProfileSession",
  "mac-cdn-rewrite-unsupported": "browserEngine.fallbackReason.macCdnRewriteUnsupported",
  "webkit-spi-unavailable": "browserEngine.fallbackReason.webkitSpiUnavailable",
  "cached-compatibility-failure": "browserEngine.fallbackReason.cachedCompatibilityFailure",
  "runtime-creation-failed": "browserEngine.fallbackReason.runtimeCreationFailed",
  "runtime-crashed": "browserEngine.fallbackReason.runtimeCrashed",
  "auth-verification-failed": "browserEngine.fallbackReason.authVerificationFailed"
};

export function getResolvedBrowserEngineLabel(
  engine: ResolvedBrowserEngine,
  t: Translator
): string {
  return t(resolvedEngineLabelKeys[engine]);
}

export function getBrowserEngineStatusTitle(status: RoleStatus, t: Translator): string {
  if (!status.resolvedEngine) return "";
  const resolved = getResolvedBrowserEngineLabel(status.resolvedEngine, t);
  if (!status.fallbackReason || !status.preferredEngine) {
    return t("browserEngine.actualTitle").replace("{engine}", resolved);
  }
  return t("browserEngine.fallbackTitle")
    .replace("{preferred}", t(preferredEngineLabelKeys[status.preferredEngine]))
    .replace("{resolved}", resolved)
    .replace("{reason}", t(fallbackReasonLabelKeys[status.fallbackReason]));
}
