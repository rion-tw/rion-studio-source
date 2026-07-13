import { describe, expect, it } from "vitest";

import { loadTranslations, localizeErrorMessage } from "../src/renderer/src/i18n";

describe("renderer error localization", () => {
  it("localizes hidden browser helper launch failures", () => {
    expect(localizeErrorMessage("Unable to start the hidden Rion Studio browser helper.", "en")).toBe(
      "Unable to start the hidden browser helper."
    );
  });

  it("localizes game page load failures", async () => {
    const message = "Unable to load the game page. Check your network, DNS, proxy, or VPN settings and try again.";

    await loadTranslations("zh-TW");
    await loadTranslations("zh-CN");

    expect(localizeErrorMessage(message, "zh-TW")).toBe(
      "無法載入遊戲頁面。請檢查網路、DNS、代理或 VPN 設定後再試一次。"
    );
    expect(localizeErrorMessage(message, "zh-CN")).toBe(
      "无法加载游戏页面。请检查网络、DNS、代理或 VPN 设置后再试一次。"
    );
  });

  it("preserves role names when localizing duplicate game-window errors", async () => {
    await loadTranslations("zh-TW");
    expect(localizeErrorMessage("Already running in another game window: Main, Alt.", "zh-TW")).toBe(
      "以下角色已在其他遊戲視窗執行：Main, Alt。請先停止後再啟動。"
    );
  });
});
