import en from "../../renderer/src/i18n/en.json";
import zhTW from "../../renderer/src/i18n/zh-TW.json";
import zhCN from "../../renderer/src/i18n/zh-CN.json";
import ja from "../../renderer/src/i18n/ja.json";
import { readWorkspaceWebLanguage } from "./workspaceStartPage";
import type { AppLanguage } from "../../shared/types";
import type { RuntimeRolePlaceholderLabels } from "../../shared/runtimeRolePlaceholder";
import type { WorkspaceWebChromeLabels } from "../../shared/workspaceWebChrome";

const translations = { en, "zh-TW": zhTW, "zh-CN": zhCN, ja };

export function workspaceWebChromeCopy(language: AppLanguage): WorkspaceWebChromeLabels {
  const messages = translations[language];
  return {
    navigation: messages["workspaces.webChromeNavigation"],
    back: messages["workspaces.webChromeBack"],
    forward: messages["workspaces.webChromeForward"],
    reload: messages["workspaces.webChromeReload"],
    home: messages["workspaces.webChromeHome"],
    address: messages["workspaces.webChromeAddress"],
    placeholder: messages["workspaces.webChromePlaceholder"],
    website: messages["workspaces.webChromeWebsite"],
    loading: messages["workspaces.webNavigationLoading"],
    failed: messages["workspaces.webChromeFailed"],
    invalid: messages["workspaces.webChromeInvalid"],
    emptyAddress: messages["workspaces.webChromeEmptyAddress"],
    invalidAddress: messages["workspaces.webChromeInvalidAddress"]
  };
}

/** Blocked Role-slot text in the current application language. */
export function runtimeRolePlaceholderLabels(
  state: Readonly<{ blocked: boolean; ownerTabName: string | null }>
): RuntimeRolePlaceholderLabels {
  const messages = translations[readWorkspaceWebLanguage()];
  const tab = state.ownerTabName ?? messages["runtimeRolePlaceholder.unknownTab"];
  return {
    action: messages[state.blocked ? "runtimeRolePlaceholder.claim" : "runtimeRolePlaceholder.open"],
    busy: messages["runtimeRolePlaceholder.busy"],
    failed: messages["runtimeRolePlaceholder.failed"],
    message: state.blocked
      ? messages["runtimeRolePlaceholder.blocked"].replace("{tab}", () => tab)
      : messages["runtimeRolePlaceholder.available"]
  };
}

export function workspaceWebStatus(state: { loading: boolean; errorCode?: number }): string {
  const language = readWorkspaceWebLanguage();
  const messages = translations[language];
  return state.errorCode !== undefined ? messages["workspaces.webNavigationFailed"]
    : state.loading ? messages["workspaces.webNavigationLoading"] : "";
}

const englishNativeDialogTitles = {
  chromeProfile: "Choose Chrome User Data",
  diagnosticsExport: "Export Rion Studio Diagnostics",
  portableExport: "Export Rion Studio JSON",
  portableImport: "Import Rion Studio JSON"
} as const;

const nativeDialogTitleKeys = {
  chromeProfile: "settings.chromeImportChooseFolder",
  diagnosticsExport: "settings.logsExport",
  portableExport: "settings.exportJson",
  portableImport: "settings.importJson"
} as const;

/** Windows shows a native file dialog's title, so it follows the app language. */
export function nativeDialogTitle(kind: keyof typeof englishNativeDialogTitles): string {
  const language = readWorkspaceWebLanguage();
  return language === "en"
    ? englishNativeDialogTitles[kind]
    : translations[language][nativeDialogTitleKeys[kind]];
}
