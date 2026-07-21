// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChromeProfileImportFlow } from "../src/renderer/src/features/chrome-profile-import/ChromeProfileImportFlow";
import en from "../src/renderer/src/i18n/en.json";
import type { Game } from "../src/shared/types";
import type { Translator } from "../src/renderer/src/i18n";

const t: Translator = (key) => en[key] ?? key;
const game: Game = {
  id: "game-1",
  source: "custom",
  name: "Example game",
  defaultLaunchUrl: "https://example.test/play",
  browserLaunchMode: "inherit",
  createdAt: "2026-07-10T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z"
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Chrome profile import flow", () => {
  it("requests a graceful close for all Chrome windows and reports success", async () => {
    const onCloseChrome = vi.fn(async () => undefined);

    render(
      <ChromeProfileImportFlow
        games={[game]}
        isOpen
        t={t}
        onApply={async () => {
          throw new Error("not used");
        }}
        onCloseChrome={onCloseChrome}
        onDiscard={async () => undefined}
        onError={vi.fn()}
        onOpenChange={vi.fn()}
        onPreview={async () => null}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Close all Chrome" }));

    await waitFor(() => expect(onCloseChrome).toHaveBeenCalledOnce());
    expect(screen.getByRole("status").textContent).toContain("A normal close request was sent.");
  });

  it("shows a first notice, starts with no profiles selected, and requires final consent", async () => {
    const onPreviewChromeProfileImport = vi.fn(async () => ({
      importId: "import-1",
      profiles: [
        { directoryName: "Profile 11", id: "profile-11", name: "小胖" },
        { directoryName: "Profile 12 (Work Account)", id: "profile-12", name: "阿明" }
      ],
      sourceLabel: "Chrome",
      warnings: [{ code: "passwords_excluded" as const }]
    }));
    const importResult = {
      roles: [{
        authState: "authenticated" as const,
        createdAt: "2026-07-10T00:00:00.000Z",
        gameId: game.id,
        id: "role-1",
        launchUrl: game.defaultLaunchUrl,
        name: "小胖",
        notes: "Imported from a local Chrome profile.",
        updatedAt: "2026-07-10T00:00:00.000Z"
      }],
    };
    let resolveImport: ((result: typeof importResult) => void) | undefined;
    const onApplyChromeProfileImport = vi.fn(() => new Promise<typeof importResult>((resolve) => {
      resolveImport = resolve;
    }));
    let emitProgress: ((progress: {
      completedProfileCount: number;
      importId: string;
      phase: "preparing" | "importing" | "completed";
      totalProfileCount: number;
    }) => void) | undefined;
    const onProgress = vi.fn((callback: NonNullable<typeof emitProgress>) => {
      emitProgress = callback;
      return vi.fn();
    });

    render(
      <ChromeProfileImportFlow
        games={[game]}
        isOpen
        t={t}
        onApply={onApplyChromeProfileImport}
        onCloseChrome={async () => undefined}
        onDiscard={async () => undefined}
        onError={vi.fn()}
        onOpenChange={vi.fn()}
        onPreview={onPreviewChromeProfileImport}
        onProgress={onProgress}
      />
    );

    expect(screen.getByText("Sensitive local browser data")).toBeTruthy();
    expect(onPreviewChromeProfileImport).not.toHaveBeenCalled();

    const noticeConsent = screen.getByRole("checkbox");
    expect(noticeConsent.className).toContain("mt-[3px]");
    expect(noticeConsent.parentElement?.className).toContain("gap-2");
    expect(noticeConsent.nextElementSibling?.className).not.toContain("pt-1.5");
    const chooseFolderButton = screen.getByRole("button", { name: "Choose Chrome folder" });
    expect(chooseFolderButton).toHaveProperty("disabled", true);
    fireEvent.click(noticeConsent);
    await waitFor(() => expect(chooseFolderButton).toHaveProperty("disabled", false));
    fireEvent.click(chooseFolderButton);
    await waitFor(() => expect(onPreviewChromeProfileImport).toHaveBeenCalledOnce());
    expect(screen.getByText("Choose Chrome profiles")).toBeTruthy();
    const profileName = screen.getByText("小胖");
    const profileDirectory = screen.getByText("Profile 11");
    const profileCard = profileName.closest("button");
    expect(profileName.parentElement).toBe(profileDirectory.parentElement);
    expect(profileName.className).toContain("min-w-0");
    expect(profileName.className).toContain("truncate");
    expect(profileDirectory.className).toContain("shrink-0");
    expect(profileDirectory.className).toContain("whitespace-nowrap");
    expect(profileDirectory.className).toContain("text-right");
    expect(profileCard?.className).toContain("inline-flex");
    expect(profileCard?.className).toContain("w-auto");
    expect(profileCard?.className).toContain("glass-control");
    expect(profileCard?.className).toContain("h-[30px]");
    expect(profileCard?.className).toContain("min-h-[var(--control-min-size)]");
    expect(profileCard?.className).toContain("rounded-md");
    expect(profileCard?.className).toContain("px-2.5");
    expect(profileCard?.className).toContain("gap-1");
    expect(profileCard?.className).toContain("text-muted-foreground");
    expect(profileCard?.parentElement?.className).toContain("flex-wrap");
    expect(screen.getByText("阿明")).toBeTruthy();

    const importButton = screen.getByRole("button", { name: "Import selected profiles" });
    expect(importButton).toHaveProperty("disabled", true);
    const consentCheckbox = screen.getByRole("checkbox");
    expect(consentCheckbox.className).toContain("mt-[3px]");
    expect(consentCheckbox.parentElement?.className).toContain("gap-2");
    expect(consentCheckbox.nextElementSibling?.className).not.toContain("pt-1.5");
    expect(profileCard?.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(profileCard!);
    expect(profileCard?.className).toContain("macro-role-card-selected");
    expect(profileCard?.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(profileCard!);
    expect(profileCard?.className).not.toContain("macro-role-card-selected");
    expect(profileCard?.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(profileCard!);
    expect(importButton).toHaveProperty("disabled", true);
    fireEvent.click(consentCheckbox);
    await waitFor(() => expect(importButton).toHaveProperty("disabled", false));
    fireEvent.click(importButton);
    await waitFor(() => expect(onApplyChromeProfileImport).toHaveBeenCalledWith({
      consentAccepted: true,
      gameId: game.id,
      importId: "import-1",
      profileIds: ["profile-11"]
    }));
    const loadingButton = screen.getByRole("button", { name: "Imported 0/1" });
    expect(loadingButton).toHaveProperty("disabled", true);
    expect(loadingButton.getAttribute("aria-busy")).toBe("true");
    expect(loadingButton.querySelector("svg")?.classList.contains("animate-spin")).toBe(true);
    emitProgress?.({
      completedProfileCount: 1,
      importId: "import-1",
      phase: "importing",
      totalProfileCount: 1
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Imported 1/1" })).toBeTruthy());
    resolveImport?.(importResult);
    await waitFor(() => expect(screen.getByText("Chrome profile import complete")).toBeTruthy());
    expect(screen.getByText("小胖")).toBeTruthy();
    expect(screen.getByText(/Imported roles are marked as signed in/)).toBeTruthy();
    expect(screen.queryByText("Embedded browser")).toBeNull();
    expect(screen.queryByText("External Chrome")).toBeNull();
  });

  it("discards a pending preview when the import is cancelled", async () => {
    const onPreview = vi.fn(async () => ({
      importId: "import-1",
      profiles: [{ directoryName: "Default", id: "Default", name: "Primary" }],
      sourceLabel: "Chrome",
      warnings: []
    }));
    const onDiscard = vi.fn(async () => undefined);
    const onOpenChange = vi.fn();

    render(
      <ChromeProfileImportFlow
        games={[game]}
        isOpen
        t={t}
        onApply={async () => {
          throw new Error("not used");
        }}
        onCloseChrome={async () => undefined}
        onDiscard={onDiscard}
        onError={vi.fn()}
        onOpenChange={onOpenChange}
        onPreview={onPreview}
      />
    );

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Choose Chrome folder" }));
    await waitFor(() => expect(screen.getByText("Choose Chrome profiles")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(onDiscard).toHaveBeenCalledWith("import-1"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
