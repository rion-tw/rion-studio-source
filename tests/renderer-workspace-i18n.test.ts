import { describe, expect, it } from "vitest";

import en from "../src/renderer/src/i18n/en.json";
import ja from "../src/renderer/src/i18n/ja.json";
import zhCN from "../src/renderer/src/i18n/zh-CN.json";
import zhTW from "../src/renderer/src/i18n/zh-TW.json";

const dictionaries = { en, ja, "zh-CN": zhCN, "zh-TW": zhTW };
const workspaceHelpKeys = [
  "workspaces.help.editingTitle",
  "workspaces.help.editingAssign",
  "workspaces.help.editingResize",
  "workspaces.help.editingTemplate",
  "workspaces.help.launchTitle",
  "workspaces.help.launchRequirements",
  "workspaces.help.launchWindow",
  "workspaces.help.runtimeTitle",
  "workspaces.help.runtimeZoom",
  "workspaces.help.runtimeResource",
  "workspaces.launchConflict.title",
  "workspaces.launchConflict.description",
  "workspaces.launchConflict.confirm",
  "gameWindows.title"
] as const;

describe("workspace help translations", () => {
  it("provides every workspace help message in every language", () => {
    for (const dictionary of Object.values(dictionaries)) {
      for (const key of workspaceHelpKeys) {
        expect(dictionary[key]).toBeTruthy();
      }
      expect(dictionary).not.toHaveProperty("workspaces.roleZoomShortcutHint");
    }
  });

  it("describes native hidden-tab throttling without promising a custom CPU limiter", () => {
    expect(en["workspaces.help.runtimeResource"]).toContain("native background throttling");
    expect(zhTW["workspaces.help.runtimeResource"]).toContain("原生背景節流");
    expect(zhCN["workspaces.help.runtimeResource"]).toContain("原生后台节流");
    expect(ja["workspaces.help.runtimeResource"]).toContain("ネイティブのバックグラウンドスロットリング");
  });
});
