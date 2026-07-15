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
  "windowWidth must be between 640 and 7680.": "error.roleWindowWidthInvalid",
  "windowHeight must be between 640 and 7680.": "error.roleWindowHeightInvalid",
  "Launch preset is invalid.": "error.rolePresetInvalid",
  "Role cover image must be a valid image data URL.": "error.roleCoverInvalid",
  "Role cover image must be an image file.": "error.roleCoverFileInvalid",
  "Role cover image is too large.": "error.roleCoverTooLarge",
  "Unable to process role cover image.": "error.roleCoverProcessFailed",
  "Role cover dominant color must be a valid hex color.": "error.roleCoverColorInvalid",
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
  "Game role defaults are invalid.": "error.gameRoleDefaultsInvalid",
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
  "Launch workspace can contain at most 8 slots.": "error.workspaceTooManySlots",
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
  "Macro interval must be between 1 and 600000 ms.": "error.macroIntervalInvalid",
  "Macro must contain at least one step.": "error.macroStepsRequired",
  "Macro can contain at most 100 steps.": "error.macroStepsTooMany",
  "Macro key step is invalid.": "error.macroKeyStepInvalid",
  "Macro click X must be between 0 and 100.": "error.macroClickXInvalid",
  "Macro click Y must be between 0 and 100.": "error.macroClickYInvalid",
  "Macro delay must be between 0 and 600000 ms.": "error.macroDelayInvalid",
  "Macro step is invalid.": "error.macroStepInvalid",
  "A macro with this name already exists.": "error.macroNameDuplicate",
  "Portable data export is not available.": "error.portableUnavailable",
  "Portable data import is not available.": "error.portableUnavailable",
  "Portable data file is invalid.": "error.portableDataInvalid",
  "Portable import session expired. Choose the JSON file again.": "error.portableImportExpired",
  "Portable data selection is invalid.": "error.portableSelectionInvalid",
  "Select at least one available data category.": "error.portableSelectionEmpty",
  "Unable to create a unique imported name.": "error.portableNameConflict",
  "Macro is already running for this role.": "error.macroAlreadyRunning",
  "Stop the macro before editing it.": "error.macroStopBeforeEditing",
  "Ctrl+Shift+M is reserved for the macro overlay.": "error.macroShortcutReserved",
  "Macro shortcut conflicts with another macro assigned to the same role.": "error.macroShortcutConflict",
  "This macro is not assigned to the current role.": "error.macroNotAssigned",
  "Macro is not assigned to this role.": "error.macroNotAssigned",
  "Launch this role before running a macro.": "error.macroRoleNotRunning",
  "Launch at least one assigned role before running a macro.": "error.macroNoRunnableRoles",
  "Macro control is unavailable for this compatibility-mode session. Restart the role and try again.":
    "error.macroExternalRuntimeUnsupported",
  "Macro control could not connect to compatibility mode. Restart this role to try again.":
    "notice.externalMacroUnavailable",
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
  if (locales.some(isJapaneseLocale)) {
    return "ja";
  }

  if (locales.some(isTraditionalChineseLocale)) {
    return "zh-TW";
  }

  if (locales.some(isSimplifiedChineseLocale)) {
    return "zh-CN";
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
  const alreadyRunningMatch = /^Already running in another game window: (.+)\.$/.exec(message);
  if (alreadyRunningMatch) {
    const translations = getLoadedTranslations(language) ?? fallbackTranslations;
    const template = translations["error.rolesAlreadyRunning"] ?? fallbackTranslations["error.rolesAlreadyRunning"];
    return template.replace("{names}", alreadyRunningMatch[1]);
  }

  const key = knownErrorMessages[message];
  if (!key) {
    return message;
  }

  const translations = getLoadedTranslations(language) ?? fallbackTranslations;
  return translations[key] ?? fallbackTranslations[key] ?? message;
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
