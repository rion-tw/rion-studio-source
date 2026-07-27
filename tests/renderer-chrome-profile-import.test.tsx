// @vitest-environment jsdom

import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ConfirmationProvider } from "../src/renderer/src/components/ConfirmationDialog";
import { ChromeProfileImportFlow } from "../src/renderer/src/features/settings/ChromeProfileImportFlow";
import type { Translator } from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/en.json";
import type {
  ChromeProfileImportResult,
  Game,
  Role
} from "../src/shared/types";

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

  it("renders import dialogs directly under the document body", async () => {
    const user = userEvent.setup();
    installApi({});
    renderFlow();

    await user.click(screen.getByRole("button", { name: "Import from Chrome" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.parentElement?.parentElement).toBe(document.body);
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
    await user.click(within(screen.getByRole("dialog", { name: "Close all Chrome windows?" })).getByRole("button", { name: "Close all Chrome" }));
    expect(requestChromeQuitForImport).toHaveBeenCalledWith("import-1");
  });

  it("preselects an exact role match, confirms once, and shows progress and results", async () => {
    const user = userEvent.setup();
    const applyChromeProfileImport = vi.fn().mockResolvedValue({
      importId: "import-1",
      items: [{
        profileId: "Default",
        roleId: "role-1",
        roleName: "Main",
        status: "imported",
        authState: "notApplicable",
        cookieCount: 3,
        localStorageCount: 2,
        unsupported: {
          partitionedCookieCount: 1,
          appBoundCookieCount: 0,
          decryptFailureCount: 0,
          storageReadFailureCount: 0
        },
        warnings: ["COOKIE_PARTITIONED_UNSUPPORTED"]
      }]
    });
    installApi({
      previewChromeProfileImport: vi.fn().mockResolvedValue(preview(false)),
      applyChromeProfileImport
    });
    renderFlow([role]);
    await openPreview(user);

    await user.click(screen.getByRole("combobox", { name: "Game" }));
    await user.click(screen.getByRole("option", { name: "Example" }));
    expect(screen.getByRole("checkbox", { name: /Main/ }).getAttribute("aria-checked")).toBe("true");
    const apply = screen.getByRole("button", { name: "Apply import" });
    expect((apply as HTMLButtonElement).disabled).toBe(false);

    await user.click(apply);
    expect(screen.getByText("Replace selected role sessions?")).toBeTruthy();
    await user.click(within(screen.getByRole("dialog", { name: "Replace selected role sessions?" })).getByRole("button", { name: "Apply import" }));

    expect(applyChromeProfileImport).toHaveBeenCalledWith({
      importId: "import-1",
      gameId: "game-1",
      consentAccepted: true,
      resolutions: [{ action: "replace", profileId: "Default", targetRoleId: "role-1" }]
    });
    expect(screen.getByText("3 cookies · 2 LocalStorage entries")).toBeTruthy();
    expect(screen.getByText(/1 partitioned/)).toBeTruthy();
    expect(screen.getByText("Partitioned cookies cannot be transferred to this System WebView")).toBeTruthy();
  });

  it("shows a dedicated progress state and waits for a safe rollback when cancelled", async () => {
    const user = userEvent.setup();
    let finishApply: (result: ChromeProfileImportResult) => void = () => undefined;
    const applyChromeProfileImport = vi.fn().mockImplementation(
      () => new Promise<ChromeProfileImportResult>((resolve) => {
        finishApply = resolve;
      })
    );
    const discardChromeProfileImport = vi.fn().mockResolvedValue(undefined);
    installApi({
      previewChromeProfileImport: vi.fn().mockResolvedValue(preview(false)),
      applyChromeProfileImport,
      discardChromeProfileImport
    });
    renderFlow([role]);
    await openPreview(user);

    await user.click(screen.getByRole("combobox", { name: "Game" }));
    await user.click(screen.getByRole("option", { name: "Example" }));
    await user.click(screen.getByRole("button", { name: "Apply import" }));
    await user.click(within(screen.getByRole("dialog", { name: "Replace selected role sessions?" })).getByRole("button", { name: "Apply import" }));

    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("10");
    expect(screen.getByText(/multiple profiles can take a few minutes/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Apply import" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(discardChromeProfileImport).toHaveBeenCalledWith("import-1");
    expect(screen.getByRole("dialog", { name: "Chrome profile import" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancelling…" })).toBeTruthy();
    expect(screen.getByText(/safe rollback/)).toBeTruthy();

    await act(async () => {
      finishApply({
        importId: "import-1",
        items: []
      });
    });

    expect(screen.getByText("Cancelled")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });

  it("opens a needs-login role in the same managed session", async () => {
    const user = userEvent.setup();
    const launchRole = vi.fn().mockResolvedValue({});
    installApi({
      launchRole,
      previewChromeProfileImport: vi.fn().mockResolvedValue(preview(false)),
      applyChromeProfileImport: vi.fn().mockResolvedValue({
        importId: "import-1",
        items: [{
          profileId: "Default",
          roleId: "role-1",
          roleName: "Main",
          status: "needsLogin",
          authState: "notAuthenticated",
          cookieCount: 3,
          localStorageCount: 2,
          unsupported: {
            partitionedCookieCount: 0,
            appBoundCookieCount: 0,
            decryptFailureCount: 0,
            storageReadFailureCount: 0
          },
          warnings: []
        }]
      })
    });
    renderFlow([role]);
    await openPreview(user);
    await user.click(screen.getByRole("combobox", { name: "Game" }));
    await user.click(screen.getByRole("option", { name: "Example" }));
    await user.click(screen.getByRole("button", { name: "Apply import" }));
    await user.click(within(screen.getByRole("dialog", { name: "Replace selected role sessions?" })).getByRole("button", { name: "Apply import" }));
    await user.click(screen.getByRole("button", { name: "Open role to finish sign-in" }));
    expect(launchRole).toHaveBeenCalledWith("role-1");
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
  localStorageSyncKeys: [],
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
