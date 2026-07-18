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
  it("uses a 30px checkbox target around the compact system-blue visual", () => {
    const onCheckedChange = vi.fn();
    render(
      <Checkbox
        aria-label="Selected"
        checked
        onCheckedChange={onCheckedChange}
      />
    );

    const checkbox = screen.getByRole("checkbox", { name: "Selected" });
    expect(checkbox.className).toContain("size-[var(--control-min-size)]");
    expect(checkbox.getAttribute("data-state")).toBe("checked");
    const visual = checkbox.querySelector<HTMLElement>('[data-slot="checkbox-visual"]');
    expect(visual?.className).toContain("size-3.5");
    expect(visual?.className).toContain("group-data-[state=checked]/checkbox:bg-blue-500");
    expect(visual?.className).toContain("group-data-[state=checked]/checkbox:border-blue-500");

    fireEvent.click(checkbox);
    expect(onCheckedChange).toHaveBeenCalledWith(false);
  });

  it("uses a 30px switch target without changing its compact visual size", () => {
    const onCheckedChange = vi.fn();
    render(
      <Switch
        aria-label="Enabled"
        checked
        onCheckedChange={onCheckedChange}
      />
    );

    const toggle = screen.getByRole("switch", { name: "Enabled" });
    expect(toggle.className).toContain("h-[var(--control-min-size)]");
    expect(toggle.className).toContain("min-w-9");
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
    authState: "authenticated",
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
