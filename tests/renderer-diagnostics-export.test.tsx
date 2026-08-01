// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CLEAR_LOGS_AFTER_DIAGNOSTICS_EXPORT_STORAGE_KEY } from "../src/renderer/src/app/constants";
import { ConfirmationProvider } from "../src/renderer/src/components/ConfirmationDialog";
import { DiagnosticsSettingsSection } from "../src/renderer/src/features/settings/DiagnosticsSettingsSection";
import en from "../src/renderer/src/i18n/en.json";
import type { Translator } from "../src/renderer/src/i18n";
import type { RionStudioApi } from "../src/shared/api";

const t: Translator = (key) => en[key] ?? key;
const logStatus = {
  currentLevel: "debug" as const,
  entryCount: 2,
  fileCount: 1,
  totalBytes: 512,
  oldestTimestamp: "2026-08-01T00:00:00Z",
  newestTimestamp: "2026-08-02T00:00:00Z",
  retentionDays: 14,
  maxBytes: 1024,
  directory: "/logs"
};

function renderDiagnostics(apiOverrides: Partial<RionStudioApi> = {}) {
  const getLogStatus = vi.fn(async () => logStatus);
  const queryLogs = vi.fn(async () => ({ entries: [] }));
  const onError = vi.fn();
  window.rionStudio = {
    getLogStatus,
    queryLogs,
    onLogEntryAdded: () => () => undefined,
    exportDiagnostics: async () => ({ filePath: "/exports/diagnostics.zip", logFileCount: 1 }),
    clearLogs: async () => logStatus,
    ...apiOverrides
  } as unknown as RionStudioApi;

  render(
    <ConfirmationProvider>
      <DiagnosticsSettingsSection roles={[]} t={t} onError={onError} />
    </ConfirmationProvider>
  );

  return { getLogStatus, onError, queryLogs };
}

async function waitForInitialLogRefresh(getLogStatus: ReturnType<typeof vi.fn>): Promise<void> {
  await waitFor(() => expect(getLogStatus).toHaveBeenCalledOnce());
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("diagnostic export log cleanup", () => {
  it.each([
    { name: "defaults cleanup to enabled when no preference is stored", storedValue: undefined },
    { name: "defaults cleanup to enabled when the stored preference is invalid", storedValue: "unexpected" }
  ])("$name", async ({ storedValue }) => {
    if (storedValue !== undefined) {
      localStorage.setItem(CLEAR_LOGS_AFTER_DIAGNOSTICS_EXPORT_STORAGE_KEY, storedValue);
    }
    const { getLogStatus } = renderDiagnostics();
    await waitForInitialLogRefresh(getLogStatus);

    expect(screen.getByRole("switch", { name: "Clear logs after exporting diagnostics" })
      .getAttribute("aria-checked")).toBe("true");
  });

  it("persists the user's disabled preference across mounts", async () => {
    const first = renderDiagnostics();
    await waitForInitialLogRefresh(first.getLogStatus);
    fireEvent.click(screen.getByRole("switch", { name: "Clear logs after exporting diagnostics" }));

    expect(localStorage.getItem(CLEAR_LOGS_AFTER_DIAGNOSTICS_EXPORT_STORAGE_KEY)).toBe("false");
    cleanup();

    const second = renderDiagnostics();
    await waitForInitialLogRefresh(second.getLogStatus);
    expect(screen.getByRole("switch", { name: "Clear logs after exporting diagnostics" })
      .getAttribute("aria-checked")).toBe("false");
  });

  it("clears logs only after a successful export and then refreshes the viewer", async () => {
    const exportDiagnostics = vi.fn(async () => ({
      filePath: "/exports/diagnostics.zip",
      logFileCount: 1
    }));
    const clearLogs = vi.fn(async () => logStatus);
    const { getLogStatus, queryLogs } = renderDiagnostics({ exportDiagnostics, clearLogs });
    await waitForInitialLogRefresh(getLogStatus);

    fireEvent.click(screen.getByRole("button", { name: "Export diagnostics" }));

    await waitFor(() => expect(clearLogs).toHaveBeenCalledOnce());
    expect(exportDiagnostics.mock.invocationCallOrder[0]).toBeLessThan(clearLogs.mock.invocationCallOrder[0]);
    await waitFor(() => {
      expect(getLogStatus).toHaveBeenCalledTimes(2);
      expect(queryLogs).toHaveBeenCalledTimes(2);
    });
  });

  it("keeps logs when automatic cleanup is disabled", async () => {
    const exportDiagnostics = vi.fn(async () => ({
      filePath: "/exports/diagnostics.zip",
      logFileCount: 1
    }));
    const clearLogs = vi.fn(async () => logStatus);
    const { getLogStatus } = renderDiagnostics({ exportDiagnostics, clearLogs });
    await waitForInitialLogRefresh(getLogStatus);
    fireEvent.click(screen.getByRole("switch", { name: "Clear logs after exporting diagnostics" }));

    fireEvent.click(screen.getByRole("button", { name: "Export diagnostics" }));

    await waitFor(() => expect(getLogStatus).toHaveBeenCalledTimes(2));
    expect(exportDiagnostics).toHaveBeenCalledOnce();
    expect(clearLogs).not.toHaveBeenCalled();
  });

  it("keeps logs when the save dialog is cancelled", async () => {
    const exportDiagnostics = vi.fn(async () => null);
    const clearLogs = vi.fn(async () => logStatus);
    const { getLogStatus } = renderDiagnostics({ exportDiagnostics, clearLogs });
    await waitForInitialLogRefresh(getLogStatus);

    fireEvent.click(screen.getByRole("button", { name: "Export diagnostics" }));

    await waitFor(() => expect(getLogStatus).toHaveBeenCalledTimes(2));
    expect(exportDiagnostics).toHaveBeenCalledOnce();
    expect(clearLogs).not.toHaveBeenCalled();
  });

  it("reports export failures without clearing logs", async () => {
    const failure = new Error("export failed");
    const exportDiagnostics = vi.fn(async () => Promise.reject(failure));
    const clearLogs = vi.fn(async () => logStatus);
    const { getLogStatus, onError } = renderDiagnostics({ exportDiagnostics, clearLogs });
    await waitForInitialLogRefresh(getLogStatus);

    fireEvent.click(screen.getByRole("button", { name: "Export diagnostics" }));

    await waitFor(() => expect(onError).toHaveBeenCalledWith(failure));
    expect(clearLogs).not.toHaveBeenCalled();
  });

  it("reports cleanup failures after preserving the completed export", async () => {
    const exportDiagnostics = vi.fn(async () => ({
      filePath: "/exports/diagnostics.zip",
      logFileCount: 1
    }));
    const failure = new Error("cleanup failed");
    const clearLogs = vi.fn(async () => Promise.reject(failure));
    const { getLogStatus, onError } = renderDiagnostics({ exportDiagnostics, clearLogs });
    await waitForInitialLogRefresh(getLogStatus);

    fireEvent.click(screen.getByRole("button", { name: "Export diagnostics" }));

    await waitFor(() => expect(onError).toHaveBeenCalledWith(failure));
    expect(exportDiagnostics).toHaveBeenCalledOnce();
    expect(clearLogs).toHaveBeenCalledOnce();
  });
});
