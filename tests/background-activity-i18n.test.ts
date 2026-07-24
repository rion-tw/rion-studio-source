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
      expect(dictionary).not.toHaveProperty("workspaces.primaryRole");
      expect(dictionary).not.toHaveProperty("workspaces.primaryRoleDescription");
      expect(dictionary).not.toHaveProperty("workspaces.primaryRoleUnassigned");
      expect(dictionary).not.toHaveProperty("workspaces.primaryBadge");
      expect(dictionary).not.toHaveProperty("workspaces.throttleRate");
      expect(dictionary).not.toHaveProperty("workspaces.resourceMode");
      expect(dictionary).not.toHaveProperty("workspaces.resourceModeDescription");
      expect(dictionary).not.toHaveProperty("workspaces.resourceModeAdaptive");
      expect(dictionary).not.toHaveProperty("workspaces.resourceModeUnrestricted");
      expect(dictionary).not.toHaveProperty("settings.defaultPreset");
      expect(dictionary).not.toHaveProperty("preset.balanced");
      expect(dictionary).not.toHaveProperty("preset.performance");
    }
  });

  it("keeps automatic runtime status labels without role window settings", () => {
    for (const dictionary of Object.values(dictionaries)) {
      expect(dictionary).not.toHaveProperty("roleForm.section.launchDescription");
      expect(dictionary).not.toHaveProperty("roleForm.width");
      expect(dictionary).not.toHaveProperty("roleForm.height");
      expect(dictionary).not.toHaveProperty("settings.roleDefaults");
      expect(dictionary).not.toHaveProperty("settings.defaultWindow");
      expect(dictionary).not.toHaveProperty("settings.defaultWindowWidth");
      expect(dictionary).not.toHaveProperty("settings.defaultWindowHeight");
      expect(dictionary).not.toHaveProperty("games.form.roleDefaults");
    }

    for (const dictionary of Object.values(dictionaries)) {
      expect(dictionary["workspaces.help.runtimeResource"]).toBeTruthy();
      expect(dictionary["workspaces.resourceReason.runtimeTabBackground"]).toBeTruthy();
    }

    expect(en["workspaces.help.runtimeResource"]).toContain("inactive embedded tabs");
    expect(zhTW["workspaces.help.runtimeResource"]).toContain("非作用中內嵌分頁");
  });
});
