import type {
  BrowserRuntimeFailureReason,
  ResolvedBrowserEngine,
  RoleStatus
} from "../../../shared/types";
import type { TranslationKey, Translator } from "../i18n";

const resolvedEngineLabelKeys: Record<ResolvedBrowserEngine, TranslationKey> = {
  chromium: "browserEngine.actual.chromium",
  webview2: "browserEngine.actual.webview2",
  wkwebview: "browserEngine.actual.wkwebview"
};

const engineIssueLabelKeys: Record<BrowserRuntimeFailureReason, TranslationKey> = {
  "trusted-input-unavailable": "browserEngine.issueReason.trustedInputUnavailable",
  "macro-input-unavailable": "browserEngine.issueReason.macroInputUnavailable",
  "session-migration-required": "browserEngine.issueReason.sessionMigrationRequired",
  "runtime-creation-failed": "browserEngine.issueReason.runtimeCreationFailed",
  "runtime-crashed": "browserEngine.issueReason.runtimeCrashed"
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
  if (!status.issueReason) {
    return t("browserEngine.actualTitle").replace("{engine}", resolved);
  }
  return t("browserEngine.issueTitle")
    .replace("{resolved}", resolved)
    .replace("{reason}", t(engineIssueLabelKeys[status.issueReason]));
}
