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
  Object.defineProperties(HTMLElement.prototype, {
    hasPointerCapture: { configurable: true, value: () => false },
    releasePointerCapture: { configurable: true, value: () => undefined },
    scrollIntoView: { configurable: true, value: () => undefined },
    setPointerCapture: { configurable: true, value: () => undefined }
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

  it("lists only same-game same-origin root roles and saves a one-way binding", async () => {
    const user = userEvent.setup();
    const selectedRole = role();
    const source = { ...role(), id: "source", name: "Source" };
    const wrongOrigin = { ...role(), id: "other-origin", name: "Other origin", launchUrl: "https://other.test/play" };
    const dependent = { ...role(), id: "dependent", name: "Dependent", localStorageSourceRoleId: source.id };
    const managedGame = { ...game, localStorageSyncKeys: ["game_client_settings"] };
    const onSave = vi.fn().mockResolvedValue(undefined);
    const router = createMemoryRouter([{
      path: "/roles/:id/edit",
      element: <RoleEditorRoute
        busyRoleIds={new Set()}
        games={[managedGame]}
        isSaving={false}
        roles={[selectedRole, source, wrongOrigin, dependent]}
        t={t}
        onClearBrowserData={vi.fn()}
        onError={vi.fn()}
        onSave={onSave}
      />
    }], { initialEntries: [`/roles/${selectedRole.id}/edit`] });
    render(<ConfirmationProvider><RouterProvider router={router} /></ConfirmationProvider>);

    await user.click(screen.getByRole("combobox", { name: "Source role" }));
    expect(screen.getByRole("option", { name: "Source" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Other origin" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Dependent" })).toBeNull();
    await user.click(screen.getByRole("option", { name: "Source" }));
    expect(screen.getByText("Sync direction: Source → this role")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      localStorageSourceRoleId: "source"
    }));
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
  localStorageSyncKeys: [],
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
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

const t: Translator = (key) => en[key];
