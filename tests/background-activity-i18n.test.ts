import { describe, expect, it } from "vitest";

import en from "../src/renderer/src/i18n/en.json";
import ja from "../src/renderer/src/i18n/ja.json";
import zhCN from "../src/renderer/src/i18n/zh-CN.json";
import zhTW from "../src/renderer/src/i18n/zh-TW.json";

const dictionaries = { en, ja, "zh-CN": zhCN, "zh-TW": zhTW };

describe("automatic power saving i18n", () => {
  it("removes background activity and fixed resource controls from every language", () => {
    for (const dictionary of Object.values(dictionaries)) {
      expect(dictionary).not.toHaveProperty("roleForm.launchPreset");
      expect(dictionary).not.toHaveProperty("roleForm.backgroundActivityDescription");
      expect(dictionary).not.toHaveProperty("workspaces.resourceModePrimary");
      expect(dictionary).not.toHaveProperty("workspaces.resourceState.primary");
      expect(dictionary).not.toHaveProperty("workspaces.throttleRate");
      expect(dictionary).not.toHaveProperty("settings.defaultPreset");
      expect(dictionary).not.toHaveProperty("preset.balanced");
      expect(dictionary).not.toHaveProperty("preset.performance");
    }
  });

  it("keeps adaptive and unrestricted labels with browser-size-only role descriptions", () => {
    expect(en["roleForm.section.launchDescription"]).toBe("Set the browser size for this role.");
    expect(zhTW["roleForm.section.launchDescription"]).toBe("設定此角色的瀏覽器尺寸。");
    expect(zhCN["roleForm.section.launchDescription"]).toBe("设置此角色的浏览器尺寸。");
    expect(ja["roleForm.section.launchDescription"]).toBe("このロールのブラウザーサイズを設定します。");

    for (const dictionary of Object.values(dictionaries)) {
      expect(dictionary["workspaces.resourceModeAdaptive"]).toBeTruthy();
      expect(dictionary["workspaces.resourceModeUnrestricted"]).toBeTruthy();
      expect(dictionary["workspaces.resourceReason.runtimeTabBackground"]).toBeTruthy();
    }

    expect(en["workspaces.resourceModeDescription"]).toContain("visible roles");
    expect(en["workspaces.primaryRoleDescription"]).toContain("initial focus");
    expect(zhTW["workspaces.resourceModeDescription"]).toContain("非作用中分頁");
    expect(zhTW["workspaces.primaryRoleDescription"]).toContain("先聚焦");
  });
});
