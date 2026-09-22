import en from "../../renderer/src/i18n/en.json";
import zhTW from "../../renderer/src/i18n/zh-TW.json";
import zhCN from "../../renderer/src/i18n/zh-CN.json";
import ja from "../../renderer/src/i18n/ja.json";
import { readWorkspaceWebLanguage } from "./workspaceStartPage";
import type { AppLanguage } from "../../shared/types";
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

export function workspaceWebStatus(state: { loading: boolean; errorCode?: number }): string {
  const language = readWorkspaceWebLanguage();
  const messages = translations[language];
  return state.errorCode !== undefined ? messages["workspaces.webNavigationFailed"]
    : state.loading ? messages["workspaces.webNavigationLoading"] : "";
}
