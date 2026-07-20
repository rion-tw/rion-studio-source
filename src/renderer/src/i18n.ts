import { MACRO_DELAY_MAX_MS } from "../../shared/macroSettings";
import type { AppLanguage } from "../../shared/types";
import en from "./i18n/en.json";

export type Language = AppLanguage;
export type TranslationKey = keyof typeof en;
export type Translator = (key: TranslationKey) => string;
export type TranslationDictionary = Record<TranslationKey, string>;

export const languages: Language[] = ["en", "zh-TW", "zh-CN", "ja"];

const fallbackTranslations = en as TranslationDictionary;
const loadedTranslations: Partial<Record<Language, TranslationDictionary>> = {
  en: fallbackTranslations
};

const translationLoaders: Record<Language, () => Promise<TranslationDictionary>> = {
  en: async () => fallbackTranslations,
  "zh-TW": async () => ((await import("./i18n/zh-TW.json")).default as TranslationDictionary),
  "zh-CN": async () => ((await import("./i18n/zh-CN.json")).default as TranslationDictionary),
  ja: async () => ((await import("./i18n/ja.json")).default as TranslationDictionary)
};

const knownErrorMessages: Partial<Record<string, TranslationKey>> = {
  "Rion Studio preload bridge is unavailable. Restart the app after rebuilding.": "error.preloadBridgeUnavailable",
  "Role not found.": "error.roleNotFound",
  "Role data file is invalid.": "error.roleDataInvalid",
  "Role order is invalid.": "error.roleOrderInvalid",
  "Role name is required.": "error.roleNameRequired",
  "Role name must be 80 characters or fewer.": "error.roleNameTooLong",
  "Launch game must use a valid HTTP or HTTPS URL.": "error.roleLaunchUrlInvalid",
  "Launch URL must be a valid HTTP or HTTPS URL.": "error.roleLaunchUrlInvalid",
  "Launch preset is invalid.": "error.rolePresetInvalid",
  "Role cover image must be a valid image data URL.": "error.roleCoverInvalid",
  "Role cover image must be an image file.": "error.roleCoverFileInvalid",
  "Role cover image is too large.": "error.roleCoverTooLarge",
  "Unable to process role cover image.": "error.roleCoverProcessFailed",
  "Role cover dominant color must be a valid hex color.": "error.roleCoverColorInvalid",
  "Some saved browser data could not be cleared.": "error.roleBrowserDataClearFailed",
  "A role with this name already exists.": "error.roleNameDuplicate",
  "Game not found.": "error.gameNotFound",
  "Game data file is invalid.": "error.gameDataInvalid",
  "Game name is required.": "error.gameNameRequired",
  "Game name must be 80 characters or fewer.": "error.gameNameTooLong",
  "A game with this name already exists.": "error.gameNameDuplicate",
  "Game URL must use HTTP or HTTPS.": "error.gameUrlInvalid",
  "Game icon must be a valid image data URL.": "error.gameIconInvalid",
  "Game icon must be an image up to 1.5 MB.": "error.gameIconFileInvalid",
  "Unable to process game icon.": "error.gameIconProcessFailed",
  "Game cover must be a valid image data URL up to 1.5 MB.": "error.gameCoverInvalid",
  "Game cover must be a PNG, JPEG, WebP, or GIF image up to 8 MB.": "error.gameCoverFileInvalid",
  "Unable to process game cover.": "error.gameCoverProcessFailed",
  "Game cover is too large after processing.": "error.gameCoverTooLarge",
  "Game browser launch mode is invalid.": "error.gameLaunchModeInvalid",
  "Built-in game name cannot be changed.": "error.gameBuiltinProtected",
  "Built-in game icon cannot be changed.": "error.gameBuiltinProtected",
  "Built-in game cover cannot be changed.": "error.gameBuiltinProtected",
  "Only built-in games can be reset.": "error.gameNotBuiltin",
  "Built-in games cannot be deleted.": "error.gameBuiltinDeleteForbidden",
  "Move or delete assigned roles before deleting this game.": "error.gameInUse",
  "A compatibility check is already running for this game.": "error.gameCompatibilityRunning",
  "Launch workspace not found.": "error.workspaceNotFound",
  "Launch workspace data file is invalid.": "error.workspaceDataInvalid",
  "Launch workspace order is invalid.": "error.workspaceOrderInvalid",
  "Launch workspace name is required.": "error.workspaceNameRequired",
  "Launch workspace name must be 80 characters or fewer.": "error.workspaceNameTooLong",
  "Launch workspace layout is invalid.": "error.workspaceTemplateInvalid",
  "Launch workspace browser zoom is invalid.": "error.workspaceBrowserZoomInvalid",
  "Launch workspace target display is invalid.": "error.workspaceTargetDisplayInvalid",
  "Launch workspace display selection is invalid.": "error.workspaceDisplaySelectionInvalid",
  "Launch workspace role is outside the selected layout.": "error.workspaceSlotOutsideLayout",
  "Launch workspace can contain at most 9 slots.": "error.workspaceTooManySlots",
  "A role can only appear once in a launch workspace.": "error.workspaceRoleDuplicate",
  "Launch workspace slot rectangle is invalid.": "error.workspaceRectInvalid",
  "A launch workspace with this name already exists.": "error.workspaceNameDuplicate",
  "Macro not found.": "error.macroNotFound",
  "Macro data file is invalid.": "error.macroDataInvalid",
  "Macro name is required.": "error.macroNameRequired",
  "Macro name must be 80 characters or fewer.": "error.macroNameTooLong",
  "Macro role assignment is invalid.": "error.macroRoleIdInvalid",
  "Macro shortcut key is invalid.": "error.macroShortcutInvalid",
  "Macro repeat setting is invalid.": "error.macroRepeatInvalid",
  "Macro activation mode is invalid.": "error.macroActivationModeInvalid",
  "A tap-or-hold macro requires a shortcut.": "error.macroHoldShortcutRequired",
  [`Macro interval must be between 0 and ${MACRO_DELAY_MAX_MS} ms.`]: "error.macroIntervalInvalid",
  "Macro must contain at least one step.": "error.macroStepsRequired",
  "Macro can contain at most 100 steps.": "error.macroStepsTooMany",
  "Macro key step is invalid.": "error.macroKeyStepInvalid",
  "Macro call mode is invalid.": "error.macroCallModeInvalid",
  "Macro key action is invalid.": "error.macroKeyActionInvalid",
  "Macro key modifiers are invalid.": "error.macroKeyModifiersInvalid",
  "Primary cannot be combined with Ctrl or Meta.": "error.macroKeyPrimaryConflict",
  "A key combination requires a non-modifier main key.": "error.macroKeyCombinationInvalid",
  "Macro click anchor is invalid.": "error.macroClickAnchorInvalid",
  "Macro click X offset must be between -100 and 100.": "error.macroClickXInvalid",
  "Macro click Y offset must be between -100 and 100.": "error.macroClickYInvalid",
  "Macro click X offset must be a safe pixel integer.": "error.macroClickXPxInvalid",
  "Macro click Y offset must be a safe pixel integer.": "error.macroClickYPxInvalid",
  [`Macro delay must be between 0 and ${MACRO_DELAY_MAX_MS} ms.`]: "error.macroDelayInvalid",
  "Macro step is invalid.": "error.macroStepInvalid",
  "Macro step target is invalid.": "error.macroStepTargetInvalid",
  "Macro step target was not found.": "error.macroStepTargetNotFound",
  "Macro step target cannot hold a key until stopped.": "error.macroStepTargetHoldsKey",
  "Macro dependency cycle detected while running a called macro.": "error.macroDependencyCycle",
  "Cancelled because a called macro was stopped.": "error.macroChildStopped",
  "Imported macro dependencies are invalid.": "error.portableMacroDependencyInvalid",
  "Macro enabled state is invalid.": "error.macroEnabledInvalid",
  "A macro with this name already exists.": "error.macroNameDuplicate",
  "Portable data export is not available.": "error.portableUnavailable",
  "Portable data import is not available.": "error.portableUnavailable",
  "Portable data file is invalid.": "error.portableDataInvalid",
  "Portable import session expired. Choose the JSON file again.": "error.portableImportExpired",
  "Resolve every ambiguous macro before importing.": "error.portableImportConflictUnresolved",
  "Stop affected macros before importing.": "error.portableImportBusy",
  "Portable import conflict resolution is invalid.": "error.portableImportResolutionInvalid",
  "Portable data selection is invalid.": "error.portableSelectionInvalid",
  "Select at least one available data category.": "error.portableSelectionEmpty",
  "Unable to create a unique imported name.": "error.portableNameConflict",
  "Multiple roles share a name in the same game. Rename or remove duplicates before importing.":
    "error.portableRoleNameConflict",
  "Chrome profile import is supported on macOS and Windows only.": "error.chromeProfileImportUnsupported",
  "Selected Chrome data path is not a folder.": "error.chromeProfileImportSourceInvalid",
  "Selected Chrome data folder does not exist.": "error.chromeProfileImportSourceMissing",
  "Chrome is still using the selected profile. Quit Chrome and try again.": "error.chromeProfileImportChromeRunning",
  "Unable to ask Google Chrome to close. Close Chrome manually and try again.": "error.chromeProfileImportCloseFailed",
  "No Chrome profiles were found in the selected folder.": "error.chromeProfileImportProfilesMissing",
  "Consent is required before importing Chrome profile data.": "error.chromeProfileImportConsentRequired",
  "Chrome profile import preview expired. Choose the folder again.": "error.chromeProfileImportExpired",
  "Select at least one Chrome profile to import.": "error.chromeProfileImportSelectionEmpty",
  "Chrome profile contains an unsupported symbolic link.": "error.chromeProfileImportProfileInvalid",
  "Chrome profile import is not available.": "error.chromeProfileImportUnavailable",
  "Chrome profile import input is invalid.": "error.chromeProfileImportInputInvalid",
  "Chrome profile import id is invalid.": "error.chromeProfileImportIdInvalid",
  "Multiple Chrome profiles or roles share a name in the selected game. Rename or remove duplicates before importing.":
    "error.chromeProfileImportRoleNameConflict",
  "Macro is already running for this role.": "error.macroAlreadyRunning",
  "Enable this macro before running it.": "error.macroDisabled",
  "Stop the macro before editing it.": "error.macroStopBeforeEditing",
  "Ctrl+Shift+M is reserved for the macro overlay.": "error.macroShortcutReserved",
  "Browser zoom shortcuts are reserved for the active game role.": "error.macroBrowserZoomShortcutReserved",
  "Macro shortcut conflicts with another macro assigned to the same role.": "error.macroShortcutConflict",
  "This macro is not assigned to the current role.": "error.macroNotAssigned",
  "Macro is not assigned to this role.": "error.macroNotAssigned",
  "Launch this role before running a macro.": "error.macroRoleNotRunning",
  "Launch at least one assigned role before running a macro.": "error.macroNoRunnableRoles",
  "Assign a role to this macro and every called macro before running it.":
    "error.macroUnassignedWorkflow",
  "Macro control is unavailable for this compatibility-mode session. Restart the role and try again.":
    "error.macroExternalRuntimeUnsupported",
  "Macro control could not connect to compatibility mode. Restart this role to try again.":
    "notice.externalMacroUnavailable",
  "Workspace zoom could not be applied in external Chrome. Restart this role to try again.":
    "notice.externalZoomUnavailable",
  "Launch workspace has no roles.": "error.workspaceEmpty",
  "Login required. Use Login before launching every role in this workspace.": "error.workspaceLoginRequired",
  "Login required. Use Login before launching this role.": "error.loginRequired",
  "Google Chrome was not found. Install Chrome or set RION_STUDIO_CHROME_PATH to the Chrome executable.":
    "error.chromeNotFound",
  "Chrome is still using this role's browser data. Quit the Chrome login window and try again.":
    "error.browserUserDataLockTimeout",
  "Unable to start the hidden Rion Studio browser helper.": "error.hiddenBrowserHelperUnavailable",
  "Unable to load the game page. If you use a game accelerator, enable global, TUN, or system proxy mode, or set a local proxy in Game settings.":
    "error.gamePageLoadFailed",
  "Embedded game view failed to load. Rion Studio switched to external Chrome compatibility mode for accelerator support.":
    "notice.externalChromeFallback",
  "China CDN compatibility mode is active in external Chrome.":
    "notice.cdnCompatibilityExternalActive",
  "China CDN compatibility mode could not be prepared. The game opened with its original resource URLs.":
    "notice.cdnCompatibilityUnavailable",
  "Unable to check login session.": "error.unableCheckSession",
  "Google rejected this browser during session check.": "error.googleRejected",
  "Login is still required.": "error.loginStillRequired",
  "Login is still required. No persisted login session was found.": "error.noPersistedLoginSession",
  "Login failed.": "error.loginFailedSentence"
};

export function createTranslator(
  _language: Language,
  translations: TranslationDictionary = fallbackTranslations
): Translator {
  return (key) => translations[key] ?? fallbackTranslations[key] ?? key;
}

export function getLoadedTranslations(language: Language): TranslationDictionary | undefined {
  return loadedTranslations[language];
}

export async function loadTranslations(language: Language): Promise<TranslationDictionary> {
  const cachedTranslations = getLoadedTranslations(language);
  if (cachedTranslations) {
    return cachedTranslations;
  }

  const translations = await translationLoaders[language]();
  loadedTranslations[language] = translations;
  return translations;
}

export function detectSystemLanguage(): Language {
  if (typeof navigator === "undefined") {
    return "en";
  }

  const locales = navigator.languages.length > 0 ? navigator.languages : [navigator.language];
  return resolvePreferredLanguage(locales);
}

export function resolvePreferredLanguage(locales: readonly string[]): Language {
  for (const locale of locales) {
    if (isTraditionalChineseLocale(locale)) {
      return "zh-TW";
    }

    if (isSimplifiedChineseLocale(locale)) {
      return "zh-CN";
    }

    if (isJapaneseLocale(locale)) {
      return "ja";
    }
  }

  return "en";
}

export function readStoredLanguage(storageKey: string): Language {
  const storedLanguage = localStorage.getItem(storageKey);
  return isLanguage(storedLanguage) ? storedLanguage : detectSystemLanguage();
}

export function isLanguage(value: string | null): value is Language {
  return value !== null && languages.includes(value as Language);
}

export function localizeErrorMessage(message: string, language: Language): string {
  const translations = getLoadedTranslations(language) ?? fallbackTranslations;
  const alreadyRunningMatch = /^Already running in another game window: (.+)\.$/.exec(message);
  if (alreadyRunningMatch) {
    const template = translations["error.rolesAlreadyRunning"] ?? fallbackTranslations["error.rolesAlreadyRunning"];
    return template.replace("{names}", alreadyRunningMatch[1]);
  }

  const dynamicMacroErrors: Array<[RegExp, TranslationKey, string]> = [
    [/^Macro is used by: (.+)\.$/, "error.macroInUse", "{names}"],
    [/^Macro dependency cycle: (.+)\.$/, "error.macroDependencyCycleNames", "{names}"],
    [/^Called macro "(.+)" is already running\.$/, "error.macroChildAlreadyRunning", "{name}"]
  ];
  for (const [pattern, key, placeholder] of dynamicMacroErrors) {
    const match = pattern.exec(message);
    if (match) {
      return (translations[key] ?? fallbackTranslations[key]).replace(placeholder, match[1]);
    }
  }

  const key = knownErrorMessages[message];
  if (key) {
    return translations[key] ?? fallbackTranslations[key] ?? message;
  }

  let localizedMessage = message;
  let localizedNotice = false;
  Object.entries(knownErrorMessages).forEach(([knownMessage, translationKey]) => {
    if (!translationKey?.startsWith("notice.") || !localizedMessage.includes(knownMessage)) {
      return;
    }
    const translatedNotice = translations[translationKey] ?? fallbackTranslations[translationKey];
    localizedMessage = localizedMessage.split(knownMessage).join(translatedNotice);
    localizedNotice = true;
  });
  return localizedNotice ? localizedMessage : message;
}

function isTraditionalChineseLocale(locale: string): boolean {
  const normalized = locale.toLowerCase();

  return (
    normalized === "zh-hant" ||
    normalized.startsWith("zh-hant-") ||
    normalized === "zh-tw" ||
    normalized.startsWith("zh-tw-") ||
    normalized === "zh-hk" ||
    normalized.startsWith("zh-hk-") ||
    normalized === "zh-mo" ||
    normalized.startsWith("zh-mo-")
  );
}

function isSimplifiedChineseLocale(locale: string): boolean {
  const normalized = locale.toLowerCase();

  return (
    normalized === "zh" ||
    normalized === "zh-hans" ||
    normalized.startsWith("zh-hans-") ||
    normalized === "zh-cn" ||
    normalized.startsWith("zh-cn-") ||
    normalized === "zh-sg" ||
    normalized.startsWith("zh-sg-")
  );
}

function isJapaneseLocale(locale: string): boolean {
  const normalized = locale.toLowerCase();

  return normalized === "ja" || normalized.startsWith("ja-");
}
