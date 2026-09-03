import type { MenuItemConstructorOptions } from "electron";

import type { AppLanguage } from "../../shared/types";
import type { MacosAppKitRuntimeTabMenuItem } from
  "./macosAppKitRuntimeTabMenu";

export function macosRuntimeTabMenuLanguage(locale: string): AppLanguage {
  const normalized = locale.replaceAll("_", "-").toLowerCase();
  if (normalized.startsWith("ja")) return "ja";
  if (!normalized.startsWith("zh")) return "en";
  return normalized.includes("hant") ||
    ["-tw", "-hk", "-mo"].some((region) => normalized.includes(region))
    ? "zh-TW"
    : "zh-CN";
}

export function macosRuntimeTabMenuTemplate(
  items: readonly MacosAppKitRuntimeTabMenuItem[]
): MenuItemConstructorOptions[] {
  return items.map((item) => ({
    ...(item.id === undefined ? {} : { id: item.id }),
    ...(item.label === undefined ? {} : { label: item.label }),
    ...(item.type === undefined ? {} : { type: item.type }),
    ...(item.enabled === undefined ? {} : { enabled: item.enabled }),
    ...(item.checked === undefined ? {} : { checked: item.checked }),
    ...(item.click === undefined ? {} : { click: item.click }),
    ...(item.submenu === undefined
      ? {}
      : { submenu: macosRuntimeTabMenuTemplate(item.submenu) })
  }));
}
