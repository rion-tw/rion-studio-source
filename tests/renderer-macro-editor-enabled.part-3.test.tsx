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
  ])("shows complete macro help when $state", ({ entry, macros, routePath, state }) => {
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
    const name = screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement;

    expect(screen.getByRole("heading", {
      level: 1,
      name: state === "editing" ? "Edit Macro" : "New Macro"
    })).toBeTruthy();
    expect(container.querySelector("[contenteditable]")).toBeNull();
    expect(name.name).toBe("name");
    expect(name.maxLength).toBe(80);
    expect(screen.getByText("Keep the name short enough to identify from the macro list.")).toBeTruthy();
    expect(helpList?.className).toContain("editor-layout-macro-help");
    expect(macroHelps).toHaveLength(3);
    expect(macroHelps[0].getAttribute("data-macro-help")).toBe("activation");
    expect(macroHelps[1].getAttribute("data-macro-help")).toBe("calls");
    expect(macroHelps[2].getAttribute("data-macro-help")).toBe("stop");
    expect(macroHelps[0].textContent).toContain("Starting and repeating");
    expect(macroHelps[0].textContent).toContain("every assigned role that is launched and controllable");
    expect(macroHelps[0].textContent).toContain("Tap to toggle switches between starting and stopping");
    expect(macroHelps[0].textContent).toContain("0 ms interval removes only the extra wait");
    expect(macroHelps[1].textContent).toContain("Running other macros");
    expect(macroHelps[1].textContent).toContain("uses its own assigned roles");
    expect(macroHelps[1].textContent).toContain("Wait for completion runs the child macro once");
    expect(macroHelps[1].textContent).toContain("Interrupting the parent stops its triggered descendants");
    expect(macroHelps[1].textContent).toContain("when the parent completes normally");
    expect(macroHelps[1].textContent).toContain("already running does not start or create another run");
    expect(macroHelps[2].textContent).toContain("Stopping and held keys");
    expect(macroHelps[2].textContent).toContain("Timed holds release automatically");
    expect(macroHelps[2].textContent).toContain("Stopping or cancelling a macro releases");
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

it("converts measured coordinates into bottom-right percent offsets", async () => {
    const selectedMacro = macro({
      steps: [{ id: "click", type: "click", anchor: "bottom-right", xPercent: -10, yPercent: -20 }]
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
    fireEvent.paste(screen.getByRole("spinbutton", { name: "X offset" }), {
      clipboardData: {
        getData: () => "X: 100px (9.77%), Y: 700px (91.15%)"
      }
    });
    fireEvent.submit(screen.getByRole("button", { name: "Save changes" }).closest("form")!);

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      steps: [{ id: "click", type: "click", anchor: "bottom-right", xPercent: -90.23, yPercent: -8.85 }]
    })));
  });

it("applies the copied anchor when pasting a measured percent coordinate", async () => {
    const selectedMacro = macro({
      steps: [{ id: "click", type: "click", xPercent: 10, yPercent: 20 }]
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
    fireEvent.paste(screen.getByRole("spinbutton", { name: "X offset" }), {
      clipboardData: {
        getData: () => "X: 100px (9.77%), Y: 700px (91.15%), Anchor: bottom-right, Viewport: 1024x768px"
      }
    });
    fireEvent.submit(screen.getByRole("button", { name: "Save changes" }).closest("form")!);

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      steps: [{ id: "click", type: "click", anchor: "bottom-right", xPercent: -90.23, yPercent: -8.85 }]
    })));
  });

it("selects the nearest anchor for measured pixel offsets using viewport metadata", async () => {
    const selectedMacro = macro({
      steps: [{ id: "click", type: "click", unit: "px", anchor: "bottom-right", xPx: -10, yPx: -20 }]
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
    fireEvent.paste(screen.getByRole("spinbutton", { name: "Y offset" }), {
      clipboardData: {
        getData: () => "X: 100px (9.77%), Y: 700px (91.15%), Viewport: 1024x768px"
      }
    });
    fireEvent.submit(screen.getByRole("button", { name: "Save changes" }).closest("form")!);

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      steps: [{ id: "click", type: "click", unit: "px", anchor: "bottom-left", xPx: 100, yPx: -68 }]
    })));
  });

it("applies the copied anchor when pasting a measured pixel coordinate", async () => {
    const selectedMacro = macro({
      steps: [{ id: "click", type: "click", unit: "px", xPx: 10, yPx: 20 }]
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
    fireEvent.paste(screen.getByRole("spinbutton", { name: "Y offset" }), {
      clipboardData: {
        getData: () => "X: 100px (9.77%), Y: 700px (91.15%), Anchor: bottom-right, Viewport: 1024x768px"
      }
    });
    fireEvent.submit(screen.getByRole("button", { name: "Save changes" }).closest("form")!);

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      steps: [{ id: "click", type: "click", unit: "px", anchor: "bottom-right", xPx: -924, yPx: -68 }]
    })));
  });

it("recalculates percent offsets from the pasted measurement after repeated anchor changes", async () => {
    const { onSave } = renderClickStepEditor({
      id: "click",
      type: "click",
      xPercent: 10,
      yPercent: 20
    });
    const xInput = screen.getByRole("spinbutton", { name: "X offset" });
    fireEvent.paste(xInput, {
      clipboardData: {
        getData: () => "X: 100px (9.77%), Y: 700px (91.15%), Anchor: bottom-right, Viewport: 1024x768px"
      }
    });
    fireEvent.paste(xInput, {
      clipboardData: { getData: () => "X: 123px, Y: 456px" }
    });

    selectClickAnchor("Center");
    expect((screen.getByRole("spinbutton", { name: "X offset" }) as HTMLInputElement).value).toBe("-40.23");
    expect((screen.getByRole("spinbutton", { name: "Y offset" }) as HTMLInputElement).value).toBe("41.15");

    selectClickAnchor("Top left");
    expect((screen.getByRole("spinbutton", { name: "X offset" }) as HTMLInputElement).value).toBe("9.77");
    expect((screen.getByRole("spinbutton", { name: "Y offset" }) as HTMLInputElement).value).toBe("91.15");
    fireEvent.submit(screen.getByRole("button", { name: "Save changes" }).closest("form")!);

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      steps: [{ id: "click", type: "click", xPercent: 9.77, yPercent: 91.15 }]
    })));
  });

it("recalculates pixel offsets from the pasted viewport after changing the anchor", async () => {
    const { onSave } = renderClickStepEditor({
      id: "click",
      type: "click",
      unit: "px",
      xPx: 10,
      yPx: 20
    });
    fireEvent.paste(screen.getByRole("spinbutton", { name: "Y offset" }), {
      clipboardData: {
        getData: () => "X: 100px (9.77%), Y: 700px (91.15%), Viewport: 1024x768px"
      }
    });

    selectClickAnchor("Center");
    expect((screen.getByRole("spinbutton", { name: "X offset" }) as HTMLInputElement).value).toBe("-412");
    expect((screen.getByRole("spinbutton", { name: "Y offset" }) as HTMLInputElement).value).toBe("316");
    fireEvent.submit(screen.getByRole("button", { name: "Save changes" }).closest("form")!);

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      steps: [{ id: "click", type: "click", unit: "px", anchor: "center", xPx: -412, yPx: 316 }]
    })));
  });

it("stops rebasing from the pasted measurement after a manual coordinate edit", async () => {
    const { onSave } = renderClickStepEditor({
      id: "click",
      type: "click",
      xPercent: 10,
      yPercent: 20
    });
    fireEvent.paste(screen.getByRole("spinbutton", { name: "X offset" }), {
      clipboardData: {
        getData: () => "X: 100px (9.77%), Y: 700px (91.15%), Anchor: bottom-right, Viewport: 1024x768px"
      }
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "X offset" }), {
      target: { value: "-80" }
    });

    selectClickAnchor("Center");
    expect((screen.getByRole("spinbutton", { name: "X offset" }) as HTMLInputElement).value).toBe("-80");
    expect((screen.getByRole("spinbutton", { name: "Y offset" }) as HTMLInputElement).value).toBe("-8.85");
    fireEvent.submit(screen.getByRole("button", { name: "Save changes" }).closest("form")!);

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      steps: [{ id: "click", type: "click", anchor: "center", xPercent: -80, yPercent: -8.85 }]
    })));
  });

it("leaves click fields unchanged for malformed coordinate paste", () => {
    const selectedMacro = macro({
      steps: [{ id: "click", type: "click", xPercent: 10, yPercent: 20 }]
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
    fireEvent.paste(screen.getByRole("spinbutton", { name: "X offset" }), {
      clipboardData: { getData: () => "X: 123px, Y: 456px" }
    });

    expect((screen.getByRole("spinbutton", { name: "X offset" }) as HTMLInputElement).value).toBe("10");
    expect((screen.getByRole("spinbutton", { name: "Y offset" }) as HTMLInputElement).value).toBe("20");
  });

it("supports minute, hour, and day delay units", async () => {
    const selectedMacro = macro({
      repeat: { type: "loop", intervalMs: 1234 },
      steps: [{ id: "delay", type: "delay", ms: 1500 }]
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

    const intervalTimeUnit = screen.getAllByRole("combobox", { name: "Time unit" })[0];
    const delayTimeUnit = screen.getAllByRole("combobox", { name: "Time unit" })[1];
    const intervalInput = screen.getByRole("spinbutton", { name: "Custom interval" }) as HTMLInputElement;
    const delayInput = screen.getByRole("spinbutton", { name: "Delay" }) as HTMLInputElement;
    expect(intervalInput.value).toBe("1.234");

    fireEvent.click(intervalTimeUnit);
    fireEvent.click(screen.getByRole("option", { name: "min" }));
    expect(intervalInput.max).toBe("1440");
    expect(intervalInput.value).toBe("0.021");
    fireEvent.change(intervalInput, { target: { value: "1.5" } });

    expect(delayInput.max).toBe("86400");
    expect(delayInput.step).toBe("0.001");

    fireEvent.click(delayTimeUnit);
    fireEvent.click(screen.getByRole("option", { name: "min" }));
    expect(delayInput.max).toBe("1440");
    expect(delayInput.value).toBe("0.025");
    fireEvent.change(delayInput, { target: { value: "1.5" } });

    fireEvent.click(delayTimeUnit);
    fireEvent.click(screen.getByRole("option", { name: "h" }));
    expect(delayInput.max).toBe("24");
    expect(delayInput.value).toBe("0.025");
    fireEvent.change(delayInput, { target: { value: "1.5" } });

    fireEvent.click(delayTimeUnit);
    fireEvent.click(screen.getByRole("option", { name: "d" }));
    expect(delayInput.max).toBe("1");
    expect(delayInput.value).toBe("0.063");
    fireEvent.change(delayInput, { target: { value: "0.5" } });

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      repeat: { type: "loop", intervalMs: 90_000 },
      steps: [{ id: "delay", type: "delay", ms: 43_200_000 }]
    })));
  });

it("selects external shortcut source roles and saves them separately from execution roles", async () => {
    const user = userEvent.setup();
    const selectedMacro = macro({
      trigger: { code: "F6", ctrl: false, alt: false, shift: false, meta: false }
    });
    const controllerRole = { ...role(), id: "role-controller", name: "Controller" };
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
          roles={[role(), controllerRole]}
          t={t}
          onSave={onSave}
        />
      },
      { path: "/macros", element: <div>Macro list</div> }
    ], { initialEntries: ["/macros/macro-1/edit"] });

    render(<ConfirmationProvider><RouterProvider router={router} /></ConfirmationProvider>);
    expect(screen.getByText("Effective scope")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Selected roles" }));
    expect(screen.getAllByRole("button", { name: "Remove Main role" })).toHaveLength(2);

    const sourceInput = screen.getByRole("combobox", { name: "Shortcut source roles" });
    await user.click(sourceInput);
    await user.click(await screen.findByRole("option", { name: "Controller" }));
    await user.keyboard("{Escape}");
    const sourceToolbar = sourceInput.closest<HTMLElement>('[role="toolbar"]');
    expect(sourceToolbar).not.toBeNull();
    await user.click(within(sourceToolbar!).getByRole("button", { name: "Remove Main role" }));
    await user.click(screen.getByRole("button", { name: "All execution roles" }));
    await user.click(screen.getByRole("button", { name: "Selected roles" }));
    expect(screen.getAllByRole("button", { name: "Remove Main role" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Remove Controller" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      roleIds: ["role-1"],
      shortcutSourceScope: {
        type: "selected_roles",
        roleIds: ["role-controller"]
      }
    })));
  });

it("blocks saving an empty selected shortcut source scope", async () => {
    const user = userEvent.setup();
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
    await user.click(screen.getByRole("button", { name: "Selected roles" }));
    await user.click(screen.getAllByRole("button", { name: "Remove Main role" })[0]);

    expect(screen.getAllByText("Select at least one shortcut source role, or clear the shortcut."))
      .toHaveLength(2);
    expect(screen.getByRole("button", { name: "Save changes" }).hasAttribute("disabled"))
      .toBe(true);
  });

it("adds, validates, resets, duplicates, and saves timed hold steps", async () => {
    const user = userEvent.setup();
    const selectedMacro = macro({
      steps: [{ id: "delay", type: "delay", ms: 100 }]
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
    await user.click(screen.getByRole("button", { name: "Timed hold" }));

    expect(screen.getByRole("combobox", { name: "Key action" }).textContent)
      .toContain("Hold for duration");
    let durationInput = screen.getByRole<HTMLInputElement>("spinbutton", {
      name: "Hold duration"
    });
    expect(durationInput.value).toBe("1");

    fireEvent.change(durationInput, { target: { value: "0.019" } });
    expect(screen.getByText("Enter a whole-number hold duration from 20 to 86,400,000 ms."))
      .toBeTruthy();
    expect(screen.getByRole("button", { name: "Save changes" }).hasAttribute("disabled"))
      .toBe(true);

    const actionSelect = screen.getByRole("combobox", { name: "Key action" });
    fireEvent.click(actionSelect);
    fireEvent.click(screen.getByRole("option", { name: "Tap" }));
    expect(screen.queryByRole("spinbutton", { name: "Hold duration" })).toBeNull();

    fireEvent.click(actionSelect);
    fireEvent.click(screen.getByRole("option", { name: "Hold for duration" }));
    durationInput = screen.getByRole<HTMLInputElement>("spinbutton", { name: "Hold duration" });
    expect(durationInput.value).toBe("1");
    fireEvent.change(durationInput, { target: { value: "2.5" } });

    const timedRow = durationInput.closest<HTMLElement>("[data-macro-step-id]");
    expect(timedRow).not.toBeNull();
    await user.click(within(timedRow!).getByTitle("Duplicate"));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      steps: [
        { id: "delay", type: "delay", ms: 100 },
        expect.objectContaining({
          type: "key",
          action: "hold_for_duration",
          durationMs: 2_500
        }),
        expect.objectContaining({
          type: "key",
          action: "hold_for_duration",
          durationMs: 2_500
        })
      ]
    })));
  });
});

const t: Translator = (key) => en[key];

function _openModifierMenu(): void {
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

function _getModifierOption(name: string): HTMLElement {
  return screen.getByRole("option", { name });
}

function _getKeyStepRecordButton(): HTMLElement {
  const recordButtons = screen.getAllByRole("button", { name: "Record" });
  const button = recordButtons.at(-1);
  if (!button) {
    throw new Error("Key-step record button was not found.");
  }
  return button;
}

function renderClickStepEditor(step: Macro["steps"][number]): { onSave: ReturnType<typeof vi.fn> } {
  const selectedMacro = macro({ steps: [step] });
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
  return { onSave };
}

function selectClickAnchor(name: string): void {
  fireEvent.click(screen.getByRole("combobox", { name: "Coordinate anchor" }));
  fireEvent.click(screen.getByRole("option", { name }));
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
