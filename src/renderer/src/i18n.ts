import { MACRO_DELAY_MAX_MS, MACRO_KEY_HOLD_DURATION_MIN_MS } from "../../shared/macroSettings";
import type { AppLanguage } from "../../shared/types";
import en from "./i18n/en.json";

export type Language = AppLanguage;
export type TranslationKey = keyof typeof en;
export type Translator = (key: TranslationKey) => string;
export type TranslationDictionary = Record<TranslationKey, string>;

export const languages: Language[] = ["en", "zh-TW", "zh-CN", "ja"];

type RuntimeTabStripLabels = {
  automaticInputRestartRequired: string;
  closeWindow: string;
  closeTab: string;
  maximizeWindow: string;
  minimizeWindow: string;
  openLauncher: string;
  openTabMenu: string;
  playingAudio: string;
  restoreWindow: string;
  scrollLeft: string;
  scrollRight: string;
  statusActivating: string;
  statusDegraded: string;
  statusDormant: string;
  statusFailed: string;
  tabMuted: string;
  windowControls: string;
};

const runtimeTabStripTranslations: Record<Language, RuntimeTabStripLabels> = {
  en: {
    automaticInputRestartRequired: "Automatic input is paused. Restart the role.",
    closeWindow: "Close window",
    closeTab: "Stop and close tab",
    maximizeWindow: "Maximize window",
    minimizeWindow: "Minimize window",
    openLauncher: "Open role or workspace",
    openTabMenu: "Open tab menu",
    playingAudio: "Playing audio",
    restoreWindow: "Restore window",
    scrollLeft: "Scroll tabs left",
    scrollRight: "Scroll tabs right",
    statusActivating: "Starting tab…",
    statusDegraded: "Some features are currently unavailable.",
    statusDormant: "Not started. Select to start this tab.",
    statusFailed: "Couldn’t start this tab. Select to try again.",
    tabMuted: "Tab muted",
    windowControls: "Window controls"
  },
  "zh-TW": {
    automaticInputRestartRequired: "自動輸入已暫停，需重啟角色。",
    closeWindow: "關閉視窗",
    closeTab: "停止並關閉分頁",
    maximizeWindow: "最大化視窗",
    minimizeWindow: "最小化視窗",
    openLauncher: "開啟角色或工作區",
    openTabMenu: "開啟分頁選單",
    playingAudio: "正在播放聲音",
    restoreWindow: "還原視窗",
    scrollLeft: "向左捲動分頁",
    scrollRight: "向右捲動分頁",
    statusActivating: "正在啟動分頁…",
    statusDegraded: "部分功能目前無法使用。",
    statusDormant: "尚未啟動。選取時啟動此分頁。",
    statusFailed: "無法啟動分頁。選取以重試。",
    tabMuted: "分頁已靜音",
    windowControls: "視窗控制項"
  },
  "zh-CN": {
    automaticInputRestartRequired: "自动输入已暂停，需要重启角色。",
    closeWindow: "关闭窗口",
    closeTab: "停止并关闭标签页",
    maximizeWindow: "最大化窗口",
    minimizeWindow: "最小化窗口",
    openLauncher: "打开角色或工作区",
    openTabMenu: "打开标签页菜单",
    playingAudio: "正在播放声音",
    restoreWindow: "还原窗口",
    scrollLeft: "向左滚动标签页",
    scrollRight: "向右滚动标签页",
    statusActivating: "正在启动标签页…",
    statusDegraded: "部分功能当前无法使用。",
    statusDormant: "尚未启动。选择时启动此标签页。",
    statusFailed: "无法启动标签页。选择以重试。",
    tabMuted: "标签页已静音",
    windowControls: "窗口控件"
  },
  ja: {
    automaticInputRestartRequired: "自動入力を一時停止しました。ロールを再起動してください。",
    closeWindow: "ウインドウを閉じる",
    closeTab: "停止してタブを閉じる",
    maximizeWindow: "ウインドウを最大化",
    minimizeWindow: "ウインドウを最小化",
    openLauncher: "ロールまたはワークスペースを開く",
    openTabMenu: "タブメニューを開く",
    playingAudio: "音声を再生中",
    restoreWindow: "ウインドウを元に戻す",
    scrollLeft: "タブを左へスクロール",
    scrollRight: "タブを右へスクロール",
    statusActivating: "タブを起動中…",
    statusDegraded: "一部の機能は現在利用できません。",
    statusDormant: "まだ起動していません。選択するとこのタブを起動します。",
    statusFailed: "タブを起動できませんでした。選択すると再試行します。",
    tabMuted: "タブはミュート中",
    windowControls: "ウインドウコントロール"
  }
};

export function runtimeTabStripLabels(language: Language): RuntimeTabStripLabels {
  return runtimeTabStripTranslations[language] ?? runtimeTabStripTranslations.en;
}

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
  "Rion Studio desktop bridge is unavailable. Restart the app after rebuilding.": "error.desktopBridgeUnavailable",
  "Rion Studio data did not load within 15 seconds.": "error.appDataTimeout",
  "Legal acceptance status did not load within 15 seconds.": "error.legalStatusTimeout",
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
  "A game window with this name already exists.": "error.gameWindowNameDuplicate",
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
  "Launch workspace not found.": "error.workspaceNotFound",
  "Launch workspace data file is invalid.": "error.workspaceDataInvalid",
  "Launch workspace order is invalid.": "error.workspaceOrderInvalid",
  "Launch workspace name is required.": "error.workspaceNameRequired",
  "Launch workspace name must be 80 characters or fewer.": "error.workspaceNameTooLong",
  "Launch workspace layout is invalid.": "error.workspaceTemplateInvalid",
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
  "A shortcut with selected source roles requires at least one role.": "error.macroShortcutSourceRequired",
  "Macro repeat setting is invalid.": "error.macroRepeatInvalid",
  "Macro activation mode is invalid.": "error.macroActivationModeInvalid",
  "A tap-or-hold macro requires a shortcut.": "error.macroHoldShortcutRequired",
  [`Macro interval must be between 0 and ${MACRO_DELAY_MAX_MS} ms.`]: "error.macroIntervalInvalid",
  "Macro must contain at least one step.": "error.macroStepsRequired",
  "Macro can contain at most 100 steps.": "error.macroStepsTooMany",
  "Macro key step is invalid.": "error.macroKeyStepInvalid",
  "Macro call mode is invalid.": "error.macroCallModeInvalid",
  "Macro key action is invalid.": "error.macroKeyActionInvalid",
  [`Macro key hold duration must be between ${MACRO_KEY_HOLD_DURATION_MIN_MS} and ${MACRO_DELAY_MAX_MS} ms.`]: "error.macroKeyDurationInvalid",
  "Macro key hold duration is only valid for timed holds.": "error.macroKeyDurationUnexpected",
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
  "Macro is already running for this role.": "error.macroAlreadyRunning",
  "A role assigned to this macro is stopping and cannot accept new input.":
    "error.macroRoleStopping",
  "A role assigned to this macro is navigating and cannot accept automatic input yet.":
    "error.macroRoleInputFenced",
  "A role assigned to this macro is recovering automatic input.":
    "error.macroRoleInputRecovering",
  "A role assigned to this macro must be restarted before it can accept automatic input.":
    "error.macroRoleInputRestartRequired",
  "Enable this macro before running it.": "error.macroDisabled",
  "Stop the macro before editing it.": "error.macroStopBeforeEditing",
  "Ctrl+Shift+M is reserved for the macro overlay.": "error.macroShortcutReserved",
  "Browser zoom shortcuts are reserved for the active game role.": "error.macroBrowserZoomShortcutReserved",
  "Ctrl+Tab and Ctrl+Shift+Tab are reserved for switching Rion Studio tabs.":
    "error.macroRuntimeTabShortcutReserved",
  "Macro shortcut conflicts with another macro assigned to the same role.": "error.macroShortcutConflict",
  "Macro shortcut conflicts with another macro for an overlapping source role.": "error.macroShortcutConflict",
  "This macro is not assigned to the current role.": "error.macroNotAssigned",
  "Macro is not assigned to this role.": "error.macroNotAssigned",
  "Launch this role before running a macro.": "error.macroRoleNotRunning",
  "Launch at least one assigned role before running a macro.": "error.macroNoRunnableRoles",
  "Assign a role to this macro and every called macro before running it.":
    "error.macroUnassignedWorkflow",
  "Launch workspace has no roles.": "error.workspaceEmpty",
  "Unable to start the hidden Rion Studio browser helper.": "error.hiddenBrowserHelperUnavailable",
  "Rion Studio could not verify that the native game page stopped. The tab was kept open; retry or restart Rion Studio.":
    "error.surfaceReleaseUnverified",
  "Rion Studio could not verify that every native game page stopped. The tab was kept open; retry or restart Rion Studio.":
    "error.surfaceReleaseUnverified",
  "Rion Studio could not verify that the native game page stopped. The tab remains closed; restart Rion Studio before reopening this role.":
    "error.surfaceReleaseUnverified",
  "Rion Studio could not verify that every native game page stopped. The tab remains closed; restart Rion Studio before reopening these roles.":
    "error.surfaceReleaseUnverified",
  "Rion Studio still cannot verify that the native game page stopped. Keep this tab closed and restart Rion Studio before reopening the role.":
    "error.surfaceReleaseUnverified",
  "Unable to load the game page. Check the operating-system network settings or game accelerator mode.":
    "error.gamePageLoadFailed",
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

function detectSystemLanguage(): Language {
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

function isLanguage(value: string | null): value is Language {
  return value !== null && languages.includes(value as Language);
}

export function localizeErrorMessage(message: string, language: Language): string {
  const normalizedMessage = normalizeIpcErrorMessage(message);
  const translations = getLoadedTranslations(language) ?? fallbackTranslations;
  const alreadyRunningMatch = /^Already running in another game window: (.+)\.$/.exec(normalizedMessage);
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
    const match = pattern.exec(normalizedMessage);
    if (match) {
      return (translations[key] ?? fallbackTranslations[key]).replace(placeholder, match[1]);
    }
  }

  const key = knownErrorMessages[normalizedMessage];
  if (key) {
    return translations[key] ?? fallbackTranslations[key] ?? normalizedMessage;
  }

  let localizedMessage = normalizedMessage;
  let localizedNotice = false;
  Object.entries(knownErrorMessages).forEach(([knownMessage, translationKey]) => {
    if (!translationKey?.startsWith("notice.") || !localizedMessage.includes(knownMessage)) {
      return;
    }
    const translatedNotice = translations[translationKey] ?? fallbackTranslations[translationKey];
    localizedMessage = localizedMessage.split(knownMessage).join(translatedNotice);
    localizedNotice = true;
  });
  return localizedNotice ? localizedMessage : normalizedMessage;
}

function normalizeIpcErrorMessage(message: string): string {
  const wrappedMessageMatch = /^Error invoking remote method '[^']+':\s*([\s\S]+)$/.exec(message);
  if (!wrappedMessageMatch) {
    return message;
  }

  return wrappedMessageMatch[1].replace(/^(?:[A-Za-z_$][\w$]*Error|Error):\s*/, "");
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
