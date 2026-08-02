// @vitest-environment jsdom

import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FIRST_RUN_ONBOARDING_STORAGE_KEY } from "../src/renderer/src/app/constants";
import { FirstRunOnboarding } from "../src/renderer/src/features/onboarding/FirstRunOnboarding";
import {
  readFirstRunOnboardingRecord,
  useFirstRunOnboarding
} from "../src/renderer/src/hooks/useFirstRunOnboarding";
import type { Translator } from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/en.json";
import type { Game, Role, RoleStatus } from "../src/shared/types";

const t: Translator = (key) => en[key];

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

describe("first-run onboarding persistence", () => {
  it("rejects malformed and unknown-version records", () => {
    localStorage.setItem(FIRST_RUN_ONBOARDING_STORAGE_KEY, "not-json");
    expect(readFirstRunOnboardingRecord()).toBeNull();

    localStorage.setItem(FIRST_RUN_ONBOARDING_STORAGE_KEY, JSON.stringify({
      version: 2,
      state: "completed"
    }));
    expect(readFirstRunOnboardingRecord()).toBeNull();
  });

  it("starts for an empty role list and keeps the success screen open after persisting completion", async () => {
    const { result } = renderHook(() => useFirstRunOnboarding({ enabled: true, roles: [] }));

    await waitFor(() => expect(result.current.isVisible).toBe(true));
    expect(readFirstRunOnboardingRecord()).toEqual({ version: 1, state: "in_progress" });

    act(() => result.current.updateProgress({ gameId: "game-1", roleId: "role-1" }));
    expect(readFirstRunOnboardingRecord()).toEqual({
      version: 1,
      state: "in_progress",
      gameId: "game-1",
      roleId: "role-1"
    });

    act(() => result.current.complete());
    expect(result.current.isVisible).toBe(true);
    expect(result.current.isSuccessPresented).toBe(true);
    expect(readFirstRunOnboardingRecord()).toEqual({ version: 1, state: "completed" });

    act(() => result.current.dismissSuccess());
    expect(result.current.isVisible).toBe(false);
  });

  it("automatically completes for an existing user and permanently hides after skip", async () => {
    const existingRole = role();
    const existing = renderHook(() => useFirstRunOnboarding({ enabled: true, roles: [existingRole] }));

    await waitFor(() => expect(readFirstRunOnboardingRecord()).toEqual({ version: 1, state: "completed" }));
    expect(existing.result.current.isVisible).toBe(false);
    existing.unmount();

    localStorage.clear();
    const fresh = renderHook(() => useFirstRunOnboarding({ enabled: true, roles: [] }));
    await waitFor(() => expect(fresh.result.current.isVisible).toBe(true));
    act(() => fresh.result.current.skip());
    expect(fresh.result.current.isVisible).toBe(false);
    expect(readFirstRunOnboardingRecord()).toEqual({ version: 1, state: "skipped" });
  });
});

describe("first-run onboarding flow", () => {
  it("selects a built-in game, creates one role, launches it, and shows success", async () => {
    const user = userEvent.setup();
    const flyff = game();
    const savedRole = role({ gameId: flyff.id, name: "Main" });
    const onSave = vi.fn().mockResolvedValue(savedRole);
    const onLaunch = vi.fn().mockResolvedValue({ roleId: savedRole.id, state: "running" });
    const onComplete = vi.fn();
    const onUpdateProgress = vi.fn();
    renderOnboarding({ games: [flyff, chinaGame()], onComplete, onLaunch, onSave, onUpdateProgress });

    const next = screen.getByRole("button", { name: "Next" }) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    await user.click(screen.getByRole("radio", { name: /Flyff Universe/ }));
    expect(next.disabled).toBe(false);
    await user.click(next);

    const name = screen.getByRole("textbox", { name: "Role name" });
    expect(document.activeElement).toBe(name);
    await user.type(name, "Main");
    await user.click(screen.getByRole("button", { name: "Create and open" }));

    await screen.findByText("Your first role is running");
    expect(onSave).toHaveBeenCalledWith({
      gameId: flyff.id,
      launchUrl: flyff.defaultLaunchUrl,
      name: "Main",
      notes: ""
    });
    expect(onLaunch).toHaveBeenCalledWith(savedRole.id);
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onUpdateProgress).toHaveBeenNthCalledWith(1, { gameId: flyff.id, roleId: undefined });
    expect(onUpdateProgress).toHaveBeenNthCalledWith(2, { gameId: flyff.id, roleId: savedRole.id });
  });

  it("retries a failed launch without creating a duplicate role", async () => {
    const user = userEvent.setup();
    const flyff = game();
    const savedRole = role({ gameId: flyff.id, name: "Retry role" });
    const onSave = vi.fn().mockResolvedValue(savedRole);
    const onLaunch = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ roleId: savedRole.id, state: "running" } satisfies RoleStatus);
    renderOnboarding({ games: [flyff], onLaunch, onSave });

    await user.click(screen.getByRole("radio", { name: /Flyff Universe/ }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.type(screen.getByRole("textbox", { name: "Role name" }), "Retry role");
    await user.click(screen.getByRole("button", { name: "Create and open" }));

    await screen.findByRole("button", { name: "Retry opening" });
    expect(screen.getByRole("alert").textContent).toContain("The game could not be opened");
    await user.click(screen.getByRole("button", { name: "Retry opening" }));

    await screen.findByText("Your first role is running");
    expect(onSave).toHaveBeenCalledOnce();
    expect(onLaunch).toHaveBeenCalledTimes(2);
  });

  it("resumes at the launch step for a saved role and exposes both permanent exits", async () => {
    const user = userEvent.setup();
    const flyff = game();
    const savedRole = role({ gameId: flyff.id });
    const onCustomGame = vi.fn();
    const onOpenLater = vi.fn();
    const { unmount } = renderOnboarding({
      games: [flyff],
      progress: { version: 1, state: "in_progress", gameId: flyff.id, roleId: savedRole.id },
      roles: [savedRole],
      onOpenLater
    });

    expect(screen.getByText("The role is ready")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Open later" }));
    expect(onOpenLater).toHaveBeenCalledOnce();
    unmount();

    renderOnboarding({ games: [flyff], onCustomGame });
    await user.click(screen.getByRole("button", { name: "I use another game" }));
    expect(onCustomGame).toHaveBeenCalledOnce();
  });

  it("turns an already-running resumed role into a persisted success", async () => {
    const flyff = game();
    const savedRole = role({ gameId: flyff.id });
    const onComplete = vi.fn();
    renderOnboarding({
      games: [flyff],
      progress: { version: 1, state: "in_progress", gameId: flyff.id, roleId: savedRole.id },
      roles: [savedRole],
      statusByRole: new Map([[savedRole.id, { roleId: savedRole.id, state: "running" }]]),
      onComplete
    });

    expect(screen.getByText("Your first role is running")).toBeTruthy();
    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
  });
});

function renderOnboarding(overrides: Partial<ComponentProps<typeof FirstRunOnboarding>> = {}) {
  const props: ComponentProps<typeof FirstRunOnboarding> = {
    error: null,
    games: [game()],
    isSaving: false,
    isSuccessPresented: false,
    language: "en",
    notice: null,
    progress: { version: 1, state: "in_progress" },
    roles: [],
    statusByRole: new Map(),
    t,
    onClearError: vi.fn(),
    onComplete: vi.fn(),
    onCustomGame: vi.fn(),
    onDismissSuccess: vi.fn(),
    onLaunch: vi.fn().mockResolvedValue(undefined),
    onOpenLater: vi.fn(),
    onSave: vi.fn().mockResolvedValue(undefined),
    onSkip: vi.fn(),
    onUpdateProgress: vi.fn(),
    ...overrides
  };
  return render(<FirstRunOnboarding {...props} />);
}

function game(overrides: Partial<Game> = {}): Game {
  return {
    id: "builtin-flyff-universe",
    source: "builtin",
    builtinKey: "flyff-universe",
    name: "Flyff Universe",
    defaultLaunchUrl: "https://universe.flyff.com/play",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function chinaGame(): Game {
  return game({
    id: "builtin-feifei-infinite-universe",
    builtinKey: "feifei-infinite-universe",
    name: "飞飞：无限宇宙",
    defaultLaunchUrl: "https://ffcli.ruiwoo.cn/"
  });
}

function role(overrides: Partial<Role> = {}): Role {
  return {
    id: "role-1",
    gameId: "builtin-flyff-universe",
    name: "Main",
    launchUrl: "https://universe.flyff.com/play",
    notes: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}
