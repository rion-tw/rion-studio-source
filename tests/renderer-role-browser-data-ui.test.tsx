// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ConfirmationProvider } from "../src/renderer/src/components/ConfirmationDialog";
import RoleEditorRoute from "../src/renderer/src/features/roles/RoleModal";
import type { Translator } from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/en.json";
import type { AuthFlowStatus, Game, Role } from "../src/shared/types";

beforeAll(() => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    close: {
      configurable: true,
      value: function close(this: HTMLDialogElement): void {
        this.removeAttribute("open");
      }
    },
    showModal: {
      configurable: true,
      value: function showModal(this: HTMLDialogElement): void {
        this.setAttribute("open", "");
      }
    }
  });
});

afterEach(cleanup);

describe("role saved browser data controls", () => {
  it("shows the action for an existing role and keeps it independent from saving", async () => {
    const user = userEvent.setup();
    const selectedRole = role();
    const onClearBrowserData = vi.fn().mockResolvedValue(true);
    const router = createRoleRouter({
      initialEntry: `/roles/${selectedRole.id}/edit`,
      onClearBrowserData,
      roles: [selectedRole]
    });

    render(<ConfirmationProvider><RouterProvider router={router} /></ConfirmationProvider>);

    expect(screen.getByText("Re-login", { selector: "p" })).toBeTruthy();
    expect(screen.getByText("Stop the current role window and sign in again to refresh this role's saved session.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Re-login" })).toBeTruthy();
    expect(screen.getByText("Saved browser data")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Clear saved data" }));
    expect(onClearBrowserData).toHaveBeenCalledWith(selectedRole);
  });

  it("keeps the re-login context visible and disabled while login guidance is active", () => {
    const selectedRole = role();
    const router = createRoleRouter({
      authStatusByRole: new Map([[selectedRole.id, authStatus(selectedRole.id)]]),
      initialEntry: `/roles/${selectedRole.id}/edit`,
      onClearBrowserData: vi.fn(),
      roles: [selectedRole]
    });

    render(<ConfirmationProvider><RouterProvider router={router} /></ConfirmationProvider>);

    expect(screen.getByText("Re-login", { selector: "p" })).toBeTruthy();
    expect(screen.getByText("Stop the current role window and sign in again to refresh this role's saved session.")).toBeTruthy();
    expect(screen.getByText('Finish login for "Main"')).toBeTruthy();
    expect((screen.getByRole("button", { name: "Re-login" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("does not show the action while creating a role", () => {
    const router = createRoleRouter({
      initialEntry: "/roles/new",
      onClearBrowserData: vi.fn(),
      roles: []
    });

    render(<ConfirmationProvider><RouterProvider router={router} /></ConfirmationProvider>);

    expect(screen.queryByText("Saved browser data")).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear saved data" })).toBeNull();
  });

  it("disables the action while the role is busy", () => {
    const selectedRole = role();
    const router = createRoleRouter({
      busyRoleIds: new Set([selectedRole.id]),
      initialEntry: `/roles/${selectedRole.id}/edit`,
      onClearBrowserData: vi.fn(),
      roles: [selectedRole]
    });

    render(<ConfirmationProvider><RouterProvider router={router} /></ConfirmationProvider>);

    expect((screen.getByRole("button", { name: "Clear saved data" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

function createRoleRouter({
  initialEntry,
  onClearBrowserData,
  roles,
  authStatusByRole = new Map(),
  busyRoleIds = new Set()
}: {
  authStatusByRole?: Map<string, AuthFlowStatus>;
  busyRoleIds?: ReadonlySet<string>;
  initialEntry: string;
  onClearBrowserData: (role: Role) => Promise<boolean>;
  roles: Role[];
}) {
  return createMemoryRouter([
    {
      path: "/roles/new",
      element: roleEditor(roles, onClearBrowserData, authStatusByRole, busyRoleIds)
    },
    {
      path: "/roles/:id/edit",
      element: roleEditor(roles, onClearBrowserData, authStatusByRole, busyRoleIds)
    },
    { path: "/roles", element: <div>Role list</div> }
  ], { initialEntries: [initialEntry] });
}

function roleEditor(
  roles: Role[],
  onClearBrowserData: (role: Role) => Promise<boolean>,
  authStatusByRole: Map<string, AuthFlowStatus>,
  busyRoleIds: ReadonlySet<string>
) {
  return (
    <RoleEditorRoute
      authStatusByRole={authStatusByRole}
      busyRoleIds={busyRoleIds}
      games={[game]}
      isSaving={false}
      roles={roles}
      t={t}
      onClearBrowserData={onClearBrowserData}
      onError={vi.fn()}
      onRelogin={vi.fn()}
      onSave={vi.fn()}
    />
  );
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
    authState: "authenticated",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

const t: Translator = (key) => en[key];

function authStatus(roleId: string): AuthFlowStatus {
  return {
    roleId,
    state: "waiting_for_login",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}
