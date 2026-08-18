// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  it("edits the name through the first labeled form input", async () => {
    const user = userEvent.setup();
    const selectedRole = role();
    const onSave = vi.fn().mockResolvedValue(undefined);
    const router = createRoleRouter(selectedRole, vi.fn().mockResolvedValue(true), onSave);
    const { container } = render(<ConfirmationProvider><RouterProvider router={router} /></ConfirmationProvider>);
    const name = screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement;

    expect(screen.getByRole("heading", { level: 1, name: "Edit Role" })).toBeTruthy();
    expect(container.querySelector("[contenteditable]")).toBeNull();
    expect(name.value).toBe("Main");
    expect(name.name).toBe("name");
    expect(name.maxLength).toBe(80);
    expect(screen.getByText("Use a recognizable name for this isolated browser session.")).toBeTruthy();
    await user.clear(name);
    await user.type(name, "Renamed role");
    fireEvent.submit(name.closest("form")!);

    await waitFor(() => expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ name: "Renamed role" })));
  });

  it("shows the clear action without login or re-login controls", async () => {
    const user = userEvent.setup();
    const selectedRole = role();
    const onClearBrowserData = vi.fn().mockResolvedValue(true);
    const router = createRoleRouter(selectedRole, onClearBrowserData);
    render(<ConfirmationProvider><RouterProvider router={router} /></ConfirmationProvider>);

    expect(screen.queryByText("Re-login")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Source role" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Clear saved data" }));
    expect(onClearBrowserData).toHaveBeenCalledWith(selectedRole);
  });
});

function createRoleRouter(
  selectedRole: Role,
  onClearBrowserData: (role: Role) => Promise<boolean>,
  onSave = vi.fn()
) {
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
      onSave={onSave}
    />
  }], { initialEntries: [`/roles/${selectedRole.id}/edit`] });
}

const game: Game = {
  id: "game-1",
  source: "custom",
  name: "Example",
  defaultLaunchUrl: "https://example.test/play",
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
