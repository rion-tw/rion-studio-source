export const settingsSectionIds = ["interface", "game", "data", "updates"] as const;

export type SettingsSectionId = (typeof settingsSectionIds)[number];

const legacySectionAliases: Partial<Record<string, SettingsSectionId>> = {
  appearance: "interface",
  portability: "data",
  preferences: "interface",
  "role-defaults": "game"
};

export const settingsSectionQueryValues: Record<SettingsSectionId, string> = {
  data: "data",
  game: "game",
  interface: "interface",
  updates: "updates"
};

export function readSettingsSection(value: string | null): SettingsSectionId {
  if (settingsSectionIds.includes(value as SettingsSectionId)) {
    return value as SettingsSectionId;
  }

  return value ? legacySectionAliases[value] ?? "interface" : "interface";
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

  return "/dashboard";
}
