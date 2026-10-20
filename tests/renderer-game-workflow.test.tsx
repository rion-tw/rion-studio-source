// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { ConfirmationContext, type ConfirmationOptions } from "../src/renderer/src/components/confirmation";
import { useGameWorkflow } from "../src/renderer/src/hooks/useGameWorkflow";
import type { Translator } from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/en.json";
import type { Game, Role } from "../src/shared/types";

const t: Translator = (key) => en[key];

describe("useGameWorkflow delete confirmation", () => {
  it.each([
    ["an unassigned custom game", game("custom", "Custom"), [], en["games.delete.description"], false],
    [
      "an assigned custom game",
      game("custom", "Custom"),
      [role("Mage")],
      en["games.delete.inUse"].replace("{names}", "Mage"),
      true
    ],
    ["an assigned built-in game", game("builtin", "Flyff"), [role("Mage")], en["games.delete.builtin"], true],
    ["an unassigned built-in game", game("builtin", "Flyff"), [], en["games.delete.builtin"], true]
  ] as const)("explains why %s can or cannot be deleted", async (_label, target, roles, description, disabled) => {
    const confirm = vi.fn(async (_options: ConfirmationOptions) => false);
    const { result } = renderHook(() => useGameWorkflow({
      beginErrorOperation: () => vi.fn(),
      roles: roles.map((item) => ({ ...item, gameId: target.id })),
      t
    }), { wrapper: confirmationWrapper(confirm) });

    await act(async () => {
      await result.current.deleteGame(target);
    });

    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
      confirmDisabled: disabled,
      description,
      title: `Delete ${target.name}?`
    }));
  });

  it("keeps dollar signs in names literal", async () => {
    const confirm = vi.fn(async (_options: ConfirmationOptions) => false);
    const target = game("custom", "Rich$$ $& Guild");
    const { result } = renderHook(() => useGameWorkflow({
      beginErrorOperation: () => vi.fn(),
      roles: [{ ...role("$` Alt"), gameId: target.id }],
      t
    }), { wrapper: confirmationWrapper(confirm) });

    await act(async () => {
      await result.current.deleteGame(target);
    });

    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
      description: "Move or delete these assigned roles first: $` Alt.",
      title: "Delete Rich$$ $& Guild?"
    }));
  });
});

function confirmationWrapper(confirm: (options: ConfirmationOptions) => Promise<boolean>) {
  return function ConfirmationWrapper({ children }: { children: ReactNode }) {
    return <ConfirmationContext.Provider value={confirm}>{children}</ConfirmationContext.Provider>;
  };
}

function game(source: Game["source"], name: string): Game {
  return {
    id: `game-${source}`,
    source,
    name,
    defaultLaunchUrl: "https://example.test/",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  } as Game;
}

function role(name: string): Role {
  return {
    id: `role-${name}`,
    gameId: "",
    name,
    launchUrl: "https://example.test/",
    notes: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  } as Role;
}
