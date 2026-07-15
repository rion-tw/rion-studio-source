import { describe, expect, it } from "vitest";

import {
  DEFAULT_MACRO_LIST_SORT,
  getMacroListItems,
  type MacroListSortState
} from "../src/renderer/src/features/macros/macroListUtils";
import type { Translator } from "../src/renderer/src/i18n";
import type { Macro, Role } from "../src/shared/types";

const translations: Partial<Record<Parameters<Translator>[0], string>> = {
  "macro.step.delay": "Delay",
  "macro.step.key": "Key",
  "macros.noShortcut": "No shortcut",
  "macros.repeat.loop": "Every {ms} ms",
  "macros.repeat.once": "Once",
  "macros.steps.more": "+{count} more",
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

  it("defaults to role order, then name, created time, and original order", () => {
    const roles = [role({ id: "role-2", name: "Second" }), role({ id: "role-1", name: "First" })];
    const macros = [
      macro({
        id: "role-1-alpha",
        name: "Alpha",
        roleIds: ["role-1"],
        createdAt: "2026-01-01T00:00:00.000Z"
      }),
      macro({
        id: "role-2-beta",
        name: "Beta",
        roleIds: ["role-2"],
        createdAt: "2026-01-01T00:00:00.000Z"
      }),
      macro({
        id: "role-2-alpha-new",
        name: "Alpha",
        roleIds: ["role-2"],
        createdAt: "2026-01-02T00:00:00.000Z"
      }),
      macro({
        id: "role-2-alpha-old",
        name: "Alpha",
        roleIds: ["role-2"],
        createdAt: "2026-01-01T00:00:00.000Z"
      })
    ];

    expect(listIds({ macros, roles })).toEqual([
      "role-2-alpha-old",
      "role-2-alpha-new",
      "role-2-beta",
      "role-1-alpha"
    ]);
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
    windowWidth: 1280,
    windowHeight: 720,
    notes: "",
    launchPreset: "performance",
    authState: "unknown",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function macro(overrides: Partial<Macro>): Macro {
  return {
    id: "macro",
    name: "Macro",
    roleIds: [],
    repeat: { type: "once" },
    steps: [{ id: "step", type: "key", code: "Tab", label: "Tab" }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}
