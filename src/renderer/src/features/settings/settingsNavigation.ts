import { getEditorParentPath, normalizeAppReturnTo } from "../../app/editorNavigation";

export const settingsSectionIds = [
  "preferences",
  "graphics",
  "interface",
  "macros",
  "data",
  "updates",
  "diagnostics",
  "aboutLegal"
] as const;

export type SettingsSectionId = (typeof settingsSectionIds)[number];

export const settingsSectionQueryValues: Record<SettingsSectionId, string> = {
  aboutLegal: "about-legal",
  data: "data",
  interface: "interface",
  macros: "macros",
  preferences: "preferences",
  graphics: "graphics",
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

  return "preferences";
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

// Opening Settings from inside Settings keeps the original application page.
export function createSettingsNavigationState(location: {
  pathname: string;
  search: string;
  state: unknown;
}): { returnTo: string } {
  return {
    returnTo: location.pathname.startsWith("/settings")
      ? readSettingsReturnTo(location.state)
      : normalizeAppReturnTo(location.pathname, location.search)
  };
}
