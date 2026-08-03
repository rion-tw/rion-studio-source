// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SurfaceRecoveryAttemptRecord } from "../src/shared/generated";

const { invoke, listen, bridgeListeners } = vi.hoisted(() => {
  const bridgeListeners = new Map<string, (event: { payload: unknown }) => void>();
  return {
    bridgeListeners,
    invoke: vi.fn(),
    listen: vi.fn(async (
      event: string,
      callback: (event: { payload: unknown }) => void
    ) => {
      bridgeListeners.set(event, callback);
      return vi.fn();
    })
  };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

import { installTauriBridgeIfNeeded } from "../src/renderer/src/tauri/installTauriBridge";

afterEach(() => {
  bridgeListeners.clear();
  invoke.mockReset();
  listen.mockClear();
});

describe("surface recovery bridge", () => {
  it("preserves recovery attempt identity and terminal status", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {}
    });
    await installTauriBridgeIfNeeded();
    const onAttempt = vi.fn();
    window.rionStudio.onSurfaceRecoveryAttemptChanged(onAttempt);
    const attempt: SurfaceRecoveryAttemptRecord = {
      attemptId: "surface-recovery-1",
      operationId: "native-recovery-1",
      parentOperationId: "native-navigation-1",
      roleId: "role-1",
      windowId: "window-1",
      surfaceGeneration: 4,
      lifecycleEpoch: 2,
      phase: "blocked",
      status: "restartRequired",
      startedAt: "2026-08-03T00:00:00Z",
      updatedAt: "2026-08-03T00:00:01Z",
      failureCode: "SYSTEM_SURFACE_RECOVERY_INDETERMINATE"
    };

    bridgeListeners.get("rion://surface-recovery-attempt")?.({ payload: attempt });

    expect(onAttempt).toHaveBeenCalledWith(attempt);
  });
});
