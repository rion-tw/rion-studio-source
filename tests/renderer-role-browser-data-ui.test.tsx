// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ConfirmationProvider } from "../src/renderer/src/components/ConfirmationDialog";
import RoleEditorRoute from "../src/renderer/src/features/roles/RoleModal";
import type { Translator } from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/en.json";
import type { Game, Role } from "../src/shared/types";

beforeAll(() => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    close: { configurable: true, value() { this.removeAttribute("open"); } },
    showModal: { configurable: true, value() { this.setAttribute("open", ""); } }
  });
});

afterEach(cleanup);

describe("role saved browser data controls", () => {
  it("shows the clear action without login or re-login controls", async () => {
    const user = userEvent.setup();
    const selectedRole = role();
    const onClearBrowserData = vi.fn().mockResolvedValue(true);
    const router = createRoleRouter(selectedRole, onClearBrowserData);
    render(<ConfirmationProvider><RouterProvider router={router} /></ConfirmationProvider>);

    expect(screen.queryByText("Re-login")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Clear saved data" }));
    expect(onClearBrowserData).toHaveBeenCalledWith(selectedRole);
  });
});

function createRoleRouter(selectedRole: Role, onClearBrowserData: (role: Role) => Promise<boolean>) {
  return createMemoryRouter([{
    path: "/roles/:id/edit",
    element: <RoleEditorRoute
      busyRoleIds={new Set()}
      games={[game]}
      isSaving={false}
      roles={[selectedRole]}
      t={t}
      onClearBrowserData={onClearBrowserData}
      onError={vi.fn()}
      onSave={vi.fn()}
    />
  }], { initialEntries: [`/roles/${selectedRole.id}/edit`] });
}

const game: Game = {
  id: "game-1",
  source: "custom",
  name: "Example",
  defaultLaunchUrl: "https://example.test/play",
  browserLaunchMode: "inherit",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

function role(): Role {
  return {
    id: "role-1",
    gameId: game.id,
    name: "Main",
    launchUrl: game.defaultLaunchUrl,
    notes: "",
    browserSessionSource: "managed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

const t: Translator = (key) => en[key];
