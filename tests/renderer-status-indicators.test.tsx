// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Settings } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NavItem } from "../src/renderer/src/components/ui/patterns";
import { Checkbox } from "../src/renderer/src/components/ui/checkbox";
import { Switch } from "../src/renderer/src/components/ui/switch";
import { MacroRoleBadge } from "../src/renderer/src/features/macros/MacroListControls";
import MacrosRoute from "../src/renderer/src/features/macros/MacrosRoute";
import { DEFAULT_MACRO_LIST_SORT } from "../src/renderer/src/features/macros/macroListUtils";
import type { Translator } from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/en.json";
import type { Macro, Role } from "../src/shared/types";

afterEach(cleanup);

describe("renderer status indicators", () => {
  it("uses a floating 30px checkbox target around the compact system-blue visual", () => {
    const onCheckedChange = vi.fn();
    render(
      <Checkbox
        aria-label="Selected"
        checked
        onCheckedChange={onCheckedChange}
      />
    );

    const checkbox = screen.getByRole("checkbox", { name: "Selected" });
    expect(checkbox.className).toContain("size-3.5");
    expect(checkbox.className).not.toContain("size-[var(--control-min-size)]");
    expect(checkbox.getAttribute("data-state")).toBe("checked");
    const visual = checkbox.querySelector<HTMLElement>('[data-slot="checkbox-visual"]');
    expect(visual?.className).toContain("size-3.5");
    expect(visual?.className).toContain("group-data-[state=checked]/checkbox:bg-activity");
    expect(visual?.className).toContain("group-data-[state=checked]/checkbox:border-activity");

    fireEvent.click(checkbox);
    expect(onCheckedChange).toHaveBeenCalledWith(false);
  });

  it("uses a floating 30px switch target without changing its compact visual size", () => {
    const onCheckedChange = vi.fn();
    render(
      <Switch
        aria-label="Enabled"
        checked
        onCheckedChange={onCheckedChange}
      />
    );

    const toggle = screen.getByRole("switch", { name: "Enabled" });
    expect(toggle.className).toContain("h-5");
    expect(toggle.className).toContain("w-9");
    expect(toggle.className).not.toContain("h-[var(--control-min-size)]");
    const track = toggle.firstElementChild;
    expect(track?.className).toContain("h-5");
    expect(track?.className).toContain("w-9");
    expect(track?.className).toContain("bg-activity");
    expect(track?.className).toContain("border-activity/70");
    expect(track?.firstElementChild?.className).toContain("size-3.5");
    expect(track?.firstElementChild?.className).toContain("translate-x-4");

    fireEvent.click(toggle);
    expect(onCheckedChange).toHaveBeenCalledWith(false);
  });

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
    expect(roleDot.className).toContain("bg-activity");
    expect(roleDot.className).not.toContain("opacity-45");
  });

  it("shows the first four execution roles and summarizes the remainder", () => {
    const roles = Array.from({ length: 6 }, (_, index) => role({
      id: `role-${index + 1}`,
      name: `Role ${index + 1}`
    }));

    render(
      <MacroRoleBadge
        macro={macro({ roleIds: roles.map((item) => item.id) })}
        roleById={new Map(roles.map((item) => [item.id, item]))}
        statusByRole={new Map([
          ["role-1", { roleId: "role-1", state: "running" }],
          ["role-5", { roleId: "role-5", state: "running" }]
        ])}
        t={t}
      />
    );

    roles.slice(0, 4).forEach((item) => expect(screen.getByText(item.name)).toBeTruthy());
    roles.slice(4).forEach((item) => expect(screen.queryByText(item.name)).toBeNull());
    const remainderBadge = screen.getByText("+2 more");
    expect(remainderBadge.className).toContain("ui-badge");
    expect(remainderBadge.className).toContain("glass-control");
    expect(screen.getAllByRole("img", { name: "Role active" })).toHaveLength(1);
    expect(screen.getAllByRole("img", { name: "Role inactive" })).toHaveLength(3);
  });

  it("does not show a remainder summary for exactly four execution roles", () => {
    const roles = Array.from({ length: 4 }, (_, index) => role({
      id: `role-${index + 1}`,
      name: `Role ${index + 1}`
    }));

    render(
      <MacroRoleBadge
        macro={macro({ roleIds: roles.map((item) => item.id) })}
        roleById={new Map(roles.map((item) => [item.id, item]))}
        statusByRole={new Map()}
        t={t}
      />
    );

    roles.forEach((item) => expect(screen.getByText(item.name)).toBeTruthy());
    expect(screen.queryByText(/\+\d+ more/)).toBeNull();
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
    expect(updateDot.className).toContain("bg-activity");
    expect(updateDot.className).toContain("ring-activity/15");
  });

  it("moves the macro enabled control into the action menu", () => {
    const onSetMacroEnabled = vi.fn();
    const disabledMacro = { ...macro(), enabled: false };

    render(
      <MacrosRoute
        busyMacroIds={new Set()}
        busyRunKeys={new Set()}
        macros={[disabledMacro]}
        macroStatuses={[]}
        macroStatusByRun={new Map()}
        query=""
        roleFilterId=""
        roles={[role()]}
        scrollPositionRef={{ current: 0 }}
        sort={DEFAULT_MACRO_LIST_SORT}
        statusByRole={new Map([["role-1", { roleId: "role-1", state: "running" }]])}
        t={t}
        onCopyMacro={vi.fn()}
        onDeleteMacro={vi.fn()}
        onDeleteMacros={vi.fn().mockResolvedValue(false)}
        onEditMacro={vi.fn()}
        onNewMacro={vi.fn()}
        onQueryChange={vi.fn()}
        onRoleFilterChange={vi.fn()}
        onSetMacroEnabled={onSetMacroEnabled}
        onSortChange={vi.fn()}
        onStartMacro={vi.fn()}
        onStopMacro={vi.fn()}
      />
    );

    expect(screen.queryByRole("switch", { name: "Enable Auto heal" })).toBeNull();
    const actions = screen.getByRole("button", { name: "Macro actions" });
    const row = actions.closest("tr")!;
    expect(row.getAttribute("data-macro-disabled")).toBe("true");
    expect(row.className).toContain("opacity-[0.55]");
    expect(screen.getByText("Auto heal").closest("button")?.className).toContain("text-muted-foreground");
    fireEvent.click(actions);
    fireEvent.click(screen.getByRole("menuitem", { name: "Enable" }));
    expect(onSetMacroEnabled).toHaveBeenCalledWith(disabledMacro, true);
    expect((screen.getByRole("button", { name: "Start" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the latest macro failure reason in the macro row", () => {
    const failed = {
      roleId: "role-1",
      macroId: "macro-1",
      state: "failed" as const,
      startedAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:01.000Z",
      error: "Embedded browser target is unavailable."
    };
    render(
      <MacrosRoute
        busyMacroIds={new Set()}
        busyRunKeys={new Set()}
        macros={[macro()]}
        macroStatuses={[failed]}
        macroStatusByRun={new Map([["role-1:macro-1", failed]])}
        query=""
        roleFilterId=""
        roles={[role()]}
        scrollPositionRef={{ current: 0 }}
        sort={DEFAULT_MACRO_LIST_SORT}
        statusByRole={new Map([["role-1", { roleId: "role-1", state: "running" }]])}
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

    const failure = screen.getByText(
      "Macro failed: Embedded browser target is unavailable."
    );
    expect(failure.parentElement?.title).toBe(
      "Main role: Embedded browser target is unavailable."
    );
  });

  it("labels an unassigned macro and disables its start action with an assignment hint", () => {
    render(
      <MacrosRoute
        busyMacroIds={new Set()}
        busyRunKeys={new Set()}
        macros={[{ ...macro(), roleIds: [] }]}
        macroStatuses={[]}
        macroStatusByRun={new Map()}
        query=""
        roleFilterId=""
        roles={[role()]}
        scrollPositionRef={{ current: 0 }}
        sort={DEFAULT_MACRO_LIST_SORT}
        statusByRole={new Map([["role-1", { roleId: "role-1", state: "running" }]])}
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

    expect(screen.getByText("No execution roles")).toBeTruthy();
    const start = screen.getByRole("button", { name: "Start" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(start.title).toBe("Assign a role before running this macro.");
    const row = start.closest("tr")!;
    expect(row.getAttribute("data-macro-unassigned")).toBe("true");
    expect(row.className).toContain("bg-warning/35");
    fireEvent.click(screen.getByText("No execution roles"));
    expect(row.className).toContain("bg-warning/35");
    expect(row.className).toContain("[&>td]:border-t-activity/80");
    expect(row.className).toContain("[&>td]:border-b-activity/80");
  });

  it.each(["running", "stopping"] as const)(
    "keeps an active macro row on the activity tone while %s",
    (state) => {
    const running = {
      roleId: "role-1",
      macroId: "macro-1",
      state,
      startedAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:01.000Z"
    };
    render(
      <MacrosRoute
        busyMacroIds={new Set()}
        busyRunKeys={new Set()}
        macros={[macro()]}
        macroStatuses={[running]}
        macroStatusByRun={new Map([["role-1:macro-1", running]])}
        query=""
        roleFilterId=""
        roles={[role()]}
        scrollPositionRef={{ current: 0 }}
        sort={DEFAULT_MACRO_LIST_SORT}
        statusByRole={new Map([["role-1", { roleId: "role-1", state: "running" }]])}
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

    const stop = screen.getByRole("button", { name: "Stop" });
    const row = stop.closest("tr")!;
    expect(row.getAttribute("data-macro-active")).toBe("true");
    expect(row.className).toContain("bg-activity/[0.08]");
    expect((screen.getByText("Auto heal").closest("button") as HTMLButtonElement).disabled).toBe(true);
    expect((stop as HTMLButtonElement).disabled).toBe(state === "stopping");
    }
  );
});

const t: Translator = (key) => en[key];

function role(overrides: Partial<Role> = {}): Role {
  return {
    id: "role-1",
    gameId: "game-1",
    name: "Main role",
    launchUrl: "https://example.test/play",
    notes: "",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    ...overrides
  };
}

function macro(overrides: Partial<Macro> = {}): Macro {
  return {
    id: "macro-1",
    enabled: true,
    name: "Auto heal",
    roleIds: ["role-1"],
    shortcutSourceScope: { type: "all_execution_roles" as const },
    repeat: { type: "once" },
    steps: [{ id: "step-1", type: "key", code: "F2" }],
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    ...overrides
  };
}
