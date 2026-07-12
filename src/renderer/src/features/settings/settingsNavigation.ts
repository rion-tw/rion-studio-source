export const settingsSectionIds = ["appearance", "preferences", "role-defaults", "updates"] as const;

export type SettingsSectionId = (typeof settingsSectionIds)[number];

export const settingsSectionElementIds: Record<SettingsSectionId, string> = {
  appearance: "settings-appearance",
  preferences: "settings-preferences",
  "role-defaults": "settings-role-defaults",
  updates: "settings-updates"
};

export function readSettingsSection(value: string | null): SettingsSectionId {
  return settingsSectionIds.includes(value as SettingsSectionId) ? (value as SettingsSectionId) : "appearance";
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
    return state.returnTo;
  }

  return "/roles";
}
