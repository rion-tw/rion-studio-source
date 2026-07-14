import type {
  PortableDataSelection,
  PortableImportWarning,
  PortableImportWarningCode
} from "../../../../shared/types";

export type PortableDataSection = keyof PortableDataSelection;
export type PortableDataAvailability = PortableDataSelection;

export function createDefaultPortableDataSelection(
  availability: PortableDataAvailability
): PortableDataSelection {
  return normalizePortableDataSelection(availability, availability);
}

export function clearPortableDataSelection(): PortableDataSelection {
  return {
    roles: false,
    launchWorkspaces: false,
    macros: false,
    preferences: false
  };
}

export function updatePortableDataSelection(
  selection: PortableDataSelection,
  section: PortableDataSection,
  checked: boolean,
  availability: PortableDataAvailability
): PortableDataSelection {
  if (!availability[section]) {
    return selection;
  }

  return normalizePortableDataSelection({ ...selection, [section]: checked }, availability);
}

export function normalizePortableDataSelection(
  selection: PortableDataSelection,
  availability: PortableDataAvailability
): PortableDataSelection {
  const launchWorkspaces = availability.launchWorkspaces && selection.launchWorkspaces;
  const macros = availability.macros && selection.macros;

  return {
    roles: availability.roles && (selection.roles || launchWorkspaces || macros),
    launchWorkspaces,
    macros,
    preferences: availability.preferences && selection.preferences
  };
}

export function isPortableRoleSelectionRequired(selection: PortableDataSelection): boolean {
  return selection.launchWorkspaces || selection.macros;
}

export function hasPortableDataSelection(selection: PortableDataSelection): boolean {
  return selection.roles || selection.launchWorkspaces || selection.macros || selection.preferences;
}

export function filterPortableImportWarnings(
  warnings: PortableImportWarning[],
  selection: PortableDataSelection
): PortableImportWarning[] {
  return warnings.filter((warning) => selection[getPortableWarningSection(warning.code)]);
}

function getPortableWarningSection(code: PortableImportWarningCode): PortableDataSection {
  if (code.startsWith("ROLE_")) {
    return "roles";
  }
  if (code.startsWith("WORKSPACE_")) {
    return "launchWorkspaces";
  }
  return "macros";
}
