// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Settings } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NavItem } from "../src/renderer/src/components/ui/patterns";
import { Checkbox } from "../src/renderer/src/components/ui/checkbox";
import { Switch } from "../src/renderer/src/components/ui/switch";
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
    expect(visual?.className).toContain("group-data-[state=checked]/checkbox:bg-blue-500");
    expect(visual?.className).toContain("group-data-[state=checked]/checkbox:border-blue-500");

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
    expect(track?.className).toContain("bg-blue-500");
    expect(track?.className).toContain("border-blue-500/70");
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

  it("exposes a switch for enabling a disabled macro", () => {
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

    const toggle = screen.getByRole("switch", { name: "Enable Auto heal" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    const layout = toggle.closest("[data-macro-enabled-control]");
    expect(layout?.className).toContain("place-items-center");
    expect(layout?.parentElement?.className).toContain("absolute");
    expect(layout?.parentElement?.className).toContain("inset-0");
    fireEvent.click(toggle);
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

    expect(screen.getByText("Unassigned role")).toBeTruthy();
    const start = screen.getByRole("button", { name: "Start" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(start.title).toBe("Assign a role before running this macro.");
  });
});

const t: Translator = (key) => en[key];

function role(): Role {
  return {
    id: "role-1",
    gameId: "game-1",
    name: "Main role",
    launchUrl: "https://example.test/play",
    notes: "",
    browserZoomPercent: 100,
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z"
  };
}

function macro(): Macro {
  return {
    id: "macro-1",
    enabled: true,
    name: "Auto heal",
    roleIds: ["role-1"],
    repeat: { type: "once" },
    steps: [{ id: "step-1", type: "key", code: "F2" }],
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z"
  };
}
