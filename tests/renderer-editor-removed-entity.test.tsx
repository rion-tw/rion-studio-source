// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type JSX, useState } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, expect, it, vi } from "vitest";

import { ConfirmationProvider } from "../src/renderer/src/components/ConfirmationDialog";
import ExtensionsRoute from "../src/renderer/src/features/extensions/ExtensionsRoute";
import GameEditorRoute from "../src/renderer/src/features/games/GameModal";
import RoleEditorRoute from "../src/renderer/src/features/roles/RoleModal";
import type { Translator } from "../src/renderer/src/i18n";
import type { RionStudioApi } from "../src/shared/api";
import type { ExtensionSnapshotRecord } from "../src/shared/generated";
import en from "../src/renderer/src/i18n/en.json";
import type { Game, Role } from "../src/shared/types";

class ResizeObserverStub { observe() {} unobserve() {} disconnect() {} }

beforeAll(() => {
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true, writable: true, value: ResizeObserverStub
  });
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

const t: Translator = (key) => en[key];

const game: Game = {
  id: "game-1",
  source: "custom",
  name: "Example",
  defaultLaunchUrl: "https://example.test/play",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

const role: Role = {
  id: "role-1",
  gameId: game.id,
  name: "Main",
  launchUrl: game.defaultLaunchUrl,
  notes: "",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

/**
 * Editor tests bake the route element into the router config, so re-rendering
 * RouterProvider cannot change the editor's props. This stateful wrapper owns
 * the projection instead, which is what a Core-driven snapshot push looks like
 * to the editor.
 */
let removeEntity: (() => void) | null = null;

function ProjectionHost({ initialRoles }: { initialRoles: Role[] }): JSX.Element {
  const [roles, setRoles] = useState(initialRoles);
  removeEntity = () => setRoles([]);
  return (
    <RoleEditorRoute
      busyRoleIds={new Set()}
      games={[game]}
      isSaving={false}
      roles={roles}
      t={t}
      onClearBrowserData={vi.fn().mockResolvedValue(true)}
      onError={vi.fn()}
      onSave={vi.fn().mockResolvedValue(undefined)}
    />
  );
}

function renderRoleEditor(initialRoles: Role[], entryId = role.id) {
  removeEntity = null;
  const router = createMemoryRouter(
    [{ path: "/roles/:id/edit", element: <ProjectionHost initialRoles={initialRoles} /> }],
    { initialEntries: [`/roles/${entryId}/edit`] }
  );
  return render(
    <ConfirmationProvider><RouterProvider router={router} /></ConfirmationProvider>
  );
}

const removedNotice = en["editor.removed.notice"];

it("keeps unsaved edits visible when the edited role leaves the projection", async () => {
  const user = userEvent.setup();
  renderRoleEditor([role]);

  const name = screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement;
  await user.clear(name);
  await user.type(name, "Renamed while editing");

  // A Core state change republishes the whole projection. Before the retained
  // entity, this unmounted the editor and silently discarded the typing.
  await vi.waitFor(() => expect(removeEntity).toBeTypeOf("function"));
  await user.click(document.body);
  removeEntity?.();

  const notice = await screen.findByRole("alert");
  expect(notice.textContent).toBe(removedNotice);
  expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value)
    .toBe("Renamed while editing");
  expect((screen.getByRole("button", { name: /Save changes/i }) as HTMLButtonElement).disabled)
    .toBe(true);
});

it("still reports a clean editor as not found when its role is removed", async () => {
  renderRoleEditor([role]);
  expect(screen.getByRole("textbox", { name: "Name" })).toBeTruthy();

  await vi.waitFor(() => expect(removeEntity).toBeTypeOf("function"));
  removeEntity?.();

  expect(await screen.findByRole("heading", { level: 1, name: en["editor.notFound.title"] }))
    .toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("reports a role id that never existed as not found", () => {
  renderRoleEditor([role], "role-missing");

  expect(screen.getByRole("heading", { level: 1, name: en["editor.notFound.title"] })).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
});

let removeGame: (() => void) | null = null;

function GameProjectionHost(): JSX.Element {
  const [games, setGames] = useState([game]);
  removeGame = () => setGames([]);
  return (
    <GameEditorRoute
      games={games}
      isSaving={false}
      t={t}
      onError={vi.fn()}
      onReset={vi.fn()}
      onSave={vi.fn().mockResolvedValue(undefined)}
    />
  );
}

it("keeps unsaved edits visible when the edited game leaves the projection", async () => {
  const user = userEvent.setup();
  const router = createMemoryRouter(
    [{ path: "/games/:id/edit", element: <GameProjectionHost /> }],
    { initialEntries: [`/games/${game.id}/edit`] }
  );
  render(<ConfirmationProvider><RouterProvider router={router} /></ConfirmationProvider>);

  const name = screen.getByRole("textbox", { name: en["games.form.name"] }) as HTMLInputElement;
  await user.clear(name);
  await user.type(name, "Renamed game");

  await vi.waitFor(() => expect(removeGame).toBeTypeOf("function"));
  removeGame?.();

  const notice = await screen.findByRole("alert");
  expect(notice.textContent).toBe(removedNotice);
  expect((screen.getByRole("textbox", { name: en["games.form.name"] }) as HTMLInputElement).value)
    .toBe("Renamed game");
});

const extensionId = "a".repeat(32);

const extensionSnapshot: ExtensionSnapshotRecord = {
  revision: 3,
  installed: [{
    id: extensionId,
    name: "Fixture",
    version: "1.0",
    description: "A useful fixture extension.",
    sizeBytes: 2_048,
    sha256: "0".repeat(64),
    directory: "/managed",
    permissions: [],
    enabledRoleIds: [],
    applyToAllRoles: false,
    removed: false
  }],
  roles: []
};

it("keeps an unsaved role scope visible when tombstone cleanup drops the package", async () => {
  const user = userEvent.setup();
  let publish!: (snapshot: ExtensionSnapshotRecord) => void;
  window.rionStudio = {
    extensions: vi.fn(async () => ({ snapshot: extensionSnapshot, lease: null, prepared: null })),
    extensionStore: vi.fn(async () => ({})),
    onExtensionsChanged: (listener: typeof publish) => { publish = listener; return () => undefined; },
    onExtensionStoreChanged: () => () => undefined
  } as unknown as RionStudioApi;

  const router = createMemoryRouter(
    [{ path: "/extensions/*", element: <ExtensionsRoute language="en" roles={[role]} t={t} /> }],
    { initialEntries: [`/extensions/${extensionId}/edit`] }
  );
  render(<ConfirmationProvider><RouterProvider router={router} /></ConfirmationProvider>);

  // Assigning the role makes the draft dirty.
  const checkbox = await screen.findByRole("checkbox");
  await user.click(checkbox);

  // Cleanup drops the package from the catalogue once the last lease releases.
  // That needs no navigation, so it can land while the scope is being edited.
  await act(async () => publish({ ...extensionSnapshot, revision: 4, installed: [] }));

  const notice = await screen.findByRole("alert");
  expect(notice.textContent).toBe(removedNotice);
  expect(screen.getByRole("checkbox").getAttribute("data-state")).toBe("checked");
});
