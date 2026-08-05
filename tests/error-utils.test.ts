import { describe, expect, it } from "vitest";

import { isPersistentRuntimeError, toMessage } from "../src/renderer/src/app/errorUtils";
import {
  languages,
  loadTranslations,
  localizeErrorMessage,
  type TranslationKey
} from "../src/renderer/src/i18n";

describe("renderer error localization", () => {
  it("separates stopping roles from temporary input fences in every language", async () => {
    const keys = {
      MACRO_ROLE_STOPPING: "error.macroRoleStopping",
      MACRO_ROLE_INPUT_FENCED: "error.macroRoleInputFenced"
    } as const;

    for (const language of languages) {
      const translations = await loadTranslations(language);
      const t = (key: TranslationKey) => translations[key];
      for (const [code, key] of Object.entries(keys) as Array<[string, TranslationKey]>) {
        expect(toMessage({ code, message: "English fallback" }, language, t)).toBe(
          translations[key]
        );
      }
    }
  });

  it("localizes hidden browser helper launch failures", () => {
    expect(localizeErrorMessage("Unable to start the hidden Rion Studio browser helper.", "en")).toBe(
      "Unable to start the hidden browser helper."
    );
  });

  it("localizes legacy-shell-wrapped standard errors", async () => {
    await loadTranslations("zh-TW");

    expect(
      localizeErrorMessage(
        "Error invoking remote method 'roles:create': Error: Role name is required.",
        "zh-TW"
      )
    ).toBe("角色名稱為必填。");
  });

  it("removes legacy IPC details from unknown errors", () => {
    expect(
      localizeErrorMessage(
        "Error invoking remote method 'roles:create': Error: A new unknown failure occurred.",
        "en"
      )
    ).toBe("A new unknown failure occurred.");
  });

  it("localizes game page load failures", async () => {
    const message =
      "Unable to load the game page. Check the operating-system network settings or game accelerator mode.";

    await loadTranslations("zh-TW");
    await loadTranslations("zh-CN");

    expect(localizeErrorMessage(message, "zh-TW")).toBe(
      "無法載入遊戲頁面。請檢查作業系統網路設定或遊戲加速器模式。"
    );
    expect(localizeErrorMessage(message, "zh-CN")).toBe(
      "无法加载游戏页面。请检查操作系统网络设置或游戏加速器模式。"
    );
  });

  it("keeps unverified native surface release failures visible", async () => {
    const message =
      "Rion Studio could not verify that the native game page stopped. The tab remains closed; restart Rion Studio before reopening this role.";
    await Promise.all([loadTranslations("zh-TW"), loadTranslations("zh-CN"), loadTranslations("ja")]);

    expect(isPersistentRuntimeError({
      code: "SYSTEM_SURFACE_RELEASE_UNVERIFIED",
      message
    })).toBe(true);
    expect(isPersistentRuntimeError(new Error(message))).toBe(true);
    expect(isPersistentRuntimeError(message)).toBe(true);
    expect(isPersistentRuntimeError(
      "Rion Studio still cannot verify that the native game page stopped. Keep this tab closed and restart Rion Studio before reopening the role."
    )).toBe(true);
    expect(isPersistentRuntimeError({ code: "ROLE_NOT_FOUND", message: "Role not found." })).toBe(false);
    expect(localizeErrorMessage(message, "zh-TW")).toBe(
      "無法確認角色的原生遊戲頁面已停止。分頁會保持關閉；重新開啟此角色前，請先重新啟動 Rion Studio。"
    );
    expect(localizeErrorMessage(message, "zh-CN")).toBe(
      "无法确认角色的原生游戏页面已停止。标签页会保持关闭；重新打开此角色前，请先重新启动 Rion Studio。"
    );
    expect(localizeErrorMessage(message, "ja")).toBe(
      "ネイティブのゲームページが停止したことを確認できませんでした。タブは閉じたままです。このロールを再度開く前に Rion Studio を再起動してください。"
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

  it("localizes game-window rename validation errors in every language", async () => {
    const codes = {
      GAME_WINDOW_NAME_REQUIRED: "error.gameWindowNameRequired",
      GAME_WINDOW_NAME_TOO_LONG: "error.gameWindowNameTooLong",
      GAME_WINDOW_NAME_DUPLICATE: "error.gameWindowNameDuplicate"
    } as const;

    for (const language of languages) {
      const translations = await loadTranslations(language);
      const t = (key: TranslationKey) => translations[key];
      for (const [code, key] of Object.entries(codes) as Array<[string, TranslationKey]>) {
        expect(toMessage({ code, message: "English fallback" }, language, t)).toBe(translations[key]);
      }
    }
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

});
