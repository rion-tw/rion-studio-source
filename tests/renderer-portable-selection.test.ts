import { describe, expect, it } from "vitest";

import {
  clearPortableDataSelection,
  createDefaultPortableDataSelection,
  filterPortableImportWarnings,
  hasPortableDataSelection,
  isPortableGameSelectionRequired,
  isPortableRoleSelectionRequired,
  updatePortableDataSelection
} from "../src/renderer/src/features/settings/portableSelection";
import type { PortableDataSelection, PortableImportWarning } from "../src/shared/types";

const ALL_AVAILABLE: PortableDataSelection = {
  games: true,
  roles: true,
  launchWorkspaces: true,
  macros: true,
  preferences: true
};

describe("portable data selection", () => {
  it("selects every available category and leaves empty categories disabled", () => {
    expect(
      createDefaultPortableDataSelection({
        games: true,
        roles: true,
        launchWorkspaces: false,
        macros: true,
        preferences: false
      })
    ).toEqual({
      games: true,
      roles: true,
      launchWorkspaces: false,
      macros: true,
      preferences: false
    });
  });

  it("automatically selects and locks roles while workspaces or macros are selected", () => {
    const selection = updatePortableDataSelection(
      clearPortableDataSelection(),
      "launchWorkspaces",
      true,
      ALL_AVAILABLE
    );

    expect(selection).toEqual({
      games: true,
      roles: true,
      launchWorkspaces: true,
      macros: false,
      preferences: false
    });
    expect(isPortableRoleSelectionRequired(selection)).toBe(true);
    expect(updatePortableDataSelection(selection, "roles", false, ALL_AVAILABLE).roles).toBe(true);
    expect(isPortableGameSelectionRequired(selection)).toBe(true);
    expect(updatePortableDataSelection(selection, "games", false, ALL_AVAILABLE).games).toBe(true);
  });

  it("allows roles to be cleared after dependent categories are cleared", () => {
    const selected = createDefaultPortableDataSelection(ALL_AVAILABLE);
    const withoutWorkspaces = updatePortableDataSelection(
      selected,
      "launchWorkspaces",
      false,
      ALL_AVAILABLE
    );
    const withoutDependencies = updatePortableDataSelection(
      withoutWorkspaces,
      "macros",
      false,
      ALL_AVAILABLE
    );
    const rolesCleared = updatePortableDataSelection(
      withoutDependencies,
      "roles",
      false,
      ALL_AVAILABLE
    );

    expect(isPortableRoleSelectionRequired(rolesCleared)).toBe(false);
    expect(rolesCleared.roles).toBe(false);
  });

  it("detects an empty selection", () => {
    expect(hasPortableDataSelection(clearPortableDataSelection())).toBe(false);
    expect(hasPortableDataSelection({ ...clearPortableDataSelection(), games: true })).toBe(true);
    expect(hasPortableDataSelection({ ...clearPortableDataSelection(), preferences: true })).toBe(true);
  });

  it("shows warnings only for selected categories", () => {
    const warnings: PortableImportWarning[] = [
      { code: "GAME_NAME_RENAMED", itemName: "Flyff" },
      { code: "ROLE_GAME_RECOVERED", itemName: "Recovered" },
      { code: "ROLE_NAME_RENAMED", itemName: "Main" },
      { code: "WORKSPACE_ROLE_MISSING", itemName: "Party" },
      { code: "MACRO_SHORTCUT_CLEARED_RESERVED", itemName: "Heal" }
    ];

    expect(
      filterPortableImportWarnings(warnings, {
        games: true,
        roles: true,
        launchWorkspaces: false,
        macros: false,
        preferences: true
      })
    ).toEqual([warnings[0], warnings[1], warnings[2]]);
  });
});
