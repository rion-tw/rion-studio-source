// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CLEAR_LOGS_AFTER_DIAGNOSTICS_EXPORT_STORAGE_KEY } from "../src/renderer/src/app/constants";
import { ConfirmationProvider } from "../src/renderer/src/components/ConfirmationDialog";
import { DiagnosticsSettingsSection } from "../src/renderer/src/features/settings/DiagnosticsSettingsSection";
import en from "../src/renderer/src/i18n/en.json";
import type { Translator } from "../src/renderer/src/i18n";
import type { RionStudioApi } from "../src/shared/api";
import {
  CACHED_CORE_SNAPSHOT_COLLECTION_CODE,
  DESIGNED_DIAGNOSTIC_GAP_CODES
} from "../src/shared/diagnosticsCollection";

const t: Translator = (key) => en[key] ?? key;
const logStatus = {
  currentLevel: "debug" as const,
  entryCount: 2,
  fileCount: 1,
  totalBytes: 512,
  oldestTimestamp: "2026-08-01T00:00:00Z",
  newestTimestamp: "2026-08-02T00:00:00Z",
  newestDebugTimestamp: "2026-08-02T00:00:00Z",
  debugEntryCount: 1,
  infoEntryCount: 1,
  warnEntryCount: 0,
  errorEntryCount: 0,
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
      <DiagnosticsSettingsSection t={t} onError={onError} />
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
  it("announces partial export without presenting it as an export failure", async () => {
    const { getLogStatus, onError } = renderDiagnostics({
      exportDiagnostics: async () => ({ filePath: "/exports/partial.zip", logFileCount: 1,
        collectionErrorCodes: ["ELECTRON_RUNTIME_PROJECTION_NOT_READY"] })
    });
    await waitForInitialLogRefresh(getLogStatus);
    fireEvent.click(screen.getByRole("button", { name: "Export diagnostics" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(en["settings.logsExportPartial"]));
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports a complete export when only designed collection gaps are present", async () => {
    const { getLogStatus } = renderDiagnostics({
      exportDiagnostics: async () => ({ filePath: "/exports/complete.zip", logFileCount: 1,
        collectionErrorCodes: [...DESIGNED_DIAGNOSTIC_GAP_CODES, CACHED_CORE_SNAPSHOT_COLLECTION_CODE] })
    });
    await waitForInitialLogRefresh(getLogStatus);
    fireEvent.click(screen.getByRole("button", { name: "Export diagnostics" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(en["settings.logsExportComplete"]));
  });

  it("does not repeat rows when a later log page shifted behind new entries", async () => {
    const entry = (id: number) => ({ id: `entry-${id}`, timestamp: `2026-08-02T00:00:${String(id).padStart(2, "0")}Z`,
      level: "info" as const, source: "main" as const, message: `message ${id}` });
    const queryLogs = vi.fn()
      .mockResolvedValueOnce({ entries: [entry(9), entry(8), entry(7)], nextCursor: "3" })
      // Two new entries arrived, so offset 3 starts two rows earlier.
      .mockResolvedValueOnce({ entries: [entry(8), entry(7), entry(6)] });
    const { getLogStatus } = renderDiagnostics({ queryLogs });
    await waitForInitialLogRefresh(getLogStatus);
    fireEvent.click(await screen.findByRole("button", { name: en["settings.logsLoadMore"] }));
    await waitFor(() => expect(screen.getByText("message 6")).toBeTruthy());
    expect(screen.getAllByText("message 8")).toHaveLength(1);
    expect(screen.getAllByText("message 7")).toHaveLength(1);
  });

  it("offers log export without retired performance measurement controls", async () => {
    const { getLogStatus } = renderDiagnostics();
    await waitForInitialLogRefresh(getLogStatus);
    expect(screen.getByRole("button", { name: "Export diagnostics" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Measure presentation FPS" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel measurement" })).toBeNull();
    expect(screen.getByText("Active: DEBUG · Debug 1 · Info 1 · Warn 0 · Error 0"))
      .toBeTruthy();
  });

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
