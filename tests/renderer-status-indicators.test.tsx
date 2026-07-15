// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { Settings } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NavItem } from "../src/renderer/src/components/ui/patterns";
import MacrosRoute from "../src/renderer/src/features/macros/MacrosRoute";
import { DEFAULT_MACRO_LIST_SORT } from "../src/renderer/src/features/macros/macroListUtils";
import type { Translator } from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/en.json";
import type { Macro, Role } from "../src/shared/types";

afterEach(cleanup);

describe("renderer status indicators", () => {
  it("shows an active role dot for a running role even when its macro is idle", () => {
    const assignedRole = role();

    render(
      <MacrosRoute
        busyMacroIds={new Set()}
        busyRunKeys={new Set()}
        macros={[macro()]}
        macroStatuses={[]}
        macroStatusByRun={new Map()}
        query=""
        roleFilterId=""
        roles={[assignedRole]}
        scrollPositionRef={{ current: 0 }}
        sort={DEFAULT_MACRO_LIST_SORT}
        statusByRole={new Map([[assignedRole.id, { roleId: assignedRole.id, state: "running" }]])}
        t={t}
        onCopyMacro={vi.fn()}
        onDeleteMacro={vi.fn()}
        onDeleteMacros={vi.fn().mockResolvedValue(false)}
        onEditMacro={vi.fn()}
        onNewMacro={vi.fn()}
        onQueryChange={vi.fn()}
        onRoleFilterChange={vi.fn()}
        onSortChange={vi.fn()}
        onStartMacro={vi.fn()}
        onStopMacro={vi.fn()}
      />
    );

    const roleDot = screen.getByRole("img", { name: "Role active" });
    expect(roleDot.className).toContain("bg-emerald-500");
    expect(roleDot.className).not.toContain("opacity-45");
  });

  it("uses system blue for the settings update indicator", () => {
    render(
      <NavItem
        icon={Settings}
        label="Settings"
        showStatusDot
        statusDotLabel="Update available"
      />
    );

    const updateDot = screen.getByRole("status", { name: "Update available" });
    expect(updateDot.className).toContain("bg-blue-500");
    expect(updateDot.className).toContain("ring-blue-500/15");
  });
});

const t: Translator = (key) => en[key];

function role(): Role {
  return {
    id: "role-1",
    gameId: "game-1",
    name: "Main role",
    launchUrl: "https://example.test/play",
    windowWidth: 1280,
    windowHeight: 720,
    notes: "",
    launchPreset: "performance",
    authState: "authenticated",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z"
  };
}

function macro(): Macro {
  return {
    id: "macro-1",
    name: "Auto heal",
    roleIds: ["role-1"],
    repeat: { type: "once" },
    steps: [{ id: "step-1", type: "key", code: "F2" }],
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z"
  };
}
