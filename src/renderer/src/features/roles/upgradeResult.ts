import type { RoleSessionUpgradeResult } from "../../../../shared/generated";
import type { Translator } from "../../i18n";

export function upgradeDataStatus(status: string, t: Translator): string {
  if (status === "transferred") return t("recovery.upgradeTransferred");
  if (status === "partiallyTransferred") return t("recovery.upgradePartial");
  if (status === "failed") return t("recovery.upgradeFailed");
  return t("recovery.upgradeUnavailable");
}
export function formatUpgradeResult(name: string, result: RoleSessionUpgradeResult, t: Translator): string {
  return t("recovery.upgradeNotice").replace("{name}", name)
    .replace("{cookies}", upgradeDataStatus(result.cookies, t))
    .replace("{localStorage}", upgradeDataStatus(result.localStorage, t));
}
