// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SystemRuntimeOperationSummaryRecord } from "../src/shared/generated";

const { invoke, listen } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(() => Promise.resolve(vi.fn()))
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

import { installTauriBridgeIfNeeded } from "../src/renderer/src/tauri/installTauriBridge";

const appliedReceipt: SystemRuntimeOperationSummaryRecord = {
  acceptedAt: "2026-08-03T00:00:00Z",
  capturedAt: "2026-08-03T00:00:00Z",
  completionPolicy: "deadlineBound",
  deadlineAt: "2026-08-03T00:00:10Z",
  platform: "macos",
  subsystem: "presentation",
  status: "applied",
  stage: "nativePresentation",
  completionScope: "nativeAcknowledgement",
  operationId: "native-presentation-1",
  trigger: "pointer",
  elapsedMs: 4,
  timeoutMs: 10_000,
  tabId: "tab-1",
  windowId: "window-1"
};

afterEach(() => {
  Reflect.deleteProperty(window, "rionStudio");
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  invoke.mockReset();
  listen.mockClear();
});

describe("System Runtime receipt bridge", () => {
  it("returns serialized terminal receipts for public native operations", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {}
    });
    invoke.mockResolvedValue(appliedReceipt);
    await installTauriBridgeIfNeeded();

    await expect(window.rionStudio.showGameWindowTab("tab-1")).resolves.toEqual(appliedReceipt);
    expect(invoke).toHaveBeenCalledWith("rion_shell_invoke", {
      operation: "showGameWindowTab",
      args: ["tab-1"]
    });
    await expect(window.rionStudio.stopGameWindow("window-1")).resolves.toEqual(appliedReceipt);
    await expect(window.rionStudio.deleteGameWindow("window-1")).resolves.toEqual(appliedReceipt);
    expect(invoke).toHaveBeenCalledWith("rion_shell_invoke", {
      operation: "stopGameWindow",
      args: ["window-1"]
    });
    expect(invoke).toHaveBeenCalledWith("rion_shell_invoke", {
      operation: "deleteGameWindow",
      args: ["window-1"]
    });
  });

  it("converts failed receipts into stable renderer errors", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {}
    });
    invoke.mockResolvedValue({
      ...appliedReceipt,
      status: "failed",
      failureCode: "NATIVE_PRESENTATION_QUEUE_FULL"
    });
    await installTauriBridgeIfNeeded();

    await expect(window.rionStudio.hideGameWindow("window-1")).rejects.toMatchObject({
      code: "NATIVE_PRESENTATION_QUEUE_FULL"
    });
  });

  it("normalizes topology mutation receipts including move-to-new-window", async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {}
    });
    invoke.mockImplementation(async (_command: string, payload: { operation: string }) => {
      if (payload.operation === "moveGameWindowTabToNewWindow") {
        return { targetWindowId: "window-2", receipt: appliedReceipt };
      }
      return appliedReceipt;
    });
    await installTauriBridgeIfNeeded();

    await expect(window.rionStudio.moveGameWindowTab("tab-1", "window-2"))
      .resolves.toEqual(appliedReceipt);
    await expect(window.rionStudio.reorderGameWindowTab("tab-1", "tab-2"))
      .resolves.toEqual(appliedReceipt);
    await expect(window.rionStudio.setGameWindowTabHidden("tab-1", true))
      .resolves.toEqual(appliedReceipt);
    await expect(window.rionStudio.stopGameWindowTab("tab-1"))
      .resolves.toEqual(appliedReceipt);
    await expect(window.rionStudio.moveGameWindowTabToNewWindow("tab-1"))
      .resolves.toEqual({ targetWindowId: "window-2", receipt: appliedReceipt });
    expect(invoke).toHaveBeenCalledWith("rion_shell_invoke", {
      operation: "stopGameWindowTab",
      args: ["tab-1"]
    });
    expect(invoke).toHaveBeenCalledWith("rion_shell_invoke", {
      operation: "reorderGameWindowTab",
      args: ["tab-1", "tab-2"]
    });
  });
});
