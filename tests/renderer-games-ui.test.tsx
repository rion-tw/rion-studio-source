// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ConfirmationProvider } from "../src/renderer/src/components/ConfirmationDialog";
import GameEditorRoute from "../src/renderer/src/features/games/GameModal";
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

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class ResizeObserver {
    disconnect(): void {}
    observe(): void {}
    unobserve(): void {}
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("games cover UI", () => {
  it("renders a clean cover section and keeps card actions independent from navigation", async () => {
    const user = userEvent.setup();
    const covered = game({ id: "covered", name: "Covered", coverImageDataUrl: processedCover });
    const uncovered = game({ id: "uncovered", name: "Uncovered" });
    const onEdit = vi.fn();
    const onNewRole = vi.fn();
    const { container } = render(
      <GamesRoute
        games={[covered, uncovered]}
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
    expect(coveredImage?.getAttribute("loading")).toBe("lazy");
    expect(coveredImage?.getAttribute("decoding")).toBe("async");
    expect(coveredImage?.classList.contains("transition-transform")).toBe(true);
    expect(coveredCard?.querySelector("[class*='group-hover:pointer-events-auto']")).toBeTruthy();
    expect(uncoveredCard?.querySelector(".aspect-video img")).toBeNull();
    expect(container.querySelectorAll(".aspect-video")).toHaveLength(2);
    expect(screen.queryByText("Roles")).toBeNull();
    expect(screen.queryByText("Running")).toBeNull();

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

    onNewRole.mockClear();
    expect(fireEvent.contextMenu(coveredCard as HTMLElement, { clientX: 240, clientY: 160 })).toBe(false);
    await user.click(screen.getByRole("menuitem", { name: "Add role" }));
    expect(onNewRole).toHaveBeenCalledWith("covered");
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
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    ...overrides
  };
}
