// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfirmationProvider } from "../src/renderer/src/components/ConfirmationDialog";
import type { MacroFormState } from "../src/renderer/src/app/types";
import MacroEditorRoute from "../src/renderer/src/features/macros/MacroModal";
import type { Translator } from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/en.json";
import type { Game, Macro, Role } from "../src/shared/types";

afterEach(cleanup);

describe("macro editor enabled setting", () => {
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
