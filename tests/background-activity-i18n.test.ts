import { describe, expect, it } from "vitest";

import en from "../src/renderer/src/i18n/en.json";
import ja from "../src/renderer/src/i18n/ja.json";
import zhCN from "../src/renderer/src/i18n/zh-CN.json";
import zhTW from "../src/renderer/src/i18n/zh-TW.json";

describe("background activity translations", () => {
  it("uses accurate labels in every supported language", () => {
    expect(en).toMatchObject({
      "roleForm.launchPreset": "Background activity",
      "preset.balanced": "Power saving (Recommended)",
      "preset.performance": "Keep active"
    });
    expect(zhTW).toMatchObject({
      "roleForm.launchPreset": "背景活動",
      "preset.balanced": "自動節能（建議）",
      "preset.performance": "持續運作"
    });
    expect(zhCN).toMatchObject({
      "roleForm.launchPreset": "背景活动",
      "preset.balanced": "自动节能（推荐）",
      "preset.performance": "持续运行"
    });
    expect(ja).toMatchObject({
      "roleForm.launchPreset": "バックグラウンド動作",
      "preset.balanced": "自動省電（推奨）",
      "preset.performance": "常時動作"
    });
  });
});
