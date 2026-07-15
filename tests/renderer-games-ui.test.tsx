// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfirmationProvider } from "../src/renderer/src/components/ConfirmationDialog";
import GameEditorRoute from "../src/renderer/src/features/games/GameModal";
import GamesRoute from "../src/renderer/src/features/games/GamesRoute";
import type { Translator } from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/en.json";
import type { Game, RoleDefaults } from "../src/shared/types";

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
  it("renders a clean cover section and keeps card actions independent from navigation", async () => {
    const user = userEvent.setup();
    const covered = game({ id: "covered", name: "Covered", coverImageDataUrl: processedCover });
    const uncovered = game({ id: "uncovered", name: "Uncovered" });
    const onEdit = vi.fn();
    const onView = vi.fn();
    const { container } = render(
      <GamesRoute
        games={[covered, uncovered]}
        reports={[]}
        roles={[]}
        runStatuses={[]}
        statusByRole={new Map()}
        t={t}
        onDelete={vi.fn()}
        onEdit={onEdit}
        onNewGame={vi.fn()}
        onNewRole={vi.fn()}
        onView={onView}
      />
    );

    const coveredCard = screen.getByText("Covered").closest(".glass-panel");
    const uncoveredCard = screen.getByText("Uncovered").closest(".glass-panel");
    expect(coveredCard).toBeTruthy();
    expect(uncoveredCard).toBeTruthy();
    expect(coveredCard?.querySelector(`img[src="${processedCover}"]`)).toBeTruthy();
    expect(uncoveredCard?.querySelector(".aspect-video img")).toBeNull();
    expect(container.querySelectorAll(".aspect-video")).toHaveLength(2);

    await user.click(screen.getByText("Covered"));
    expect(onView).toHaveBeenCalledWith(covered);

    onView.mockClear();
    await user.click(within(coveredCard as HTMLElement).getByTitle("Edit"));
    expect(onEdit).toHaveBeenCalledWith(covered);
    expect(onView).not.toHaveBeenCalled();
  });

  it("uploads and removes a custom game cover in the editor", async () => {
    const user = userEvent.setup();
    const customGame = game({ id: "game-1", name: "Custom game" });
    const router = createMemoryRouter([{
      path: "/games/:id/edit",
      element: <ConfirmationProvider><GameEditorRoute
        games={[customGame]}
        isSaving={false}
        roleDefaults={roleDefaults}
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

    await user.click(screen.getByRole("button", { name: "Remove cover" }));
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
        roleDefaults={roleDefaults}
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

const roleDefaults: RoleDefaults = {
  windowWidth: 1440,
  windowHeight: 900,
  launchPreset: "performance"
};

const t: Translator = (key) => en[key];

function game(overrides: Partial<Game> = {}): Game {
  return {
    id: "game",
    source: "custom",
    name: "Game",
    defaultLaunchUrl: "https://example.test/play",
    browserLaunchMode: "inherit",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    ...overrides
  };
}
