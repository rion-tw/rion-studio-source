import { localizeErrorMessage, type Language, type TranslationKey, type Translator } from "../i18n";

export function toMessage(error: unknown, language: Language, t: Translator): string {
  if (isSessionMigrationRequired(error)) return t("recovery.launchBlocked");
  if (isErrorLike(error)) {
    const errorKey = localizedErrorKey(error.code);
    if (errorKey) return t(errorKey);
    // The native updater bridge uses its stable code as the message.
    if (typeof error.code === "string" && error.code.startsWith("UPDATE_")) {
      return t(updateErrorReasonKey(error.code));
    }
    return localizeErrorMessage(error.message, language);
  }

  if (typeof error === "string") {
    return localizeErrorMessage(error, language);
  }

  return t("error.unexpected");
}

const updateErrorReasons: ReadonlyArray<readonly [readonly string[], TranslationKey]> = [
  [["UPDATE_NETWORK_", "UPDATE_TRANSPORT_"], "settings.updateErrorNetwork"],
  [
    ["UPDATE_MANIFEST_", "UPDATE_SIGNATURE_", "UPDATE_ARTIFACT_", "UPDATE_VERIFICATION_", "UPDATE_PENDING_"],
    "settings.updateErrorInvalid"
  ],
  [["UPDATE_INSTALL_", "UPDATE_PLATFORM_INSTALL_", "UPDATE_RELAUNCH_"], "settings.updateErrorInstall"]
];

/**
 * Groups a stable rion-updater code into a localized reason. The exact code
 * stays in the operational log, not in user-facing text.
 */
export function updateErrorReasonKey(code: string | null | undefined): TranslationKey {
  if (code) {
    for (const [prefixes, key] of updateErrorReasons) {
      if (prefixes.some((prefix) => code.startsWith(prefix))) return key;
    }
  }
  return "settings.updateErrorUnknown";
}

export function isSessionMigrationRequired(error: unknown): boolean {
  // contextBridge may copy Error across realms without enumerable properties.
  // Read the message structurally; instanceof/JSON.stringify can lose it.
  const message = typeof error === "string" ? error : isErrorLike(error) ? error.message : "";
  return /\b(?:SessionMigrationRequired|sessionMigrationRequired|session-migration-required)\b/u.test(message);
}

export function isPersistentRuntimeError(error: unknown): boolean {
  if (typeof error === "string") {
    return isSurfaceReleaseMessage(error);
  }
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const payload = error as { code?: unknown; message?: unknown };
  return (
    payload.code === "SYSTEM_SURFACE_RELEASE_UNVERIFIED" ||
    (typeof payload.message === "string" && isSurfaceReleaseMessage(payload.message))
  );
}

function isSurfaceReleaseMessage(message: string): boolean {
  return (
    (message.startsWith("Rion Studio could not verify that ") ||
      message.startsWith("Rion Studio still cannot verify that ")) &&
    message.includes("native game page")
  );
}

function localizedErrorKey(code: unknown) {
  const keys = {
    // Font failures carry transport/filesystem detail; it belongs in logs only.
    BROWSER_FONT_CACHE_FAILED: "error.browserFontCacheFailed",
    BROWSER_FONT_CACHE_INVALID: "error.browserFontCacheInvalid",
    BROWSER_FONT_DOWNLOAD_FAILED: "error.browserFontDownloadFailed",
    BROWSER_FONT_NOT_FOUND: "error.browserFontNotFound",
    // Core's Chrome profile import uses these unprefixed codes exclusively.
    CHROME_RUNNING: "error.chromeImportChromeRunning",
    IMPORT_NOT_FOUND: "error.chromeImportExpired",
    PROFILE_INVALID: "error.chromeImportProfileInvalid",
    SOURCE_INVALID: "error.chromeImportSourceInvalid",
    ELECTRON_CHROMIUM_SAVED_WINDOW_RESTORE_UNSUPPORTED: "error.savedWindowLaunchRequiresShow",
    GAME_WINDOW_LIMIT_REACHED: "error.gameWindowLimitReached",
    GAME_WINDOW_NAME_DUPLICATE: "error.gameWindowNameDuplicate",
    GAME_WINDOW_NAME_REQUIRED: "error.gameWindowNameRequired",
    GAME_WINDOW_NAME_TOO_LONG: "error.gameWindowNameTooLong",
    MACRO_SOURCE_ROLE_REQUIRED: "macros.sourcePicker.description",
    MACRO_SOURCE_ROLE_UNAVAILABLE: "macros.sourcePicker.empty",
    MACRO_SOURCE_SCOPE_INVALID: "macroForm.execution.sourceDescription",
    MACRO_ROLE_STOPPING: "error.macroRoleStopping",
    MACRO_ROLE_INPUT_FENCED: "error.macroRoleInputFenced",
    MACRO_ROLE_INPUT_RECOVERING: "error.macroRoleInputRecovering",
    MACRO_ROLE_INPUT_RESTART_REQUIRED: "error.macroRoleInputRestartRequired",
    MACRO_RUNTIME_NOT_ACTIVE: "error.macroRuntimeNotActive",
    MACRO_INPUT_WAKE_FAILED: "error.macroInputWakeFailed",
    MACRO_INPUT_WAKE_INDETERMINATE: "error.macroInputWakeIndeterminate",
    PORTABLE_IMPORT_GAME_WINDOWS_RUNNING: "error.portableImportGameWindowsRunning",
    PORTABLE_IMPORT_ROLES_RUNNING: "error.portableImportRolesRunning",
    PORTABLE_IMPORT_STATE_CHANGED: "error.portableImportStateChanged",
    SYSTEM_TRUSTED_INPUT_RECOVERING: "error.trustedInputRecovering",
    WORKSPACE_CONTENT_REQUIRED: "error.workspaceEmpty"
  } as const;
  return typeof code === "string" ? keys[code as keyof typeof keys] : undefined;
}

function isErrorLike(error: unknown): error is { code?: unknown; message: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  );
}
