import { describe, expect, it } from "vitest";

import { loadTranslations, localizeErrorMessage } from "../src/renderer/src/i18n";

describe("renderer error localization", () => {
  it("localizes hidden browser helper launch failures", () => {
    expect(localizeErrorMessage("Unable to start the hidden Rion Studio browser helper.", "en")).toBe(
      "Unable to start the hidden browser helper."
    );
  });

  it("localizes Electron-wrapped custom errors", async () => {
    await loadTranslations("zh-TW");

    expect(
      localizeErrorMessage(
        "Error invoking remote method 'chrome-profile:import-preview':\nChromeProfileImportError: " +
          "Chrome is still using the selected profile. Quit Chrome and try again.",
        "zh-TW"
      )
    ).toBe("Chrome 仍在使用選取的個人資料。請關閉 Chrome 後再試一次。");
  });

  it("localizes Electron-wrapped standard errors", async () => {
    await loadTranslations("zh-TW");

    expect(
      localizeErrorMessage(
        "Error invoking remote method 'roles:create': Error: Role name is required.",
        "zh-TW"
      )
    ).toBe("角色名稱為必填。");
  });

  it("removes Electron IPC details from unknown errors", () => {
    expect(
      localizeErrorMessage(
        "Error invoking remote method 'roles:create': Error: A new unknown failure occurred.",
        "en"
      )
    ).toBe("A new unknown failure occurred.");
  });

  it("localizes game page load failures", async () => {
    const message =
      "Unable to load the game page. If you use a game accelerator, enable global, TUN, or system proxy mode, or set a local proxy in Game settings.";

    await loadTranslations("zh-TW");
    await loadTranslations("zh-CN");

    expect(localizeErrorMessage(message, "zh-TW")).toBe(
      "無法載入遊戲頁面。若使用遊戲加速器，請開啟全局、TUN 或系統代理模式，或在遊戲設定中設定本機代理。"
    );
    expect(localizeErrorMessage(message, "zh-CN")).toBe(
      "无法加载游戏页面。若使用游戏加速器，请开启全局、TUN 或系统代理模式，或在游戏设置中设置本机代理。"
    );
  });

  it("localizes an empty portable data selection", async () => {
    await loadTranslations("zh-TW");

    expect(localizeErrorMessage("Select at least one available data category.", "zh-TW")).toBe(
      "請至少選擇一個可用的資料分類。"
    );
  });

  it("localizes game management failures", async () => {
    await loadTranslations("zh-TW");

    expect(localizeErrorMessage("Move or delete assigned roles before deleting this game.", "zh-TW")).toBe(
      "請先改派或刪除關聯角色，再刪除此遊戲。"
    );
    expect(localizeErrorMessage("A compatibility check is already running for this game.", "zh-TW")).toBe(
      "此遊戲已有相容性檢查正在執行。"
    );
  });

  it("localizes game cover validation and processing errors", async () => {
    await loadTranslations("zh-TW");
    await loadTranslations("ja");

    expect(localizeErrorMessage(
      "Game cover must be a PNG, JPEG, WebP, or GIF image up to 8 MB.",
      "zh-TW"
    )).toBe("遊戲封面必須是 PNG、JPEG、WebP 或 GIF，且不超過 8 MB。");
    expect(localizeErrorMessage("Unable to process game cover.", "ja"))
      .toBe("ゲームカバーを処理できません。");
  });

  it("preserves role names when localizing duplicate game-window errors", async () => {
    await loadTranslations("zh-TW");
    expect(localizeErrorMessage("Already running in another game window: Main, Alt.", "zh-TW")).toBe(
      "以下角色已在其他遊戲視窗執行：Main, Alt。請先停止後再啟動。"
    );
  });

  it("localizes macro dependency and called-macro errors without losing names", async () => {
    await Promise.all([loadTranslations("zh-TW"), loadTranslations("zh-CN"), loadTranslations("ja")]);

    expect(localizeErrorMessage("Macro is used by: Parent one, Parent two.", "zh-TW")).toBe(
      "此巨集正被下列巨集呼叫：Parent one, Parent two。"
    );
    expect(localizeErrorMessage('Called macro "Child" is already running.', "zh-CN")).toBe(
      "被调用的宏“Child”已在运行。"
    );
  });

  it("localizes the unassigned macro workflow error", async () => {
    const message = "Assign a role to this macro and every called macro before running it.";
    await Promise.all([loadTranslations("zh-TW"), loadTranslations("zh-CN"), loadTranslations("ja")]);

    expect(localizeErrorMessage(message, "zh-TW")).toBe(
      "請先為此巨集與所有呼叫的巨集指派角色，再執行巨集。"
    );
    expect(localizeErrorMessage(message, "zh-CN")).toBe(
      "请先为此宏及所有调用的宏指定角色，再运行宏。"
    );
    expect(localizeErrorMessage(message, "ja")).toBe(
      "このマクロと呼び出されるすべてのマクロにロールを割り当ててから実行してください。"
    );
  });

  it("localizes external Chrome zoom failures alone and inside fallback notices", async () => {
    const fallback =
      "Embedded game view failed to load. Rion Studio switched to external Chrome compatibility mode for accelerator support.";
    const zoomFailure =
      "Workspace zoom could not be applied in external Chrome. Restart this role to try again.";
    await loadTranslations("zh-TW");
    await loadTranslations("zh-CN");
    await loadTranslations("ja");

    expect(localizeErrorMessage(zoomFailure, "en")).toBe(zoomFailure);
    expect(localizeErrorMessage(zoomFailure, "zh-TW")).toBe(
      "無法在外部 Chrome 套用工作區縮放。請重新啟動此角色後再試一次。"
    );
    expect(localizeErrorMessage(`${fallback} ${zoomFailure}`, "zh-CN")).toBe(
      "内嵌游戏画面无法加载。Rion Studio 已切换到外部 Chrome 兼容模式，以提高加速器支持。 " +
      "无法在外部 Chrome 应用工作区缩放。请重新启动此角色后再试一次。"
    );
    expect(localizeErrorMessage(zoomFailure, "ja")).toBe(
      "外部 Chrome でワークスペースのズームを適用できませんでした。このロールを再起動してもう一度お試しください。"
    );
  });

  it("explains that an unavailable external overlay does not disable Studio macros", async () => {
    const message =
      "Chrome in-page macro shortcuts are unavailable, but macros can still be run from Rion Studio.";
    await loadTranslations("zh-TW");

    expect(localizeErrorMessage(message, "zh-TW")).toBe(
      "Chrome 頁面內的巨集快捷鍵目前無法使用，但仍可從 Rion Studio 執行巨集。"
    );
  });
});
