import { describe, expect, it } from "vitest";

import {
  DEFAULT_MACRO_LIST_SORT,
  getMacroListGroups,
  getMacroListItems,
  type MacroListSortState
} from "../src/renderer/src/features/macros/macroListUtils";
import type { Translator } from "../src/renderer/src/i18n";
import type { Macro, Role } from "../src/shared/types";

const translations: Partial<Record<Parameters<Translator>[0], string>> = {
  "macro.step.delay": "Delay",
  "macro.step.hold": "Hold",
  "macro.step.key": "Key",
  "macro.step.macro": "Run macro",
  "macroForm.activation.toggle": "Tap to toggle",
  "macroForm.activation.whileHeld": "Tap or hold",
  "macros.noShortcut": "No shortcut",
  "macros.noRoles": "Unassigned role",
  "macros.repeat.loop": "Every {ms} ms",
  "macros.repeat.once": "Once",
  "macros.steps.more": "+{count} more",
  "macros.unknownMacro": "Unknown macro",
  "macros.unknownRole": "Unknown role"
};

const t: Translator = (key) => translations[key] ?? key;

describe("renderer macro list helpers", () => {
  it("filters macros by assigned role, including multi-role macros", () => {
    const roles = [role({ id: "role-1", name: "Main" }), role({ id: "role-2", name: "Alt" })];
    const macros = [
      macro({ id: "heal", name: "Heal", roleIds: ["role-1"] }),
      macro({ id: "shared", name: "Shared buff", roleIds: ["role-1", "role-2"] }),
      macro({ id: "solo", name: "Solo", roleIds: ["role-3"] })
    ];

    expect(listIds({ macros, roleFilterId: "role-2", roles })).toEqual(["shared"]);
    expect(listIds({ macros, query: "alt", roles })).toEqual(["shared"]);
  });

  it("searches shortcut source role names without changing the execution-role filter", () => {
    const roles = [
      role({ id: "role-1", name: "Executor" }),
      role({ id: "role-controller", name: "Controller" })
    ];
    const controlled = macro({
      id: "controlled",
      roleIds: ["role-1"],
      shortcutSourceScope: { type: "selected_roles", roleIds: ["role-controller"] }
    });

    expect(listIds({ macros: [controlled], query: "controller", roles })).toEqual(["controlled"]);
    expect(listIds({ macros: [controlled], roleFilterId: "role-controller", roles })).toEqual([]);
    expect(listIds({ macros: [controlled], roleFilterId: "role-1", roles })).toEqual(["controlled"]);
  });

  it("searches tap-or-hold activation and held-key summaries", () => {
    const roles = [role({ id: "role-1", name: "Main" })];
    const held = macro({
      id: "held",
      activationMode: "while_held",
      roleIds: ["role-1"],
      shortcutSourceScope: { type: "all_execution_roles" as const },
      steps: [{ id: "hold", type: "key", code: "KeyW", action: "hold_until_stop" }]
    });

    expect(listIds({ macros: [held], query: "tap or hold", roles })).toEqual(["held"]);
    expect(listIds({ macros: [held], query: "hold:w", roles })).toEqual(["held"]);
  });

  it("searches unassigned macros by their displayed role label and sorts them last", () => {
    const roles = [role({ id: "role-1", name: "Main" })];
    const assigned = macro({ id: "assigned", roleIds: ["role-1"] });
    const unassigned = macro({ id: "unassigned", roleIds: [] });

    expect(listIds({ macros: [unassigned, assigned], query: "unassigned role", roles })).toEqual([
      "unassigned"
    ]);
    expect(listIds({ macros: [unassigned, assigned], roles })).toEqual(["assigned", "unassigned"]);
  });

  it("defaults to name, then role order, created time, and original order", () => {
    const roles = [role({ id: "role-2", name: "Second" }), role({ id: "role-1", name: "First" })];
    const macros = [
      macro({
        id: "role-1-alpha",
        name: "Alpha",
        roleIds: ["role-1"],
        shortcutSourceScope: { type: "all_execution_roles" as const },
        createdAt: "2026-01-01T00:00:00.000Z"
      }),
      macro({
        id: "role-2-beta",
        name: "Beta",
        roleIds: ["role-2"],
        shortcutSourceScope: { type: "all_execution_roles" as const },
        createdAt: "2026-01-01T00:00:00.000Z"
      }),
      macro({
        id: "role-2-alpha-new",
        name: "Alpha",
        roleIds: ["role-2"],
        shortcutSourceScope: { type: "all_execution_roles" as const },
        createdAt: "2026-01-02T00:00:00.000Z"
      }),
      macro({
        id: "role-2-alpha-old",
        name: "Alpha",
        roleIds: ["role-2"],
        shortcutSourceScope: { type: "all_execution_roles" as const },
        createdAt: "2026-01-01T00:00:00.000Z"
      })
    ];

    expect(listIds({ macros, roles })).toEqual([
      "role-2-alpha-old",
      "role-2-alpha-new",
      "role-1-alpha",
      "role-2-beta"
    ]);
  });

  it("groups by canonical execution-role sets without duplicating multi-role macros", () => {
    const roles = [role({ id: "role-2", name: "Second" }), role({ id: "role-1", name: "First" })];
    const macros = [
      macro({ id: "first", name: "First only", roleIds: ["role-1"] }),
      macro({ id: "second", name: "Second only", roleIds: ["role-2"] }),
      macro({ id: "shared-a", name: "Shared A", roleIds: ["role-1", "role-2"] }),
      macro({ id: "shared-b", name: "Shared B", roleIds: ["role-2", "role-1"] }),
      macro({ id: "unknown", name: "Unknown", roleIds: ["missing-role"] }),
      macro({ id: "unassigned", name: "Unassigned", roleIds: [] })
    ];

    const groups = getMacroListGroups({
      macros,
      query: "",
      roleFilterId: "",
      roles,
      sort: DEFAULT_MACRO_LIST_SORT,
      t
    });

    expect(groups.map((group) => ({
      macroIds: group.macros.map((item) => item.id),
      roleIds: group.roleIds
    }))).toEqual([
      { macroIds: ["second"], roleIds: ["role-2"] },
      { macroIds: ["shared-a", "shared-b"], roleIds: ["role-2", "role-1"] },
      { macroIds: ["first"], roleIds: ["role-1"] },
      { macroIds: ["unknown"], roleIds: ["missing-role"] },
      { macroIds: ["unassigned"], roleIds: [] }
    ]);
    expect(groups.flatMap((group) => group.macros).map((item) => item.id)).toHaveLength(macros.length);
  });

  it("applies role filters and search before grouping", () => {
    const roles = [role({ id: "role-1", name: "Main" }), role({ id: "role-2", name: "Alt" })];
    const macros = [
      macro({ id: "main", name: "Heal", roleIds: ["role-1"] }),
      macro({ id: "shared", name: "Shared shield", roleIds: ["role-1", "role-2"] }),
      macro({ id: "alt", name: "Alt attack", roleIds: ["role-2"] })
    ];

    const groups = getMacroListGroups({
      macros,
      query: "shield",
      roleFilterId: "role-2",
      roles,
      sort: DEFAULT_MACRO_LIST_SORT,
      t
    });

    expect(groups).toHaveLength(1);
    expect(groups[0].roleIds).toEqual(["role-1", "role-2"]);
    expect(groups[0].macros.map((item) => item.id)).toEqual(["shared"]);
  });

  it("sorts by the selected column in ascending or descending order", () => {
    const roles = [role({ id: "role-1", name: "Main" })];
    const macros = [
      macro({ id: "charlie", name: "Charlie", roleIds: ["role-1"] }),
      macro({ id: "alpha", name: "Alpha", roleIds: ["role-1"] }),
      macro({ id: "bravo", name: "Bravo", roleIds: ["role-1"] })
    ];

    expect(listIds({ macros, roles, sort: { direction: "asc", key: "name" } })).toEqual([
      "alpha",
      "bravo",
      "charlie"
    ]);
    expect(listIds({ macros, roles, sort: { direction: "desc", key: "name" } })).toEqual([
      "charlie",
      "bravo",
      "alpha"
    ]);
  });
});

function listIds({
  macros,
  query = "",
  roleFilterId = "",
  roles,
  sort = DEFAULT_MACRO_LIST_SORT
}: {
  macros: Macro[];
  query?: string;
  roleFilterId?: string;
  roles: Role[];
  sort?: MacroListSortState;
}): string[] {
  return getMacroListItems({
    macros,
    query,
    roleFilterId,
    roles,
    sort,
    t
  }).map((item) => item.id);
}

function role(overrides: Partial<Role>): Role {
  return {
    id: "role",
    gameId: "game-1",
    name: "Role",
    launchUrl: "https://example.test/play",
    notes: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function macro(overrides: Partial<Macro>): Macro {
  return {
    id: "macro",
    enabled: true,
    name: "Macro",
    roleIds: [],
    shortcutSourceScope: { type: "all_execution_roles" as const },
    repeat: { type: "once" },
    steps: [{ id: "step", type: "key", code: "Tab", label: "Tab" }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}
