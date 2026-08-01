import { getEditorParentPath } from "../../app/editorNavigation";

export const settingsSectionIds = ["interface", "network", "macros", "data", "updates", "diagnostics", "aboutLegal"] as const;

export type SettingsSectionId = (typeof settingsSectionIds)[number];

export const settingsSectionQueryValues: Record<SettingsSectionId, string> = {
  aboutLegal: "about-legal",
  data: "data",
  interface: "interface",
  macros: "macros",
  network: "network",
  updates: "updates",
  diagnostics: "diagnostics"
};

export function readSettingsSection(value: string | null): SettingsSectionId {
  if (value === "about-legal") {
    return "aboutLegal";
  }

  if (settingsSectionIds.includes(value as SettingsSectionId)) {
    return value as SettingsSectionId;
  }

  return "interface";
}

export function readSettingsReturnTo(state: unknown): string {
  if (
    state &&
    typeof state === "object" &&
    "returnTo" in state &&
    typeof state.returnTo === "string" &&
    state.returnTo.startsWith("/") &&
    !state.returnTo.startsWith("/settings")
  ) {
    const [pathname] = state.returnTo.split("?");
    return getEditorParentPath(pathname) ?? state.returnTo;
  }

  return "/dashboard";
}
