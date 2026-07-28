// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfirmationProvider } from "../src/renderer/src/components/ConfirmationDialog";
import GameEditorRoute from "../src/renderer/src/features/games/GameModal";
import { parseLocalStorageSyncKeys } from "../src/renderer/src/features/games/localStorageSyncKeys";
import GamesRoute from "../src/renderer/src/features/games/GamesRoute";
import type { Translator } from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/en.json";
import type { Game } from "../src/shared/types";

const { processedCover } = vi.hoisted(() => ({
  processedCover: "data:image/webp;base64,UFJPQ0VTU0VE"
}));

vi.mock("../src/renderer/src/features/games/gameCover", () => ({
  createGameCoverImageDataUrl: vi.fn().mockResolvedValue(processedCover)
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("games cover UI", () => {
  it("normalizes the compact one-key-per-line editor input", () => {
    expect(parseLocalStorageSyncKeys(" game_client_settings \n audio\ngame_client_settings\n"))
      .toEqual(["game_client_settings", "audio"]);
  });

  it("keeps newlines editable and saves the normalized localStorage key list", async () => {
    const user = userEvent.setup();
    const customGame = game({ id: "game-keys", name: "Keyed game" });
    const onSave = vi.fn().mockResolvedValue(customGame);
    const router = createMemoryRouter([{
      path: "/games/:id/edit",
      element: <ConfirmationProvider><GameEditorRoute
        games={[customGame]}
        isSaving={false}
        t={t}
        onError={vi.fn()}
        onReset={vi.fn()}
        onSave={onSave}
      /></ConfirmationProvider>
    }], { initialEntries: ["/games/game-keys/edit"] });
    render(<RouterProvider router={router} />);

    const editor = screen.getByLabelText("Managed keys") as HTMLTextAreaElement;
    await user.type(editor, "game_client_settings{enter}audio");
    expect(editor.value).toBe("game_client_settings\naudio");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      localStorageSyncKeys: ["game_client_settings", "audio"]
    }));
  });

  it("renders a clean cover section and keeps card actions independent from navigation", async () => {
    const user = userEvent.setup();
    const covered = game({ id: "covered", name: "Covered", coverImageDataUrl: processedCover });
    const uncovered = game({ id: "uncovered", name: "Uncovered" });
    const onEdit = vi.fn();
    const onNewRole = vi.fn();
    const { container } = render(
      <GamesRoute
        games={[covered, uncovered]}
        roles={[]}
        statusByRole={new Map()}
        t={t}
        onDelete={vi.fn()}
        onDeleteMany={vi.fn().mockResolvedValue(false)}
        onEdit={onEdit}
        onNewGame={vi.fn()}
        onNewRole={onNewRole}
      />
    );

    const coveredCard = screen.getByText("Covered").closest(".glass-panel");
    const uncoveredCard = screen.getByText("Uncovered").closest(".glass-panel");
    expect(coveredCard).toBeTruthy();
    expect(uncoveredCard).toBeTruthy();
    expect(coveredCard?.querySelector(`img[src="${processedCover}"]`)).toBeTruthy();
    const coveredImage = coveredCard?.querySelector(`img[src="${processedCover}"]`);
    expect(coveredImage?.classList.contains("game-motion-transform")).toBe(true);
    expect(coveredImage?.classList.contains("transition-transform")).toBe(true);
    expect(coveredCard?.querySelector(".game-motion-opacity")).toBeTruthy();
    expect(uncoveredCard?.querySelector(".aspect-video img")).toBeNull();
    expect(container.querySelectorAll(".aspect-video")).toHaveLength(2);

    await user.click(screen.getByText("Covered"));
    expect(onEdit).toHaveBeenCalledWith(covered);

    onEdit.mockClear();
    const coveredCardQueries = within(coveredCard as HTMLElement);
    await user.click(coveredCardQueries.getByRole("button", { name: "Game actions" }));
    expect(coveredCardQueries.queryByRole("menuitem", { name: /compatibility/i })).toBeNull();
    await user.click(coveredCardQueries.getByRole("menuitem", { name: "Add role" }));
    expect(onNewRole).toHaveBeenCalledWith("covered");
    expect(onEdit).not.toHaveBeenCalled();

    await user.click(coveredCardQueries.getByRole("button", { name: "Game actions" }));
    await user.click(coveredCardQueries.getByRole("menuitem", { name: "Edit" }));
    expect(onEdit).toHaveBeenCalledWith(covered);
  });

  it("uploads and removes a custom game cover in the editor", async () => {
    const user = userEvent.setup();
    const customGame = game({
      id: "game-1",
      name: "Custom game",
      iconImageDataUrl: "data:image/png;base64,SUNPTg=="
    });
    const router = createMemoryRouter([{
      path: "/games/:id/edit",
      element: <ConfirmationProvider><GameEditorRoute
        games={[customGame]}
        isSaving={false}
        t={t}
        onError={vi.fn()}
        onReset={vi.fn()}
        onSave={vi.fn()}
      /></ConfirmationProvider>
    }], { initialEntries: ["/games/game-1/edit"] });
    const { container } = render(<RouterProvider router={router} />);
    const file = new File(["cover"], "cover.png", { type: "image/png" });

    await user.upload(screen.getByLabelText("Choose cover"), file);
    expect(container.querySelector(`img[src="${processedCover}"]`)).toBeTruthy();

    const removeCoverButton = screen.getByRole("button", { name: "Remove cover" });
    const removeIconButton = screen.getByRole("button", { name: "Remove icon" });
    expect(removeCoverButton.className).toContain("size-[var(--control-min-size)]");
    expect(removeIconButton.className).toContain("size-[var(--control-min-size)]");

    await user.click(removeCoverButton);
    expect(container.querySelector(`img[src="${processedCover}"]`)).toBeNull();
  });

  it("shows the packaged cover without editing controls for a built-in game", () => {
    const builtinGame = game({
      id: "builtin-flyff-universe",
      source: "builtin",
      builtinKey: "flyff-universe",
      name: "Flyff Universe"
    });
    const router = createMemoryRouter([{
      path: "/games/:id/edit",
      element: <ConfirmationProvider><GameEditorRoute
        games={[builtinGame]}
        isSaving={false}
        t={t}
        onError={vi.fn()}
        onReset={vi.fn()}
        onSave={vi.fn()}
      /></ConfirmationProvider>
    }], { initialEntries: ["/games/builtin-flyff-universe/edit"] });
    const { container } = render(<RouterProvider router={router} />);

    expect(screen.getByText("The packaged cover is used for this built-in game.")).toBeTruthy();
    expect(screen.queryByLabelText("Choose cover")).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove cover" })).toBeNull();
    expect(container.querySelector('img[src*="flyff-universe-cover"]')).toBeTruthy();
  });

});

const t: Translator = (key) => en[key];

function game(overrides: Partial<Game> = {}): Game {
  return {
    id: "game",
    source: "custom",
    name: "Game",
    defaultLaunchUrl: "https://example.test/play",
    localStorageSyncKeys: [],
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    ...overrides
  };
}
