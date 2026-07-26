// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ConfirmationProvider } from "../src/renderer/src/components/ConfirmationDialog";
import { ChromeProfileImportFlow } from "../src/renderer/src/features/settings/ChromeProfileImportFlow";
import type { Translator } from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/en.json";
import type { ChromeProfileImportProgress, Game, Role } from "../src/shared/types";

const t: Translator = (key) => en[key] ?? key;

beforeAll(() => {
  if (!("PointerEvent" in window)) {
    Object.defineProperty(window, "PointerEvent", {
      configurable: true,
      value: MouseEvent
    });
  }
  Object.defineProperties(HTMLElement.prototype, {
    hasPointerCapture: { configurable: true, value: () => false },
    releasePointerCapture: { configurable: true, value: () => undefined },
    scrollIntoView: { configurable: true, value: () => undefined },
    setPointerCapture: { configurable: true, value: () => undefined }
  });
  Object.defineProperties(HTMLDialogElement.prototype, {
    close: {
      configurable: true,
      value: function close(this: HTMLDialogElement): void { this.removeAttribute("open"); }
    },
    showModal: {
      configurable: true,
      value: function showModal(this: HTMLDialogElement): void { this.setAttribute("open", ""); }
    }
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "rionStudio");
});

describe("Chrome profile import flow", () => {
  it("requires fresh explicit consent and handles directory cancellation", async () => {
    const user = userEvent.setup();
    const previewChromeProfileImport = vi.fn().mockResolvedValue(null);
    installApi({ previewChromeProfileImport });
    renderFlow();

    await user.click(screen.getByRole("button", { name: "Import from Chrome" }));
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
    expect((screen.getByRole("button", { name: "Choose Chrome folder" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(checkbox);
    await user.click(screen.getByRole("button", { name: "Choose Chrome folder" }));
    expect(previewChromeProfileImport).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Import from Chrome" }));
    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe("false");
  });

  it("blocks apply while Chrome is running and confirms a graceful quit", async () => {
    const user = userEvent.setup();
    const requestChromeQuitForImport = vi.fn().mockResolvedValue(preview(false));
    installApi({
      previewChromeProfileImport: vi.fn().mockResolvedValue(preview(true)),
      requestChromeQuitForImport
    });
    renderFlow();
    await openPreview(user);

    expect(screen.getByText(/Preview is available, but applying is blocked/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Close all Chrome" }));
    expect(screen.getByText("Close all Chrome windows?")).toBeTruthy();
    await user.click(screen.getAllByRole("button", { name: "Close all Chrome" }).at(-1)!);
    expect(requestChromeQuitForImport).toHaveBeenCalledWith("import-1");
  });

  it("requires an explicit per-profile conflict decision and shows progress and results", async () => {
    const user = userEvent.setup();
    let progressListener: ((progress: ChromeProfileImportProgress) => void) | undefined;
    const applyChromeProfileImport = vi.fn().mockResolvedValue({
      importId: "import-1",
      items: [{
        profileId: "Default",
        roleId: "role-1",
        roleName: "Main",
        status: "imported",
        cookieCount: 3,
        localStorageCount: 2,
        warnings: ["COOKIE_PARTITIONED_UNSUPPORTED"]
      }]
    });
    installApi({
      previewChromeProfileImport: vi.fn().mockResolvedValue(preview(false)),
      applyChromeProfileImport,
      onChromeProfileImportProgress: (listener: (progress: ChromeProfileImportProgress) => void) => {
        progressListener = listener;
        return () => undefined;
      }
    });
    renderFlow([role]);
    await openPreview(user);

    await user.click(screen.getByRole("combobox", { name: "Game" }));
    await user.click(screen.getByRole("option", { name: "Example" }));
    await user.click(screen.getByRole("checkbox", { name: /Main/ }));
    const apply = screen.getByRole("button", { name: "Apply import" });
    expect((apply as HTMLButtonElement).disabled).toBe(true);
    await user.selectOptions(
      screen.getAllByRole("combobox")[1],
      "replace:role-1"
    );
    expect((apply as HTMLButtonElement).disabled).toBe(false);

    act(() => {
      progressListener?.({
        importId: "import-1",
        profileId: "Default",
        phase: "applying",
        completed: 0,
        total: 1
      });
    });
    expect(screen.getByText("Writing and verifying · 0/1")).toBeTruthy();
    await user.click(apply);

    expect(applyChromeProfileImport).toHaveBeenCalledWith({
      importId: "import-1",
      gameId: "game-1",
      consentAccepted: true,
      resolutions: [{ action: "replace", profileId: "Default", targetRoleId: "role-1" }]
    });
    expect(screen.getByText("3 cookies · 2 LocalStorage entries")).toBeTruthy();
    expect(screen.getByText("COOKIE_PARTITIONED_UNSUPPORTED")).toBeTruthy();
  });
});

async function openPreview(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole("button", { name: "Import from Chrome" }));
  await user.click(screen.getByRole("checkbox"));
  await user.click(screen.getByRole("button", { name: "Choose Chrome folder" }));
}

function installApi(overrides: Record<string, unknown>): void {
  Object.defineProperty(window, "rionStudio", {
    configurable: true,
    value: {
      previewChromeProfileImport: vi.fn().mockResolvedValue(null),
      requestChromeQuitForImport: vi.fn(),
      applyChromeProfileImport: vi.fn(),
      discardChromeProfileImport: vi.fn().mockResolvedValue(undefined),
      onChromeProfileImportProgress: vi.fn().mockReturnValue(() => undefined),
      ...overrides
    }
  });
}

function renderFlow(roles: Role[] = []): void {
  render(
    <ConfirmationProvider>
      <ChromeProfileImportFlow games={[game]} roles={roles} t={t} onError={vi.fn()} />
    </ConfirmationProvider>
  );
}

function preview(sourceInUse: boolean) {
  return {
    importId: "import-1",
    sourceLabel: "User Data",
    sourceInUse,
    profiles: [{ id: "Default", directoryName: "Default", name: "Main" }]
  };
}

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
