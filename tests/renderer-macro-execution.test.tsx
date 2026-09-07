// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MacroExecutionFields } from "../src/renderer/src/features/macros/MacroExecutionFields";
import { useMacroSourcePicker } from "../src/renderer/src/features/macros/useMacroSourcePicker";
import { createEmptyMacroForm, createMacroFormState } from "../src/renderer/src/features/macros/macroUtils";
import { getMacroListGroups } from "../src/renderer/src/features/macros/macroListUtils";
import { createMacroListRunActionState } from "../src/renderer/src/features/macros/MacroListControls";
import { allowsMacroChainSource, sourceRoleDependencies } from "../src/shared/macroExecution";
import { macroShortcutSourcesOverlap } from "../src/shared/macroShortcuts";
import { toMacroCreateInput, toMacroUpdateInput } from "../src/shared/domainInputs";
import type { MacroFormState } from "../src/renderer/src/app/types";
import type { Translator } from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/en.json";
import type { Macro, Role, RoleStatus } from "../src/shared/types";

const t: Translator = (key) => en[key];
const role: Role = { id: "a", gameId: "game", name: "Role A", launchUrl: "https://example.test", notes: "", createdAt: "", updatedAt: "" };
const dynamic: Macro = { id: "m", name: "Dynamic", enabled: true, executionMode: "source_role", roleIds: [], shortcutSourceScope: { type: "all_roles" }, repeat: { type: "once" }, steps: [{ id: "d", type: "delay", ms: 1000 }], createdAt: "", updatedAt: "" };
const fixed: Macro = { ...dynamic, id: "fixed", name: "Fixed", executionMode: "selected_roles", roleIds: ["a"], shortcutSourceScope: { type: "all_execution_roles" } };
afterEach(cleanup);

describe.each(["mac", "win"])("macro execution on %s", (platform) => {
  it("defaults new forms to a source role and preserves old assignments", () => {
    document.documentElement.dataset.platform = platform;
    expect(createEmptyMacroForm([], [role], t)).toMatchObject({ executionMode: "source_role", roleIds: [], shortcutSourceScope: { type: "all_roles" } });
    expect(createEmptyMacroForm([], [role], t, ["a"])).toMatchObject({ executionMode: "selected_roles", roleIds: ["a"] });
    expect(createMacroFormState({ ...fixed, executionMode: undefined }).executionMode).toBe("selected_roles");
  });

  it("retains the inactive mode's draft and disables segments during save", () => {
    function Editor() {
      const [form, setForm] = useState<MacroFormState>(createMacroFormState(fixed));
      return <><MacroExecutionFields form={form} roles={[role]} games={[]} isSaving={false} t={t} onChange={setForm} /><output>{JSON.stringify(form)}</output></>;
    }
    render(<Editor />);
    fireEvent.click(screen.getByRole("button", { name: "Triggering role" }));
    expect(screen.queryByRole("combobox", { name: "Execution roles" })).toBeNull();
    expect(screen.getByRole("status").textContent).toContain('"type":"all_roles"');
    fireEvent.click(within(screen.getByRole("group", { name: "Execution roles" })).getByRole("button", { name: "Selected roles" }));
    expect(screen.getByRole("status").textContent).toContain('"roleIds":["a"]');
  });

  it("uses a separate dynamic group and permits new roles without changing the macro", () => {
    const options = { macros: [dynamic], roles: [role], query: "", roleFilterId: "future-role", sort: { key: "name" as const, direction: "asc" as const }, t };
    expect(getMacroListGroups(options)[0].key).toBe("source_role");
    const state = createMacroListRunActionState({ macro: dynamic, macroStatusByRun: new Map(), statusByRole: new Map([["a", { roleId: "a", state: "running", automationState: "ready" }]]), busyMacroIds: new Set(), busyRunKeys: new Set(), hasUnassignedDependency: false });
    expect(state.canStart).toBe(true);
  });

  it("keeps source restrictions across bridge conversion and checks chain intersections", () => {
    expect(toMacroCreateInput(dynamic).executionMode).toBe("source_role");
    expect(toMacroUpdateInput(dynamic).executionMode).toBe("source_role");
    expect(macroShortcutSourcesOverlap(dynamic, fixed)).toBe(true);
    const child = { ...dynamic, shortcutSourceScope: { type: "selected_roles" as const, roleIds: ["b"] } };
    const parent = { ...fixed, steps: [{ id: "call", type: "macro" as const, macroId: child.id }] };
    expect(sourceRoleDependencies([parent, child], parent.id)).toEqual([child]);
    expect(allowsMacroChainSource([parent, child], parent, "a")).toBe(false);
  });
});

it("cancels all pending starts and shows when no eligible role exists", async () => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value() { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value() { this.open = false; } });
  const settled = vi.fn();
  function Picker() {
    const picker = useMacroSourcePicker([dynamic], [role], new Map<string, RoleStatus>(), t);
    return <><button onClick={() => { void picker.pick([dynamic]).then(settled); }}>Choose</button>{picker.dialog}</>;
  }
  render(<Picker />);
  fireEvent.click(screen.getByRole("button", { name: "Choose" }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText(en["macros.sourcePicker.empty"])).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "Run" }).hasAttribute("disabled")).toBe(true);
  await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" })));
  expect(settled).toHaveBeenCalledWith(null);
});

it("collects every batch source before submitting and revalidates a closed role", async () => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value() { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value() { this.open = false; } });
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", { configurable: true, value: () => false });
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { configurable: true, value: () => undefined });
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", { configurable: true, value: () => undefined });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => undefined });
  const user = (await import("@testing-library/user-event")).default.setup();
  const second = { ...dynamic, id: "second", name: "Second" };
  const settled = vi.fn();
  const ready = new Map<string, RoleStatus>([["a", { roleId: "a", state: "running", automationState: "ready" }]]);
  function Picker({ statuses }: { statuses: Map<string, RoleStatus> }) {
    const picker = useMacroSourcePicker([dynamic, second], [role], statuses, t);
    return <><button onClick={() => { void picker.pick([dynamic, second]).then(settled); }}>Choose</button>{picker.dialog}</>;
  }
  const view = render(<Picker statuses={ready} />);
  await user.click(screen.getByRole("button", { name: "Choose" }));
  for (const name of [dynamic.name, second.name]) {
    await user.click(screen.getByRole("combobox", { name }));
    const option = screen.getByRole("option", { name: role.name });
    expect(option.closest("dialog")).toBe(screen.getByRole("dialog"));
    await user.click(option);
  }
  expect(settled).not.toHaveBeenCalled();
  view.rerender(<Picker statuses={new Map()} />);
  expect(screen.getByRole("button", { name: "Run" }).hasAttribute("disabled")).toBe(true);
  view.rerender(<Picker statuses={ready} />);
  await user.click(screen.getByRole("button", { name: "Run" }));
  expect(settled).toHaveBeenCalledWith({ m: "a", second: "a" });
});

it("retains each mode's selected-source draft even after choosing all roles", () => {
  function Editor() {
    const [form, setForm] = useState<MacroFormState>(createMacroFormState({ ...dynamic, shortcutSourceScope: { type: "selected_roles", roleIds: ["a"] } }));
    return <><MacroExecutionFields form={form} roles={[role]} games={[]} isSaving={false} t={t} onChange={setForm} /><output>{JSON.stringify(form)}</output></>;
  }
  render(<Editor />);
  fireEvent.click(screen.getByRole("button", { name: "All roles" }));
  const mode = screen.getByRole("group", { name: "Execution roles" });
  fireEvent.click(within(mode).getByRole("button", { name: "Selected roles" }));
  fireEvent.click(within(mode).getByRole("button", { name: "Triggering role" }));
  fireEvent.click(within(screen.getByRole("group", { name: "Effective scope" })).getByRole("button", { name: "Selected roles" }));
  expect(screen.getByRole("status").textContent).toContain('"shortcutSourceScope":{"type":"selected_roles","roleIds":["a"]}');
});

it("prevents changing execution mode while saving", () => {
  const onChange = vi.fn();
  render(<MacroExecutionFields form={createMacroFormState(dynamic)} games={[]} roles={[role]} isSaving t={t} onChange={onChange} />);
  const buttons = within(screen.getByRole("group", { name: "Execution roles" })).getAllByRole("button");
  for (const button of buttons) { expect(button.hasAttribute("disabled")).toBe(true); fireEvent.click(button); }
  expect(onChange).not.toHaveBeenCalled();
});
