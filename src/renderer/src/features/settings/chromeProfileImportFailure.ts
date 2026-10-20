import type { TranslationKey, Translator } from "../../i18n";

const failureReasonKeys: Record<string, TranslationKey> = {
  CHROME_RUNNING: "settings.chromeImportErrorChromeRunning",
  CORE_PLATFORM_FAILED: "settings.chromeImportErrorPlatform",
  PROFILE_SESSION_EMPTY: "settings.chromeImportErrorSessionEmpty",
  ROLE_ALREADY_RUNNING: "settings.chromeImportErrorRoleInUse",
  ROLE_BROWSER_DATA_IN_USE: "settings.chromeImportErrorRoleInUse",
  ROLE_CONFLICT_RESOLUTION_REQUIRED: "settings.chromeImportErrorConflict",
  ROLE_MUTATION_BLOCKED: "settings.chromeImportErrorRoleBusy",
  ROLE_TARGET_INVALID: "settings.chromeImportErrorTargetMissing",
  SOURCE_CHANGED: "settings.chromeImportErrorSourceChanged"
};

/**
 * Explains why one Chrome profile failed to import. Unknown Core codes keep
 * the raw code visible so diagnostics can identify the failing step.
 */
export function chromeImportFailureReason(errorCode: string | undefined, t: Translator): string | null {
  if (!errorCode) return null;
  const key = Object.hasOwn(failureReasonKeys, errorCode) ? failureReasonKeys[errorCode] : undefined;
  return key ? t(key) : t("settings.chromeImportErrorUnknown").replace("{code}", () => errorCode);
}
