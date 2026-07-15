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
    const onNewRole = vi.fn();
    const onRunCheck = vi.fn();
    const { container } = render(
      <GamesRoute
        games={[covered, uncovered]}
        reports={[]}
        roles={[]}
        runStatuses={[]}
        statusByRole={new Map()}
        t={t}
        onDelete={vi.fn()}
        onDeleteMany={vi.fn().mockResolvedValue(false)}
        onEdit={onEdit}
        onNewGame={vi.fn()}
        onNewRole={onNewRole}
        onRunCheck={onRunCheck}
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
    expect(onEdit).toHaveBeenCalledWith(covered);

    onEdit.mockClear();
    const coveredCardQueries = within(coveredCard as HTMLElement);
    await user.click(coveredCardQueries.getByRole("button", { name: "Game actions" }));
    await user.click(coveredCardQueries.getByRole("menuitem", { name: "Add role" }));
    expect(onNewRole).toHaveBeenCalledWith("covered");
    expect(onEdit).not.toHaveBeenCalled();

    await user.click(coveredCardQueries.getByRole("button", { name: "Game actions" }));
    await user.click(coveredCardQueries.getByRole("menuitem", { name: "Run compatibility check" }));
    expect(onRunCheck).toHaveBeenCalledWith("covered");

    await user.click(coveredCardQueries.getByRole("button", { name: "Game actions" }));
    await user.click(coveredCardQueries.getByRole("menuitem", { name: "Edit" }));
    expect(onEdit).toHaveBeenCalledWith(covered);
  });

  it("replaces the built-in and embedded-available badges with a compatibility shield", () => {
    const builtinGame = game({
      id: "builtin-flyff-universe",
      source: "builtin",
      builtinKey: "flyff-universe",
      name: "Flyff Universe"
    });
    render(
      <GamesRoute
        games={[builtinGame]}
        reports={[{
          gameId: builtinGame.id,
          checkedAt: "2026-07-15T01:00:00.000Z",
          isStale: false,
          load: { state: "available", durationMs: 321, finalOrigin: "https://example.test" },
          recommendation: { mode: "embedded", reason: "embedded_available" },
          observations: {}
        }]}
        roles={[]}
        runStatuses={[]}
        statusByRole={new Map()}
        t={t}
        onDelete={vi.fn()}
        onDeleteMany={vi.fn().mockResolvedValue(false)}
        onEdit={vi.fn()}
        onNewGame={vi.fn()}
        onNewRole={vi.fn()}
        onRunCheck={vi.fn()}
      />
    );

    const card = screen.getByText("Flyff Universe").closest(".glass-panel");
    const cardQueries = within(card as HTMLElement);
    const shield = cardQueries.getByRole("img", {
      name: "Embedded mode is available; no settings were changed."
    });

    expect(cardQueries.queryByText("Built-in")).toBeNull();
    expect(cardQueries.queryByText("Embedded available")).toBeNull();
    expect(shield.getAttribute("title")).toBe("Embedded mode is available; no settings were changed.");
    expect(shield.classList.contains("text-emerald-500")).toBe(true);
  });

  it("shows an outdated compatibility result beside the game name instead of below the metrics", () => {
    const staleGame = game({ id: "stale-game", name: "Stale game" });
    render(
      <GamesRoute
        games={[staleGame]}
        reports={[{
          gameId: staleGame.id,
          checkedAt: "2026-07-15T01:00:00.000Z",
          isStale: true,
          load: { state: "available", durationMs: 321, finalOrigin: "https://example.test" },
          recommendation: { mode: "embedded", reason: "embedded_available" },
          observations: {}
        }]}
        roles={[]}
        runStatuses={[]}
        statusByRole={new Map()}
        t={t}
        onDelete={vi.fn()}
        onDeleteMany={vi.fn().mockResolvedValue(false)}
        onEdit={vi.fn()}
        onNewGame={vi.fn()}
        onNewRole={vi.fn()}
        onRunCheck={vi.fn()}
      />
    );

    const card = screen.getByText("Stale game").closest(".glass-panel");
    const cardQueries = within(card as HTMLElement);
    const staleBadge = cardQueries.getByText("Result may be outdated");

    expect(staleBadge.parentElement).toBe(cardQueries.getByText("Stale game").parentElement);
    expect(staleBadge.closest("button")).toBeTruthy();
    expect(cardQueries.getAllByText("Result may be outdated")).toHaveLength(1);
  });

  it("shows the not-checked status beside the game name", () => {
    const uncheckedGame = game({ id: "unchecked-game", name: "Unchecked game" });
    render(
      <GamesRoute
        games={[uncheckedGame]}
        reports={[]}
        roles={[]}
        runStatuses={[]}
        statusByRole={new Map()}
        t={t}
        onDelete={vi.fn()}
        onDeleteMany={vi.fn().mockResolvedValue(false)}
        onEdit={vi.fn()}
        onNewGame={vi.fn()}
        onNewRole={vi.fn()}
        onRunCheck={vi.fn()}
      />
    );

    const card = screen.getByText("Unchecked game").closest(".glass-panel");
    const cardQueries = within(card as HTMLElement);
    const notCheckedBadge = cardQueries.getByText("Not checked");

    expect(notCheckedBadge.parentElement).toBe(cardQueries.getByText("Unchecked game").parentElement);
    expect(notCheckedBadge.closest("button")).toBeTruthy();
    expect(cardQueries.getAllByText("Not checked")).toHaveLength(1);
  });

  it("shows every compatibility status in the shield position beside the game name", () => {
    const checkingGame = game({ id: "checking-game", name: "Checking game" });
    const failedGame = game({ id: "failed-game", name: "Failed game" });
    const cancelledGame = game({ id: "cancelled-game", name: "Cancelled game" });
    const graphicsGame = game({ id: "graphics-game", name: "Graphics game" });
    render(
      <GamesRoute
        games={[checkingGame, failedGame, cancelledGame, graphicsGame]}
        reports={[
          {
            gameId: failedGame.id,
            isStale: false,
            load: { state: "failed", durationMs: 321 },
            recommendation: { mode: "external", reason: "external_recommended" },
            observations: {}
          },
          {
            gameId: cancelledGame.id,
            isStale: false,
            load: { state: "cancelled", durationMs: 321 },
            observations: {}
          },
          {
            gameId: graphicsGame.id,
            isStale: false,
            load: { state: "available", durationMs: 321 },
            recommendation: { mode: "external", reason: "graphics_unavailable" },
            observations: {}
          }
        ]}
        roles={[]}
        runStatuses={[{
          gameId: checkingGame.id,
          phase: "loading",
          startedAt: "2026-07-15T01:00:00.000Z",
          updatedAt: "2026-07-15T01:00:01.000Z"
        }]}
        statusByRole={new Map()}
        t={t}
        onDelete={vi.fn()}
        onDeleteMany={vi.fn().mockResolvedValue(false)}
        onEdit={vi.fn()}
        onNewGame={vi.fn()}
        onNewRole={vi.fn()}
        onRunCheck={vi.fn()}
      />
    );

    for (const [gameName, status] of [
      ["Checking game", "Checking"],
      ["Failed game", "Embedded failed"],
      ["Cancelled game", "Check cancelled"],
      ["Graphics game", "Graphics capability limited"]
    ]) {
      const card = screen.getByText(gameName).closest(".glass-panel");
      const cardQueries = within(card as HTMLElement);
      const statusBadge = cardQueries.getByText(status);

      expect(statusBadge.parentElement).toBe(cardQueries.getByText(gameName).parentElement);
      expect(statusBadge.closest("button")).toBeTruthy();
      expect(cardQueries.getAllByText(status)).toHaveLength(1);
    }
  });

  it("uploads and removes a custom game cover in the editor", async () => {
    const user = userEvent.setup();
    const customGame = game({ id: "game-1", name: "Custom game" });
    const router = createMemoryRouter([{
      path: "/games/:id/edit",
      element: <ConfirmationProvider><GameEditorRoute
        games={[customGame]}
        isSaving={false}
        reports={[]}
        roleDefaults={roleDefaults}
        runStatuses={[]}
        t={t}
        onApplyRecommendation={vi.fn().mockResolvedValue(undefined)}
        onCancelCheck={vi.fn()}
        onError={vi.fn()}
        onOpenGraphicsSettings={vi.fn()}
        onReset={vi.fn()}
        onRunCheck={vi.fn()}
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
        reports={[]}
        roleDefaults={roleDefaults}
        runStatuses={[]}
        t={t}
        onApplyRecommendation={vi.fn().mockResolvedValue(undefined)}
        onCancelCheck={vi.fn()}
        onError={vi.fn()}
        onOpenGraphicsSettings={vi.fn()}
        onReset={vi.fn()}
        onRunCheck={vi.fn()}
        onSave={vi.fn()}
      /></ConfirmationProvider>
    }], { initialEntries: ["/games/builtin-flyff-universe/edit"] });
    const { container } = render(<RouterProvider router={router} />);

    expect(screen.getByText("The packaged cover is used for this built-in game.")).toBeTruthy();
    expect(screen.queryByLabelText("Choose cover")).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove cover" })).toBeNull();
    expect(container.querySelector('img[src*="flyff-universe-cover"]')).toBeTruthy();
  });

  it("shows compatibility information and controls inside the game editor", async () => {
    const user = userEvent.setup();
    const customGame = game({ id: "game-1", name: "Custom game" });
    const onRunCheck = vi.fn();
    const router = createMemoryRouter([{
      path: "/games/:id/edit",
      element: <ConfirmationProvider><GameEditorRoute
        games={[customGame]}
        isSaving={false}
        reports={[{
          gameId: customGame.id,
          checkedAt: "2026-07-15T01:00:00.000Z",
          isStale: false,
          load: { state: "available", durationMs: 321, finalOrigin: "https://example.test" },
          recommendation: { mode: "embedded", reason: "embedded_available" },
          observations: {}
        }]}
        roleDefaults={roleDefaults}
        runStatuses={[]}
        t={t}
        onApplyRecommendation={vi.fn().mockResolvedValue(undefined)}
        onCancelCheck={vi.fn()}
        onError={vi.fn()}
        onOpenGraphicsSettings={vi.fn()}
        onReset={vi.fn()}
        onRunCheck={onRunCheck}
        onSave={vi.fn()}
      /></ConfirmationProvider>
    }], { initialEntries: ["/games/game-1/edit"] });
    render(<RouterProvider router={router} />);

    expect(screen.getByText("Embedded available")).toBeTruthy();
    expect(screen.getByText("321 ms")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Run compatibility check" }));
    expect(onRunCheck).toHaveBeenCalledWith(customGame.id);
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
