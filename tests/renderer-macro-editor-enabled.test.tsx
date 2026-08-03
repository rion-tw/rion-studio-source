// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ConfirmationProvider } from "../src/renderer/src/components/ConfirmationDialog";
import type { MacroFormState } from "../src/renderer/src/app/types";
import MacroEditorRoute from "../src/renderer/src/features/macros/MacroModal";
import type { Translator } from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/en.json";
import { MACRO_DELAY_MAX_MS as _MACRO_DELAY_MAX_MS } from "../src/shared/macroSettings";
import type { Game, Macro, Role } from "../src/shared/types";

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class ResizeObserver {
    disconnect(): void {}
    observe(): void {}
    unobserve(): void {}
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => undefined
  });
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: vi.fn()
  });
});

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.platform;
  vi.mocked(document.elementFromPoint).mockReset();
});
afterAll(() => vi.unstubAllGlobals());

describe("macro editor controls", () => {
it.each([
    {
      entry: "/macros/macro-1/edit",
      macros: [macro()],
      routePath: "/macros/:id/edit",
      state: "editing"
    },
    {
      entry: "/macros/new",
      macros: [],
      routePath: "/macros/new",
      state: "creating"
    }
  ])("shows complete macro help when $state", ({ entry, macros, routePath }) => {
    const router = createMemoryRouter([
      {
        path: routePath,
        element: <MacroEditorRoute
          games={[game()]}
          isSaving={false}
          macros={macros}
          roles={[role()]}
          t={t}
          onSave={vi.fn(async () => undefined)}
        />
      }
    ], { initialEntries: [entry] });

    const { container } = render(
      <ConfirmationProvider><RouterProvider router={router} /></ConfirmationProvider>
    );
    const helpList = container.querySelector<HTMLElement>("[data-macro-help-list]");
    const macroHelps = container.querySelectorAll<HTMLElement>("[data-macro-help]");

    expect(helpList?.className).toContain("editor-layout-macro-help");
    expect(macroHelps).toHaveLength(3);
    expect(macroHelps[0].getAttribute("data-macro-help")).toBe("activation");
    expect(macroHelps[1].getAttribute("data-macro-help")).toBe("calls");
    expect(macroHelps[2].getAttribute("data-macro-help")).toBe("stop");
    expect(macroHelps[0].textContent).toContain("Starting and repeating");
    expect(macroHelps[0].textContent).toContain("every assigned role that is launched and controllable");
    expect(macroHelps[0].textContent).toContain("do not become execution roles or receive macro steps");
    expect(macroHelps[0].textContent).toContain("Tap to toggle switches between starting and stopping");
    expect(macroHelps[0].textContent).toContain("0 ms interval removes only the extra wait");
    expect(macroHelps[1].textContent).toContain("Running other macros");
    expect(macroHelps[1].textContent).toContain("uses its own assigned roles");
    expect(macroHelps[1].textContent).toContain("Wait for completion runs the child macro once");
    expect(macroHelps[1].textContent).toContain("Interrupting the parent stops its triggered descendants");
    expect(macroHelps[1].textContent).toContain("when the parent completes normally");
    expect(macroHelps[1].textContent).toContain("already running does not start or create another run");
    expect(macroHelps[2].textContent).toContain("Stopping and held keys");
    expect(macroHelps[2].textContent).toContain("releases keys held by that macro");
    expect(macroHelps[2].textContent).toContain("cancels the parent");
    expect(macroHelps[2].textContent).toContain("does not stop the parent");
    expect(macroHelps[2].textContent).toContain("Closing any participating role stops the entire multi-role macro run");
    expect([...macroHelps].map((help) => help.querySelectorAll("li").length)).toEqual([4, 4, 3]);
    macroHelps.forEach((macroHelp) => {
      expect(macroHelp.querySelector("svg")).toBeNull();
      expect(macroHelp.querySelectorAll("section")).toHaveLength(1);
      expect(macroHelp.querySelector("section")?.className).toContain("max-w-[72ch]");
      expect(macroHelp.className).toContain("rounded-md");
      expect(macroHelp.className).toContain("p-4");
    });
    expect(macroHelps[2].parentElement?.lastElementChild).toBe(macroHelps[2]);
  });

it.each(["darwin", "win32"] as const)("reorders steps with pointer dragging on %s", (platform) => {
    document.documentElement.dataset.platform = platform === "darwin" ? "mac" : "windows";
    const selectedMacro = macro({
      steps: [
        { id: "step-1", type: "key", code: "F2" },
        { id: "step-2", type: "delay", ms: 500 },
        { id: "step-3", type: "click", xPercent: 33, yPercent: 66 }
      ]
    });
    const router = createMemoryRouter(
      [
        {
          path: "/macros/:id/edit",
          element: <MacroEditorRoute
            games={[game()]}
            isSaving={false}
            macros={[selectedMacro]}
            roles={[role()]}
            t={t}
            onSave={vi.fn()}
          />
        }
      ],
      { initialEntries: ["/macros/macro-1/edit"] }
    );

    render(
      <ConfirmationProvider>
        <RouterProvider router={router} />
      </ConfirmationProvider>
    );

    const getStepTypeSelectors = (): HTMLElement[] => (
      screen.getAllByTestId(/^macro-step-/).map((stepRow) =>
        within(stepRow).getByRole("combobox", { name: "Step type" })
      )
    );
    const stepTypeSelectors = getStepTypeSelectors();
    if (stepTypeSelectors.length !== 3) {
      throw new Error(`Unexpected number of step rows: ${stepTypeSelectors.length}`);
    }
    expect(stepTypeSelectors.map((select) => select.textContent?.trim())).toEqual(["Key", "Delay", "Click"]);

    const dragHandle = screen.getAllByRole("button", { name: "Drag to reorder" })[2];
    const targetRow = screen.getByTestId("macro-step-step-1");
    vi.mocked(document.elementFromPoint).mockReturnValue(targetRow);

    fireEvent.pointerDown(dragHandle, {
      button: 0,
      clientX: 20,
      clientY: 300,
      isPrimary: true,
      pointerId: 7
    });
    fireEvent.pointerMove(window, {
      clientX: 20,
      clientY: 200,
      isPrimary: true,
      pointerId: 7
    });
    fireEvent.pointerUp(window, {
      clientX: 20,
      clientY: 200,
      isPrimary: true,
      pointerId: 7
    });
    expect(getStepTypeSelectors().map((select) =>
      select.textContent?.trim()
    )).toEqual(["Click", "Key", "Delay"]);
    expect(dragHandle.hasAttribute("draggable")).toBe(false);
  });

it("saves edits to an existing unassigned macro without requiring reassignment", async () => {
    const unassignedMacro = macro({ roleIds: [] });
    const onSave = vi.fn(async (form: MacroFormState): Promise<Macro> => ({
      ...unassignedMacro,
      ...form,
      updatedAt: "2026-07-16T00:00:00.000Z"
    }));
    const router = createMemoryRouter([
      {
        path: "/macros/:id/edit",
        element: <MacroEditorRoute
          games={[game()]}
          isSaving={false}
          macros={[unassignedMacro]}
          roles={[role()]}
          t={t}
          onSave={onSave}
        />
      },
      { path: "/macros", element: <div>Macro list</div> }
    ], { initialEntries: ["/macros/macro-1/edit"] });

    render(<ConfirmationProvider><RouterProvider router={router} /></ConfirmationProvider>);

    expect(screen.getByText("This macro will remain unavailable until a role is assigned.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      id: unassignedMacro.id,
      roleIds: []
    })));
  });

it("loads a disabled macro and includes the changed enabled state when saving", async () => {
    const disabledMacro = macro({ enabled: false });
    const onSave = vi.fn(async (form: MacroFormState): Promise<Macro> => ({
      ...disabledMacro,
      ...form,
      updatedAt: "2026-07-16T00:00:00.000Z"
    }));
    const router = createMemoryRouter(
      [
        {
          path: "/macros/:id/edit",
          element: (
            <MacroEditorRoute
              games={[game()]}
              isSaving={false}
              macros={[disabledMacro]}
              roles={[role()]}
              t={t}
              onSave={onSave}
            />
          )
        },
        { path: "/macros", element: <div>Macro list</div> }
      ],
      { initialEntries: ["/macros/macro-1/edit"] }
    );

    render(
      <ConfirmationProvider>
        <RouterProvider router={router} />
      </ConfirmationProvider>
    );

    const toggle = screen.getByRole("switch", { name: "Enabled" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
        id: disabledMacro.id,
        enabled: true
      }));
    });
  });

it("shows held macro targets as available while preserving dependency reasons", () => {
    const loopingTarget = macro({
      id: "macro-loop",
      name: "Loop target",
      repeat: { type: "loop", intervalMs: 100 }
    });
    const selectedMacro = macro({
      steps: [{ id: "call-loop", type: "macro", macroId: loopingTarget.id }]
    });
    const heldTarget = macro({
      id: "macro-held",
      name: "Held target",
      steps: [{ id: "hold", type: "key", code: "KeyW", action: "hold_until_stop" }]
    });
    const cycleTarget = macro({
      id: "macro-cycle",
      name: "Cycle target",
      steps: [{ id: "call-current", type: "macro", macroId: selectedMacro.id }]
    });
    const disabledTarget = macro({
      id: "macro-disabled",
      enabled: false,
      name: "Disabled target"
    });
    const router = createMemoryRouter([
      {
        path: "/macros/:id/edit",
        element: <MacroEditorRoute
          games={[game()]}
          isSaving={false}
          macros={[selectedMacro, loopingTarget, heldTarget, cycleTarget, disabledTarget]}
          roles={[role()]}
          t={t}
          onSave={vi.fn()}
        />
      }
    ], { initialEntries: ["/macros/macro-1/edit"] });

    render(<ConfirmationProvider><RouterProvider router={router} /></ConfirmationProvider>);

    const trigger = screen.getByRole("combobox", { name: "Macro to run" });
    expect(trigger.textContent).toContain("Loop target (runs one iteration when called)");
    const callMode = screen.getByRole("combobox", { name: "Macro call mode" });
    expect(callMode.textContent).toContain("Wait for completion");
    fireEvent.click(callMode);
    fireEvent.click(screen.getByRole("option", { name: "Trigger and continue" }));
    expect(callMode.textContent).toContain("Trigger and continue");
    fireEvent.click(trigger);

    const loopOption = screen.getByRole("option", {
      name: "Loop target (runs with its loop setting when triggered)"
    });
    const selfOption = screen.getByRole("option", { name: "Auto heal (current macro)" });
    const heldOption = screen.getByRole("option", { name: "Held target" });
    const cycleOption = screen.getByRole("option", {
      name: "Cycle target (would create a dependency cycle)"
    });
    const disabledOption = screen.getByRole("option", { name: "Disabled target (disabled)" });

    expect(loopOption.hasAttribute("data-disabled")).toBe(false);
    expect(selfOption.hasAttribute("data-disabled")).toBe(true);
    expect(heldOption.hasAttribute("data-disabled")).toBe(false);
    expect(cycleOption.hasAttribute("data-disabled")).toBe(true);
    expect(disabledOption.hasAttribute("data-disabled")).toBe(false);
  });

it("saves a referenced macro with while-held activation and a hold-until-stop key action", async () => {
    const selectedMacro = macro({
      trigger: { code: "F6", ctrl: false, alt: false, shift: false, meta: false },
      steps: [{ id: "step-1", type: "key", code: "F2", action: "hold_until_stop" }]
    });
    const parentMacro = macro({
      id: "macro-parent",
      name: "Parent",
      steps: [{ id: "call", type: "macro", macroId: selectedMacro.id }]
    });
    const onSave = vi.fn(async (form: MacroFormState): Promise<Macro> => ({
      ...selectedMacro,
      ...form,
      updatedAt: "2026-07-16T00:00:00.000Z"
    }));
    const router = createMemoryRouter([
      {
        path: "/macros/:id/edit",
        element: <MacroEditorRoute
          games={[game()]}
          isSaving={false}
          macros={[selectedMacro, parentMacro]}
          roles={[role()]}
          t={t}
          onSave={onSave}
        />
      },
      { path: "/macros", element: <div>Macro list</div> }
    ], { initialEntries: ["/macros/macro-1/edit"] });

    render(<ConfirmationProvider><RouterProvider router={router} /></ConfirmationProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Tap or hold" }));
    expect(screen.getByRole("combobox", { name: "Key action" }).textContent).toContain("Hold until stopped");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      activationMode: "while_held",
      steps: [expect.objectContaining({ action: "hold_until_stop" })]
    })));
  });

it("records physical modifiers and lets Primary be selected explicitly", async () => {
    document.documentElement.dataset.platform = "windows";
    const selectedMacro = macro();
    const onSave = vi.fn(async (form: MacroFormState): Promise<Macro> => ({
      ...selectedMacro,
      ...form,
      updatedAt: "2026-07-16T00:00:00.000Z"
    }));
    const router = createMemoryRouter([
      {
        path: "/macros/:id/edit",
        element: <MacroEditorRoute
          games={[game()]}
          isSaving={false}
          macros={[selectedMacro]}
          roles={[role()]}
          t={t}
          onSave={onSave}
        />
      },
      { path: "/macros", element: <div>Macro list</div> }
    ], { initialEntries: ["/macros/macro-1/edit"] });

    render(<ConfirmationProvider><RouterProvider router={router} /></ConfirmationProvider>);
    fireEvent.click(getKeyStepRecordButton());
    fireEvent.keyDown(window, {
      code: "KeyK",
      key: "K",
      ctrlKey: true,
      shiftKey: true
    });
    openModifierMenu();
    expect(getModifierOption("Ctrl + Shift").getAttribute("aria-selected")).toBe("true");
    fireEvent.click(getModifierOption("Ctrl + Shift"));

    fireEvent.click(getKeyStepRecordButton());
    fireEvent.keyDown(window, { code: "KeyK", key: "K", metaKey: true });
    openModifierMenu();
    expect(getModifierOption("Win").getAttribute("aria-selected")).toBe("true");
    expect(getModifierOption("Primary (Ctrl)").getAttribute("aria-selected")).toBe("false");

    fireEvent.click(getModifierOption("Win"));
    openModifierMenu();
    fireEvent.click(getModifierOption("Primary (Ctrl)"));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      steps: [expect.objectContaining({
        code: "KeyK",
        modifiers: ["primary"]
      })]
    })));
  });

it("edits shortcut modifiers and the main key independently", async () => {
    const selectedMacro = macro({
      trigger: { code: "F6", ctrl: false, alt: false, shift: false, meta: false }
    });
    const onSave = vi.fn(async (form: MacroFormState): Promise<Macro> => ({
      ...selectedMacro,
      ...form,
      updatedAt: "2026-07-16T00:00:00.000Z"
    }));
    const router = createMemoryRouter([
      {
        path: "/macros/:id/edit",
        element: <MacroEditorRoute
          games={[game()]}
          isSaving={false}
          macros={[selectedMacro]}
          roles={[role()]}
          t={t}
          onSave={onSave}
        />
      },
      { path: "/macros", element: <div>Macro list</div> }
    ], { initialEntries: ["/macros/macro-1/edit"] });

    render(<ConfirmationProvider><RouterProvider router={router} /></ConfirmationProvider>);

    const modifierSelectors = screen.getAllByRole("combobox", { name: "Modifiers" });
    const keySelectors = screen.getAllByRole("combobox", { name: "Key" });
    expect(modifierSelectors).toHaveLength(2);
    expect(keySelectors).toHaveLength(2);
    expect(modifierSelectors[0].textContent).toContain("No modifiers");
    expect(keySelectors[0].textContent).toContain("F6");

    fireEvent.click(modifierSelectors[0]);
    fireEvent.click(getModifierOption("Ctrl + Shift"));
    fireEvent.click(keySelectors[0]);
    fireEvent.click(screen.getByRole("option", { name: "F8" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      trigger: { code: "F8", ctrl: true, alt: false, shift: true, meta: false }
    })));
  });

it("keeps runtime tab switching shortcuts out of macro shortcut controls", () => {
    document.documentElement.dataset.platform = "windows";
    const selectedMacro = macro({
      trigger: { code: "Tab", ctrl: false, alt: false, shift: false, meta: false }
    });
    const router = createMemoryRouter([
      {
        path: "/macros/:id/edit",
        element: <MacroEditorRoute
          games={[game()]}
          isSaving={false}
          macros={[selectedMacro]}
          roles={[role()]}
          t={t}
          onSave={vi.fn()}
        />
      }
    ], { initialEntries: ["/macros/macro-1/edit"] });

    render(<ConfirmationProvider><RouterProvider router={router} /></ConfirmationProvider>);

    const [modifierSelector, keySelector] = screen.getAllByRole("combobox", {
      name: /^(Modifiers|Key)$/
    });
    expect(keySelector.textContent).toContain("Tab");
    fireEvent.click(modifierSelector);
    expect(screen.queryByRole("option", { name: "Ctrl" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Ctrl + Shift" })).toBeNull();
    expect(screen.getByRole("option", { name: "Alt" })).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: "No modifiers" }));

    const recordButton = screen.getAllByRole("button", { name: "Record" })[0];
    fireEvent.click(recordButton);
    fireEvent.keyDown(window, { code: "Tab", ctrlKey: true, key: "Tab" });

    expect(keySelector.textContent).toContain("Tab");
    expect(modifierSelector.textContent).toContain("No modifiers");
    expect(screen.getAllByRole("button", { name: "Record" })[0].getAttribute("aria-pressed")).toBe("false");
  });

it("uses the same icon-only record control and switches its active state", () => {
    const selectedMacro = macro({
      trigger: { code: "F6", ctrl: false, alt: false, shift: false, meta: false }
    });
    const router = createMemoryRouter([
      {
        path: "/macros/:id/edit",
        element: <MacroEditorRoute
          games={[game()]}
          isSaving={false}
          macros={[selectedMacro]}
          roles={[role()]}
          t={t}
          onSave={vi.fn()}
        />
      }
    ], { initialEntries: ["/macros/macro-1/edit"] });

    render(<ConfirmationProvider><RouterProvider router={router} /></ConfirmationProvider>);

    const recordButtons = screen.getAllByRole("button", { name: "Record" });
    expect(recordButtons).toHaveLength(2);
    for (const button of recordButtons) {
      expect(button.getAttribute("aria-pressed")).toBe("false");
      expect(button.querySelector(".lucide-circle-dot")).toBeTruthy();
      expect(button.textContent).toBe("");
    }

    fireEvent.click(recordButtons[0]);

    const stopButton = screen.getByRole("button", { name: "Stop recording" });
    expect(stopButton.getAttribute("aria-pressed")).toBe("true");
    expect(stopButton.querySelector(".lucide-square")).toBeTruthy();
    expect(screen.getAllByRole("combobox", { name: "Key" })[0].textContent).toContain("Press shortcut");

    fireEvent.click(stopButton);
    expect(screen.getAllByRole("button", { name: "Record" })).toHaveLength(2);
  });

it("disables modifier chips when the main key is itself a modifier", () => {
    const selectedMacro = macro({
      steps: [{ id: "step-1", type: "key", code: "ControlLeft" }]
    });
    const router = createMemoryRouter([
      {
        path: "/macros/:id/edit",
        element: <MacroEditorRoute
          games={[game()]}
          isSaving={false}
          macros={[selectedMacro]}
          roles={[role()]}
          t={t}
          onSave={vi.fn()}
        />
      },
      { path: "/macros", element: <div>Macro list</div> }
    ], { initialEntries: ["/macros/macro-1/edit"] });

    render(<ConfirmationProvider><RouterProvider router={router} /></ConfirmationProvider>);

    expect(screen.getByText("Choose a non-modifier main key before adding modifiers.")).toBeTruthy();
    expect((getStepModifierSelect() as HTMLButtonElement).disabled).toBe(true);
    for (const name of ["Primary (Ctrl)", "Ctrl", "Alt", "Shift", "Meta"]) {
      expect(screen.queryByRole("option", { name })).toBeNull();
    }
  });

it("shows modifier combination options in readable sorted order", () => {
    const selectedMacro = macro();
    const router = createMemoryRouter([
      {
        path: "/macros/:id/edit",
        element: <MacroEditorRoute
          games={[game()]}
          isSaving={false}
          macros={[selectedMacro]}
          roles={[role()]}
          t={t}
          onSave={vi.fn()}
        />
      },
      { path: "/macros", element: <div>Macro list</div> }
    ], { initialEntries: ["/macros/macro-1/edit"] });

    render(
      <ConfirmationProvider>
        <RouterProvider router={router} />
      </ConfirmationProvider>
    );

    expect(getStepModifierSelect().textContent).toContain("No modifiers");

    openModifierMenu();
    const optionLabels = screen.getAllByRole("option").map((option) => option.textContent?.trim() ?? "");

    expect(optionLabels[0]).toBe("No modifiers");
    expect(optionLabels[1]).toBe("Primary (Ctrl)");
    expect(optionLabels[2]).toBe("Ctrl");
    expect(optionLabels[3]).toBe("Alt");
    expect(optionLabels[4]).toBe("Shift");
    expect(optionLabels[5]).toBe("Meta");
    expect(optionLabels[6]).toBe("Primary (Ctrl) + Alt");
    expect(optionLabels[7]).toBe("Primary (Ctrl) + Shift");
    expect(optionLabels[8]).toBe("Ctrl + Alt");
  });

it("stores multiple selected modifiers from the modifier menu in canonical order", async () => {
    const selectedMacro = macro();
    const onSave = vi.fn(async (form: MacroFormState): Promise<Macro> => ({
      ...selectedMacro,
      ...form,
      updatedAt: "2026-07-16T00:00:00.000Z"
    }));
    const router = createMemoryRouter([
      {
        path: "/macros/:id/edit",
        element: <MacroEditorRoute
          games={[game()]}
          isSaving={false}
          macros={[selectedMacro]}
          roles={[role()]}
          t={t}
          onSave={onSave}
        />
      },
      { path: "/macros", element: <div>Macro list</div> }
    ], { initialEntries: ["/macros/macro-1/edit"] });

    render(<ConfirmationProvider><RouterProvider router={router} /></ConfirmationProvider>);

    openModifierMenu();
    fireEvent.click(getModifierOption("Ctrl + Shift"));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      steps: [expect.objectContaining({ modifiers: ["ctrl", "shift"] })]
    })));
  });

it("uses a removable multi-select combobox for assigned roles", async () => {
    const user = userEvent.setup();
    const selectedMacro = macro();
    const onSave = vi.fn(async () => selectedMacro);
    const router = createMemoryRouter(
      [
        {
          path: "/macros/:id/edit",
          element: (
            <MacroEditorRoute
              games={[game()]}
              isSaving={false}
              macros={[selectedMacro]}
              roles={[role()]}
              t={t}
              onSave={onSave}
            />
          )
        }
      ],
      { initialEntries: ["/macros/macro-1/edit"] }
    );

    render(
      <ConfirmationProvider>
        <RouterProvider router={router} />
      </ConfirmationProvider>
    );

    const rolePicker = screen.getByRole("combobox", { name: "Execution roles" });
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Remove Main role" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Remove Main role" }));
    expect(screen.queryByRole("button", { name: "Remove Main role" })).toBeNull();

    await user.click(rolePicker);
    await user.click(await screen.findByRole("option", { name: "Main role" }));
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Remove Main role" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      roleIds: ["role-1"]
    })));
  });

it("keeps the create-role prompt when no roles exist", () => {
    const selectedMacro = macro({ roleIds: [] });
    const router = createMemoryRouter([
      {
        path: "/macros/:id/edit",
        element: <MacroEditorRoute
          games={[]}
          isSaving={false}
          macros={[selectedMacro]}
          roles={[]}
          t={t}
          onSave={vi.fn()}
        />
      }
    ], { initialEntries: ["/macros/macro-1/edit"] });

    render(<ConfirmationProvider><RouterProvider router={router} /></ConfirmationProvider>);

    expect(screen.getByText("Create roles before assigning macros.")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Execution roles" })).toBeNull();
  });
});

const t: Translator = (key) => en[key];

function openModifierMenu(): void {
  const trigger = getStepModifierSelect();
  if (trigger.getAttribute("aria-expanded") !== "true") {
    fireEvent.click(trigger);
  }
}

function getStepModifierSelect(): HTMLElement {
  const selectors = screen.getAllByRole("combobox", { name: /^Modifiers/i });
  const selector = selectors.at(-1);
  if (!selector) {
    throw new Error("Step modifier selector was not found.");
  }
  return selector;
}

function getModifierOption(name: string): HTMLElement {
  return screen.getByRole("option", { name });
}

function getKeyStepRecordButton(): HTMLElement {
  const recordButtons = screen.getAllByRole("button", { name: "Record" });
  const button = recordButtons.at(-1);
  if (!button) {
    throw new Error("Key-step record button was not found.");
  }
  return button;
}

function game(): Game {
  return {
    id: "game-1",
    source: "custom",
    name: "Test game",
    defaultLaunchUrl: "https://example.test/play",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z"
  };
}

function role(): Role {
  return {
    id: "role-1",
    gameId: "game-1",
    name: "Main role",
    launchUrl: "https://example.test/play",
    notes: "",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z"
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
