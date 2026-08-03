// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { MacroRoleCombobox } from "../src/renderer/src/features/macros/MacroRoleCombobox";
import type { Translator } from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/en.json";
import type { Game, Role } from "../src/shared/types";

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class ResizeObserver {
    disconnect(): void {}
    observe(): void {}
    unobserve(): void {}
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => undefined
  });
});

afterEach(cleanup);
afterAll(() => vi.unstubAllGlobals());

describe("macro role combobox", () => {
  it("groups roles in game and role order while updating selected chips", async () => {
    const user = userEvent.setup();
    render(
      <RoleComboboxHarness
        games={[game("game-b", "Game B"), game("game-a", "Game A"), game("empty", "Empty game")]}
        initialValue={["role-2"]}
        roles={[
          role("role-1", "First", "game-b"),
          role("role-2", "Second", "game-b"),
          role("role-3", "Third", "game-a")
        ]}
      />
    );

    expect(screen.getByRole("button", { name: "Remove Second" })).toBeTruthy();
    await user.click(screen.getByRole("combobox", { name: "Execution roles" }));
    const listbox = await screen.findByRole("listbox");
    const listText = listbox.textContent ?? "";
    expect(listText.indexOf("Game B")).toBeLessThan(listText.indexOf("First"));
    expect(listText.indexOf("First")).toBeLessThan(listText.indexOf("Second"));
    expect(listText.indexOf("Second")).toBeLessThan(listText.indexOf("Game A"));
    expect(listText.indexOf("Game A")).toBeLessThan(listText.indexOf("Third"));
    expect(listText).not.toContain("Empty game");

    await user.click(within(listbox).getByRole("option", { name: "Third" }));
    expect(screen.getByTestId("selected-role-ids").textContent).toBe("role-2,role-3");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Remove Second" }));
    expect(screen.getByTestId("selected-role-ids").textContent).toBe("role-3");
  });

  it("filters by role name and supports keyboard selection and dismissal", async () => {
    const user = userEvent.setup();
    render(
      <RoleComboboxHarness
        games={[game("game-1", "Game One")]}
        initialValue={[]}
        roles={[role("role-1", "First", "game-1"), role("role-2", "Second", "game-1")]}
      />
    );
    const input = screen.getByRole("combobox", { name: "Execution roles" });

    await user.click(input);
    await user.type(input, "Second");
    expect(await screen.findByRole("option", { name: "Second" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "First" })).toBeNull();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(screen.getByTestId("selected-role-ids").textContent).toBe("role-2");

    await user.click(input);
    await user.clear(input);
    await user.type(input, "missing");
    expect(await screen.findByText("No roles found.")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(input.getAttribute("aria-expanded")).toBe("false");
  });

  it("preserves unavailable role ids as removable chips", async () => {
    const user = userEvent.setup();
    render(
      <RoleComboboxHarness
        games={[game("game-1", "Game One")]}
        initialValue={["missing-role"]}
        roles={[role("role-1", "First", "game-1")]}
      />
    );

    await user.click(screen.getByRole("combobox", { name: "Execution roles" }));
    expect(await screen.findByText("Unavailable roles")).toBeTruthy();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Remove Unknown role" }));
    expect(screen.getByTestId("selected-role-ids").textContent).toBe("");
  });

  it("disables the input and chip removal while saving", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <MacroRoleCombobox
        disabled
        games={[game("game-1", "Game One")]}
        roles={[role("role-1", "First", "game-1")]}
        t={t}
        value={["role-1"]}
        onValueChange={onValueChange}
      />
    );
    const input = screen.getByRole("combobox", { name: "Execution roles" });
    const removeButton = screen.getByRole("button", { name: "Remove First" });

    expect(input.hasAttribute("disabled")).toBe(true);
    expect(removeButton.getAttribute("aria-disabled")).toBe("true");
    await user.click(input);
    await user.click(removeButton);
    expect(onValueChange).not.toHaveBeenCalled();
  });
});

function RoleComboboxHarness({
  games,
  initialValue,
  roles
}: {
  games: Game[];
  initialValue: string[];
  roles: Role[];
}) {
  const [value, setValue] = useState(initialValue);
  return (
    <>
      <MacroRoleCombobox games={games} roles={roles} t={t} value={value} onValueChange={setValue} />
      <output data-testid="selected-role-ids">{value.join(",")}</output>
    </>
  );
}

const t: Translator = (key) => en[key];

function game(id: string, name: string): Game {
  return {
    id,
    source: "custom",
    name,
    defaultLaunchUrl: `https://${id}.example.test/play`,
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z"
  };
}

function role(id: string, name: string, gameId: string): Role {
  return {
    id,
    gameId,
    name,
    launchUrl: `https://${gameId}.example.test/play`,
    notes: "",
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z"
  };
}
