// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ConfirmationProvider } from "../src/renderer/src/components/ConfirmationDialog";
import type { MacroFormState } from "../src/renderer/src/app/types";
import MacroEditorRoute from "../src/renderer/src/features/macros/MacroModal";
import type { Translator } from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/en.json";
import type { Game, Macro, Role } from "../src/shared/types";

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class ResizeObserver {
    disconnect(): void {}
    observe(): void {}
    unobserve(): void {}
  });
});

afterEach(cleanup);
afterAll(() => vi.unstubAllGlobals());

describe("macro editor controls", () => {
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

  it("uses the full role card as the selector without showing a checkbox", () => {
    const selectedMacro = macro();
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
              onSave={vi.fn()}
            />
          )
        }
      ],
      { initialEntries: ["/macros/macro-1/edit"] }
    );

    const { container } = render(
      <ConfirmationProvider>
        <RouterProvider router={router} />
      </ConfirmationProvider>
    );

    const rolePicker = container.querySelector("#macro-role");
    const roleButton = screen.getByRole("button", { name: /Main role/ });

    expect(rolePicker?.className).toContain("p-0.5");
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(roleButton.getAttribute("aria-pressed")).toBe("true");
    expect(roleButton.className).toContain("macro-role-card-selected");
    expect(roleButton.firstElementChild?.className).toContain("rounded-sm");

    fireEvent.click(roleButton);

    expect(roleButton.getAttribute("aria-pressed")).toBe("false");
    expect(roleButton.className).not.toContain("macro-role-card-selected");
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

  it("does not show the low-interval warning at 250 ms or for invalid values", () => {
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

    const invalidMacro = macro({ repeat: { type: "loop", intervalMs: 0 } });
    const invalidRouter = createMemoryRouter(
      [
        {
          path: "/macros/:id/edit",
          element: (
            <MacroEditorRoute
              games={[game()]}
              isSaving={false}
              macros={[invalidMacro]}
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
        <RouterProvider router={invalidRouter} />
      </ConfirmationProvider>
    );

    expect(screen.queryByRole("status")).toBeNull();
  });
});

const t: Translator = (key) => en[key];

function game(): Game {
  return {
    id: "game-1",
    source: "custom",
    name: "Test game",
    defaultLaunchUrl: "https://example.test/play",
    browserLaunchMode: "inherit",
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
    windowWidth: 1280,
    windowHeight: 720,
    notes: "",
    authState: "authenticated",
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
    repeat: { type: "once" },
    steps: [{ id: "step-1", type: "key", code: "F2" }],
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    ...overrides
  };
}
