import en from "../../renderer/src/i18n/en.json";
import zhTW from "../../renderer/src/i18n/zh-TW.json";
import zhCN from "../../renderer/src/i18n/zh-CN.json";
import ja from "../../renderer/src/i18n/ja.json";
import { readWorkspaceWebLanguage } from "./workspaceStartPage";

export function workspaceWebStatus(state: { loading: boolean; errorCode?: number }): string {
  const language = readWorkspaceWebLanguage();
  const messages = language === "zh-TW" ? zhTW : language === "zh-CN" ? zhCN : language === "ja" ? ja : en;
  return state.errorCode !== undefined ? messages["workspaces.webNavigationFailed"]
    : state.loading ? messages["workspaces.webNavigationLoading"] : "";
}
