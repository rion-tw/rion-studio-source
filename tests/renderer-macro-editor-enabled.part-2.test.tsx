// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ConfirmationProvider } from "../src/renderer/src/components/ConfirmationDialog";
import type { MacroFormState } from "../src/renderer/src/app/types";
import MacroEditorRoute from "../src/renderer/src/features/macros/MacroModal";
import type { Translator } from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/en.json";
import { MACRO_DELAY_MAX_MS } from "../src/shared/macroSettings";
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

it("warns about valid loop intervals below 250 ms without blocking save", async () => {
    const lowIntervalMacro = macro({ repeat: { type: "loop", intervalMs: 100 } });
    const onSave = vi.fn(async (form: MacroFormState): Promise<Macro> => ({
      ...lowIntervalMacro,
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
              macros={[lowIntervalMacro]}
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

    expect(screen.getByRole("status").textContent).toBe(en["macroForm.intervalLowWarning"]);

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
        repeat: { type: "loop", intervalMs: 100 }
      }));
    });
  });

it("does not warn at 250 ms and explains a valid zero wait", () => {
    const thresholdMacro = macro({ repeat: { type: "loop", intervalMs: 250 } });
    const router = createMemoryRouter(
      [
        {
          path: "/macros/:id/edit",
          element: (
            <MacroEditorRoute
              games={[game()]}
              isSaving={false}
              macros={[thresholdMacro]}
              roles={[role()]}
              t={t}
              onSave={vi.fn()}
            />
          )
        }
      ],
      { initialEntries: ["/macros/macro-1/edit"] }
    );

    const renderedThreshold = render(
      <ConfirmationProvider>
        <RouterProvider router={router} />
      </ConfirmationProvider>
    );

    expect(screen.queryByRole("status")).toBeNull();

    renderedThreshold.unmount();

    const zeroWaitMacro = macro({ repeat: { type: "loop", intervalMs: 0 } });
    const zeroWaitRouter = createMemoryRouter(
      [
        {
          path: "/macros/:id/edit",
          element: (
            <MacroEditorRoute
              games={[game()]}
              isSaving={false}
              macros={[zeroWaitMacro]}
              roles={[role()]}
              t={t}
              onSave={vi.fn()}
            />
          )
        }
      ],
      { initialEntries: ["/macros/macro-1/edit"] }
    );

    render(
      <ConfirmationProvider>
        <RouterProvider router={zeroWaitRouter} />
      </ConfirmationProvider>
    );

    expect(screen.getByRole("status").textContent).toBe(en["macroForm.intervalLowWarning"]);
  });

it("uses the global default when enabling looping", async () => {
    const onSave = vi.fn(async (form: MacroFormState): Promise<Macro> => ({
      ...macro(),
      ...form,
      id: "macro-new",
      updatedAt: "2026-07-16T00:00:00.000Z"
    }));
    const router = createMemoryRouter(
      [
        {
          path: "/macros/new",
          element: (
            <MacroEditorRoute
              games={[game()]}
              isSaving={false}
              macroSettings={{
                startupDelayMs: 100,
                keyHoldMs: 30,
                postInputDelayMs: 30,
                defaultLoopDelayMs: 0
              }}
              macros={[]}
              roles={[role()]}
              t={t}
              onSave={onSave}
            />
          )
        },
        { path: "/macros", element: <div>Macro list</div> }
      ],
      { initialEntries: ["/macros/new"] }
    );

    render(
      <ConfirmationProvider>
        <RouterProvider router={router} />
      </ConfirmationProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Loop" }));
    fireEvent.click(screen.getByRole("button", { name: "Key" }));
    fireEvent.click(screen.getByRole("button", { name: "Create macro" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ repeat: { type: "loop", intervalMs: 0 } })
    ));
  });

it("accepts 24-hour loop and delay values in the editor", async () => {
    const dailyMacro = macro({
      repeat: { type: "loop", intervalMs: MACRO_DELAY_MAX_MS },
      steps: [{ id: "daily-delay", type: "delay", ms: MACRO_DELAY_MAX_MS }]
    });
    const onSave = vi.fn(async (form: MacroFormState): Promise<Macro> => ({
      ...dailyMacro,
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
              macros={[dailyMacro]}
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

    const interval = screen.getByRole("spinbutton", { name: "Custom interval" }) as HTMLInputElement;
    const delay = screen.getByRole("spinbutton", { name: "Delay" }) as HTMLInputElement;
    expect(interval.value).toBe(String(MACRO_DELAY_MAX_MS / 1000));
    expect(interval.max).toBe(String(MACRO_DELAY_MAX_MS / 1000));
    expect(delay.value).toBe(String(MACRO_DELAY_MAX_MS / 1000));
    expect(delay.max).toBe(String(MACRO_DELAY_MAX_MS / 1000));

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      repeat: { type: "loop", intervalMs: MACRO_DELAY_MAX_MS },
      steps: [{ id: "daily-delay", type: "delay", ms: MACRO_DELAY_MAX_MS }]
    })));
  });

it("edits pixel clicks and converts seconds back to milliseconds", async () => {
    const selectedMacro = macro({
      steps: [
        { id: "click", type: "click", xPercent: 12, yPercent: 34 },
        { id: "delay", type: "delay", ms: 1500 }
      ]
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

    fireEvent.click(screen.getByRole("combobox", { name: "Coordinate unit" }));
    fireEvent.click(screen.getByRole("option", { name: "px" }));
    const delayInput = screen.getByRole("spinbutton", { name: "Delay" }) as HTMLInputElement;
    expect(delayInput.value).toBe("1.5");
    fireEvent.change(delayInput, { target: { value: "2.25" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      steps: [
        { id: "click", type: "click", unit: "reference-px", xReferencePx: 12, yReferencePx: 34 },
        { id: "delay", type: "delay", ms: 2250 }
      ]
    })));
  });

it("adds new click steps in percent mode at the center anchor", async () => {
    const selectedMacro = macro({
      steps: [{ id: "key", type: "key", code: "F2" }]
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
    fireEvent.click(screen.getByRole("button", { name: "Click" }));

    expect(screen.getByRole("combobox", { name: "Coordinate unit" }).textContent).toContain("%");
    expect(screen.getByRole("combobox", { name: "Coordinate anchor" }).textContent).toContain("Center");
    expect((screen.getByRole("spinbutton", { name: "X offset" }) as HTMLInputElement).value).toBe("0");
    expect((screen.getByRole("spinbutton", { name: "Y offset" }) as HTMLInputElement).value).toBe("0");

    fireEvent.submit(screen.getByRole("button", { name: "Save changes" }).closest("form")!);

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      steps: [
        { id: "key", type: "key", code: "F2" },
        expect.objectContaining({
          type: "click",
          anchor: "center",
          xPercent: 0,
          yPercent: 0
        })
      ]
    })));
  });

it("pastes a measured coordinate pair into both percent click fields", async () => {
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
        getData: () => "X: 123px (12.35%), Y: 456px (56.79%)"
      }
    });
    fireEvent.submit(screen.getByRole("button", { name: "Save changes" }).closest("form")!);

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      steps: [{ id: "click", type: "click", xPercent: 12.35, yPercent: 56.79 }]
    })));
  });

it("allows percent click offsets to be entered to two decimal places", async () => {
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

    const xOffset = screen.getByRole("spinbutton", { name: "X offset" }) as HTMLInputElement;
    const yOffset = screen.getByRole("spinbutton", { name: "Y offset" }) as HTMLInputElement;
    expect(xOffset.step).toBe("0.01");
    expect(yOffset.step).toBe("0.01");

    fireEvent.change(xOffset, { target: { value: "12.34" } });
    fireEvent.change(yOffset, { target: { value: "56.78" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      steps: [{ id: "click", type: "click", xPercent: 12.34, yPercent: 56.78 }]
    })));
  });

it("pastes a measured coordinate pair into both pixel click fields", async () => {
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
    expect(screen.getByRole("combobox", { name: "Coordinate unit" }).textContent)
      .toContain("CSS px (legacy)");
    fireEvent.paste(screen.getByRole("spinbutton", { name: "Y offset" }), {
      clipboardData: {
        getData: () => "X: 123px (12.35%), Y: 456px (56.79%)"
      }
    });
    fireEvent.submit(screen.getByRole("button", { name: "Save changes" }).closest("form")!);

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      steps: [{ id: "click", type: "click", unit: "px", xPx: 123, yPx: 456 }]
    })));
  });

it("pastes a zoom-normalized measurement into reference pixel fields", async () => {
    const selectedMacro = macro({
      steps: [{ id: "click", type: "click", xPercent: 0, yPercent: 0 }]
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
        getData: () => "X: 214px (22.27%), Y: 0px (0%), Anchor: top-left, ReferenceViewport: 960x540px, CSS: X 285px, Y 0px, Viewport: 1280x720px, Zoom: 75%"
      }
    });
    fireEvent.submit(screen.getByRole("button", { name: "Save changes" }).closest("form")!);

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      steps: [{
        id: "click",
        type: "click",
        unit: "reference-px",
        xReferencePx: 214,
        yReferencePx: 0
      }]
    })));
  });

it("selects the nearest anchor when pasting a measured pixel coordinate with a viewport", async () => {
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
        getData: () => "X: 731px (35.69%), Y: 414px (38.05%), Viewport: 2048x1088px"
      }
    });
    fireEvent.submit(screen.getByRole("button", { name: "Save changes" }).closest("form")!);

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      steps: [{ id: "click", type: "click", unit: "px", anchor: "center", xPx: -293, yPx: -130 }]
    })));
  });

it("shows the nine anchor choices and keeps offsets when changing the anchor", async () => {
    const selectedMacro = macro({
      steps: [{ id: "click", type: "click", xPercent: -10, yPercent: -20 }]
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
    fireEvent.click(screen.getByRole("combobox", { name: "Coordinate anchor" }));
    expect(screen.getAllByRole("option")).toHaveLength(9);
    fireEvent.click(screen.getByRole("option", { name: "Bottom right" }));

    expect((screen.getByRole("spinbutton", { name: "X offset" }) as HTMLInputElement).value).toBe("-10");
    expect((screen.getByRole("spinbutton", { name: "Y offset" }) as HTMLInputElement).value).toBe("-20");
    fireEvent.submit(screen.getByRole("button", { name: "Save changes" }).closest("form")!);

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      steps: [{ id: "click", type: "click", anchor: "bottom-right", xPercent: -10, yPercent: -20 }]
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
