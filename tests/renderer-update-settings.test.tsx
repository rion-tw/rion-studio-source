// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfirmationProvider } from "../src/renderer/src/components/ConfirmationDialog";
import { formatUpdateStatus } from "../src/renderer/src/features/settings/PortableSettingsDialogs";
import SettingsView from "../src/renderer/src/features/settings/SettingsRoute";
import {
  languages,
  loadTranslations,
  type TranslationKey,
  type Translator
} from "../src/renderer/src/i18n";
import en from "../src/renderer/src/i18n/en.json";
import { DEFAULT_GAME_BROWSER_SETTINGS } from "../src/shared/browserFonts";
import { DEFAULT_MACRO_SETTINGS } from "../src/shared/macroSettings";
import type { AppUpdateStatus } from "../src/shared/types";

const t: Translator = (key) => en[key] ?? key;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("update settings", () => {
  it("preserves a downloaded update by disabling another check", () => {
    renderSettings({
      autoUpdateEnabled: true,
      availableVersion: "2.0.0",
      currentVersion: "1.0.0",
      installMode: "automatic",
      isPackaged: true,
      state: "downloaded"
    });

    expect((screen.getByRole("button", { name: "Check updates" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Restart and update" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("allows a manual check while the updater is idle", () => {
    renderSettings({
      autoUpdateEnabled: true,
      currentVersion: "1.0.0",
      installMode: "automatic",
      isPackaged: true,
      state: "idle"
    });

    expect((screen.getByRole("button", { name: "Check updates" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Restart and update" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it.each([
    ["UPDATE_NETWORK_REQUEST_FAILED", "settings.updateErrorNetwork"],
    ["UPDATE_NETWORK_HTTP_STATUS_INVALID", "settings.updateErrorNetwork"],
    ["UPDATE_MANIFEST_SIGNATURE_INVALID", "settings.updateErrorInvalid"],
    ["UPDATE_SIGNATURE_KEY_MISSING", "settings.updateErrorInvalid"],
    ["UPDATE_ARTIFACT_SHA256_MISMATCH", "settings.updateErrorInvalid"],
    ["UPDATE_INSTALL_JOURNAL_SOURCE_CHANGED", "settings.updateErrorInstall"],
    ["UPDATE_PERSISTENCE_IO_FAILED", "settings.updateErrorUnknown"]
  ] as const)("explains a failed check with %s without showing the code", (code, key) => {
    renderSettings({
      autoUpdateEnabled: true,
      currentVersion: "1.0.0",
      error: code,
      errorCode: code,
      installMode: "automatic",
      isPackaged: true,
      state: "error"
    });

    expect(screen.getByText(`Update check failed: ${en[key]}`)).toBeTruthy();
    expect(document.body.textContent).not.toContain(code);
  });

  it("explains a failed installation without showing the failure code", () => {
    renderSettings({
      autoUpdateEnabled: true,
      availableVersion: "2.0.0",
      canRetryInstall: true,
      currentVersion: "1.0.0",
      error: "UPDATE_INSTALL_DRAIN_FAILED",
      errorCode: "UPDATE_INSTALL_DRAIN_FAILED",
      installMode: "automatic",
      isPackaged: true,
      state: "install_failed"
    });

    expect(screen.getByText(
      `Update installation failed: ${en["settings.updateErrorInstall"]} You can retry after the update is downloaded.`
    )).toBeTruthy();
    expect(document.body.textContent).not.toContain("UPDATE_INSTALL_DRAIN_FAILED");
  });

  it("groups updater failures into localized reasons in every language", async () => {
    const reasons = {
      UPDATE_NETWORK_IO_FAILED: "settings.updateErrorNetwork",
      UPDATE_MANIFEST_INVALID_JSON: "settings.updateErrorInvalid",
      UPDATE_INSTALL_REPLACEMENT_FAILED: "settings.updateErrorInstall",
      UPDATE_EVENT_STREAM_CLOSED: "settings.updateErrorUnknown"
    } as const;
    for (const language of languages) {
      const translations = await loadTranslations(language);
      const translate: Translator = (key) => translations[key];
      for (const [code, key] of Object.entries(reasons) as Array<[string, TranslationKey]>) {
        expect(translations[key]).toBeTruthy();
        for (const state of ["error", "install_failed"] as const) {
          const text = formatUpdateStatus({
            autoUpdateEnabled: true,
            currentVersion: "1.0.0",
            error: code,
            errorCode: code,
            installMode: "automatic",
            isPackaged: true,
            state
          }, translate);
          expect(text).toContain(translations[key]);
          expect(text).not.toContain(code);
        }
      }
    }
  });
});

function renderSettings(updateStatus: AppUpdateStatus): void {
  render(
    <MemoryRouter initialEntries={["/settings?section=updates"]}>
      <ConfirmationProvider>
        <SettingsView
          gameBrowserSettings={DEFAULT_GAME_BROWSER_SETTINGS}
          isUpdateBusy={false}
          language="en"
          macroSettings={DEFAULT_MACRO_SETTINGS}
          onApplyPortableImport={async () => { throw new Error("not used"); }}
          onCheckForUpdates={async () => undefined}
          onDiscardPortableImport={async () => undefined}
          onError={vi.fn()}
          onExportPortableData={async () => null}
          onGameBrowserSettingsChange={async (settings) => settings}
          onInstallDownloadedUpdate={async () => undefined}
          onLanguageChange={() => undefined}
          onLoadSystemFonts={async () => []}
          onMacroSettingsChange={async (settings) => settings}
          onOpenUpdateDownload={async () => undefined}
          onPreviewPortableImport={async () => null}
          onRuntimeWindowPreferencesChange={async (preferences) => preferences}
          onSetAutoUpdateEnabled={async () => undefined}
          onThemeModeChange={() => undefined}
          portableDataCounts={{
            gameCount: 0,
            gameWindowCount: 0,
            macroCount: 0,
            roleCount: 0,
            workspaceCount: 0
          }}
          resolvedTheme="light"
          runtimeWindowPreferences={{
            alwaysHideTabCloseButton: false,
            alwaysShowToolbarInFullScreen: false,
            restoreGameWindowsOnStartup: true
          }}
          systemFonts={[]}
          t={t}
          themeMode="system"
          updateStatus={updateStatus}
          updateVersion="1.0.0"
        />
      </ConfirmationProvider>
    </MemoryRouter>
  );
}
