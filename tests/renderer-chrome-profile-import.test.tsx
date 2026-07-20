// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  vi.restoreAllMocks();
});

describe("Chrome profile import flow", () => {
  it("shows a first notice, starts with no profiles selected, and requires final consent", async () => {
    const onPreviewChromeProfileImport = vi.fn(async () => ({
      importId: "import-1",
      profiles: [{ directoryName: "Default", id: "Default", name: "Primary" }],
      sourceLabel: "Chrome",
      warnings: [{ code: "passwords_excluded" as const }]
    }));
    const onApplyChromeProfileImport = vi.fn(async () => ({
      roles: [],
      results: [{
        authState: "authenticated" as const,
        embedded: "authenticated" as const,
        external: "authenticated" as const,
        profileId: "Default",
        profileName: "Primary",
        roleId: "role-1",
        roleName: "Primary"
      }],
      warnings: []
    }));

    render(
      <ChromeProfileImportFlow
        games={[game]}
        isOpen
        t={t}
        onApply={onApplyChromeProfileImport}
        onDiscard={async () => undefined}
        onError={vi.fn()}
        onOpenChange={vi.fn()}
        onPreview={onPreviewChromeProfileImport}
      />
    );

    expect(screen.getByText("Sensitive local browser data")).toBeTruthy();
    expect(onPreviewChromeProfileImport).not.toHaveBeenCalled();

    const noticeConsent = screen.getByRole("checkbox");
    const chooseFolderButton = screen.getByRole("button", { name: "Choose Chrome folder" });
    expect(chooseFolderButton).toHaveProperty("disabled", true);
    fireEvent.click(noticeConsent);
    await waitFor(() => expect(chooseFolderButton).toHaveProperty("disabled", false));
    fireEvent.click(chooseFolderButton);
    await waitFor(() => expect(onPreviewChromeProfileImport).toHaveBeenCalledOnce());
    expect(screen.getByText("Choose Chrome profiles")).toBeTruthy();

    const importButton = screen.getByRole("button", { name: "Import selected profiles" });
    expect(importButton).toHaveProperty("disabled", true);
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0].getAttribute("data-state")).toBe("unchecked");

    fireEvent.click(checkboxes[0]);
    expect(importButton).toHaveProperty("disabled", true);
    fireEvent.click(checkboxes[1]);
    await waitFor(() => expect(importButton).toHaveProperty("disabled", false));
    fireEvent.click(importButton);
    await waitFor(() => expect(onApplyChromeProfileImport).toHaveBeenCalledWith({
      consentAccepted: true,
      gameId: game.id,
      importId: "import-1",
      profileIds: ["Default"]
    }));
    expect(screen.getByText("Chrome profile import complete")).toBeTruthy();
    expect(screen.getByText("Embedded: login available · External Chrome: login available")).toBeTruthy();
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
