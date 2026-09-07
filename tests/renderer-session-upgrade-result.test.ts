import { describe, expect, it } from "vitest";
import { formatUpgradeResult, upgradeDataStatus } from "../src/renderer/src/features/roles/upgradeResult";
import en from "../src/renderer/src/i18n/en.json";
import tw from "../src/renderer/src/i18n/zh-TW.json";
import cn from "../src/renderer/src/i18n/zh-CN.json";
import ja from "../src/renderer/src/i18n/ja.json";

describe.each(["macos", "windows"])("%s upgrade result presentation", () => {
  it.each([en, tw, cn, ja])("keeps cookie failure distinct from transferred LocalStorage", locale => {
    const messages: Record<string, string> = locale;
    const t = (key: keyof typeof en) => messages[key] ?? en[key];
    const result = formatUpgradeResult("角色 A", { cookies: "failed", localStorage: "transferred", cookieCount: 0, localStorageOriginCount: 1, localStorageEntryCount: 1, reasons: [] }, t);
    expect(result).toContain("角色 A");
    expect(result).toContain(t("recovery.upgradeFailed"));
    expect(result).toContain(t("recovery.upgradeTransferred"));
    expect(result).not.toMatch(/\{.*\}/u);
    expect(upgradeDataStatus("unknown", t)).toBe(t("recovery.upgradeUnavailable"));
  });
});
