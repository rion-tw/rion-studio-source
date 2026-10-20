// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { RoleFormState } from "../src/renderer/src/app/types";
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
  if (!("PointerEvent" in window)) {
    Object.defineProperty(window, "PointerEvent", { configurable: true, value: MouseEvent });
  }
});

afterEach(cleanup);

const flyff = game("game-flyff", "Flyff", "https://universe.flyff.com/play");
const other = game("game-other", "Other", "https://other.test/play");
const third = game("game-third", "Third", "https://third.test/play");

describe("role editor game switching", () => {
  it("restores the role's custom launch URL after switching away and back", async () => {
    const onSave = vi.fn(async (form: RoleFormState) => ({ ...role(), ...form }));
    renderRoleEditor(role({ launchUrl: "https://private.test/play?realm=7" }), onSave);

    chooseGame("Other");
    expect(launchUrl()).toBe("https://private.test/play?realm=7");
    expect(screen.getByText(en["roleForm.gameChangeWarning"])).toBeTruthy();

    chooseGame("Flyff");
    expect(launchUrl()).toBe("https://private.test/play?realm=7");
    expect(screen.queryByText(en["roleForm.gameChangeWarning"])).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: en["roleForm.saveChanges"] }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      gameId: flyff.id,
      launchUrl: "https://private.test/play?realm=7"
    }));
  });

  it("prefers the role's saved launch URL over the game default when returning to its game", () => {
    renderRoleEditor(role({ launchUrl: "https://private.test/play?realm=7" }));

    chooseGame("Other");
    fireEvent.change(launchUrlInput(), { target: { value: "" } });
    chooseGame("Flyff");

    expect(launchUrl()).toBe("https://private.test/play?realm=7");
  });

  it("follows game defaults only while the launch URL is still the previous game's default", () => {
    renderRoleEditor(role());

    chooseGame("Other");
    expect(launchUrl()).toBe(other.defaultLaunchUrl);
    chooseGame("Third");
    expect(launchUrl()).toBe(third.defaultLaunchUrl);
    chooseGame("Flyff");
    expect(launchUrl()).toBe(flyff.defaultLaunchUrl);

    chooseGame("Other");
    fireEvent.change(launchUrlInput(), { target: { value: "https://typed.test/play" } });
    chooseGame("Third");
    expect(launchUrl()).toBe("https://typed.test/play");
    chooseGame("Flyff");
    expect(launchUrl()).toBe("https://typed.test/play");
  });

  it("treats another URL on the previous game's site as that game's URL", () => {
    const flyffSite = new URL(flyff.defaultLaunchUrl);
    renderRoleEditor(role({ launchUrl: `${flyffSite.origin}/` }));

    chooseGame("Other");
    expect(launchUrl()).toBe(other.defaultLaunchUrl);
  });
});

function chooseGame(name: string): void {
  fireEvent.click(screen.getByRole("combobox", { name: en["roleForm.game"] }));
  fireEvent.click(screen.getByRole("option", { name }));
}

function launchUrlInput(): HTMLInputElement {
  return screen.getByLabelText(en["roleForm.launchUrl"]) as HTMLInputElement;
}

function launchUrl(): string {
  return launchUrlInput().value;
}

function renderRoleEditor(
  selectedRole: Role,
  onSave: (form: RoleFormState) => Promise<Role | undefined> = vi.fn().mockResolvedValue(undefined)
): void {
  const router = createMemoryRouter([
    {
      path: "/roles/:id/edit",
      element: <RoleEditorRoute
        busyRoleIds={new Set()}
        games={[flyff, other, third]}
        isSaving={false}
        roles={[selectedRole]}
        t={t}
        onClearBrowserData={vi.fn().mockResolvedValue(true)}
        onError={vi.fn()}
        onSave={onSave}
      />
    },
    { path: "/roles", element: <div>Roles list</div> }
  ], { initialEntries: [`/roles/${selectedRole.id}/edit`] });
  render(<ConfirmationProvider><RouterProvider router={router} /></ConfirmationProvider>);
}

function game(id: string, name: string, defaultLaunchUrl: string): Game {
  return {
    id,
    source: "custom",
    name,
    defaultLaunchUrl,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function role(overrides: Partial<Role> = {}): Role {
  return {
    id: "role-1",
    gameId: flyff.id,
    name: "Main",
    launchUrl: flyff.defaultLaunchUrl,
    notes: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

const t: Translator = (key) => en[key];
