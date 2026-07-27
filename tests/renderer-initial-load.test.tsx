/** @vitest-environment jsdom */

import { readFile } from "node:fs/promises";

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RionStudioApi } from "../src/shared/api";
import type { AppSnapshot, LegalAcceptanceStatus } from "../src/shared/types";
import { INITIAL_APP_DATA_TIMEOUT_MS, useAppData } from "../src/renderer/src/hooks/useAppData";
import { LEGAL_STATUS_TIMEOUT_MS, useLegalAcceptance } from "../src/renderer/src/hooks/useLegalAcceptance";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function snapshot(gameId: string): AppSnapshot {
  return {
    displays: [],
    embeddedRuntimeState: { tabs: [], windows: [] },
    gameCompatibilityReports: [],
    gameCompatibilityStatuses: [],
    games: [{ id: gameId } as AppSnapshot["games"][number]],
    gameWindows: [],
    launchWorkspaces: [],
    macroStatuses: [],
    macros: [],
    roleStatuses: [],
    roles: []
  };
}

function legalStatus(isAccepted: boolean): LegalAcceptanceStatus {
  return {
    currentVersions: { fairUse: "1", privacy: "1", terms: "1" },
    isAccepted
  };
}

function installAppDataBridge(getAppSnapshot: RionStudioApi["getAppSnapshot"]): void {
  const unsubscribe = (): void => undefined;
  window.rionStudio = {
    getAppSnapshot,
    onDisplaysChanged: () => unsubscribe,
    onEmbeddedRuntimeStateChanged: () => unsubscribe,
    onGameCompatibilityChanged: () => unsubscribe,
    onGamesChanged: () => unsubscribe,
    onGameWindowsChanged: () => unsubscribe,
    onMacrosChanged: () => unsubscribe,
    onMacroStatusChanged: () => unsubscribe,
    onRoleStatusChanged: () => unsubscribe,
    onWorkspacesChanged: () => unsubscribe
  } as unknown as RionStudioApi;
}

describe("initial renderer data loading", () => {
  it("wires the startup Retry action to both app data and legal status", async () => {
    const source = await readFile("src/renderer/src/App.tsx", "utf8");

    expect(source).toContain("void loadData({ markInitialLoad: true })");
    expect(source).toContain("void reloadLegal()");
    expect(source).toContain("onRetry={retryInitialLoad}");
  });

  it("turns a hung app snapshot into a retryable failure after 15 seconds", async () => {
    vi.useFakeTimers();
    installAppDataBridge(() => new Promise<AppSnapshot>(() => undefined));
    const { result } = renderHook(() => useAppData());

    await act(() => vi.advanceTimersByTimeAsync(INITIAL_APP_DATA_TIMEOUT_MS));

    expect(result.current.initialLoadState).toBe("failed");
    expect(result.current.error).toMatchObject({
      message: "Rion Studio data did not load within 15 seconds."
    });
  });

  it("does not let an older snapshot overwrite a successful retry", async () => {
    let resolveFirst: ((value: AppSnapshot) => void) | undefined;
    const getAppSnapshot = vi.fn()
      .mockImplementationOnce(() => new Promise<AppSnapshot>((resolve) => {
        resolveFirst = resolve;
      }))
      .mockResolvedValueOnce(snapshot("new"));
    installAppDataBridge(getAppSnapshot);
    const { result } = renderHook(() => useAppData());
    await vi.waitFor(() => expect(getAppSnapshot).toHaveBeenCalledOnce());

    await act(() => result.current.loadData({ markInitialLoad: true }));
    expect(result.current.games[0]?.id).toBe("new");

    await act(async () => {
      resolveFirst?.(snapshot("old"));
      await Promise.resolve();
    });
    expect(result.current.games[0]?.id).toBe("new");
  });
});

describe("initial legal status loading", () => {
  it("times out, retries, and ignores the previous late response", async () => {
    vi.useFakeTimers();
    let resolveFirst: ((value: LegalAcceptanceStatus) => void) | undefined;
    const getLegalAcceptanceStatus = vi.fn()
      .mockImplementationOnce(() => new Promise<LegalAcceptanceStatus>((resolve) => {
        resolveFirst = resolve;
      }))
      .mockResolvedValueOnce(legalStatus(true));
    window.rionStudio = { getLegalAcceptanceStatus } as unknown as RionStudioApi;
    const { result } = renderHook(() => useLegalAcceptance(true));

    await act(() => vi.advanceTimersByTimeAsync(LEGAL_STATUS_TIMEOUT_MS));
    expect(result.current.error).toMatchObject({
      message: "Legal acceptance status did not load within 15 seconds."
    });

    await act(() => result.current.reload());
    expect(result.current.status?.isAccepted).toBe(true);

    await act(async () => {
      resolveFirst?.(legalStatus(false));
      await Promise.resolve();
    });
    expect(result.current.status?.isAccepted).toBe(true);
  });
});
