import { describe, expect, it, vi } from "vitest";

import { ElectronBrowserPerformanceDiagnosticsController } from
  "../src/electron/main/electronBrowserPerformanceDiagnosticsController";
import type { BrowserPerformanceDiagnosticOperation } from
  "../src/shared/types";

describe("Electron browser performance diagnostic operations", () => {
  it("publishes an event-bound waiting operation and exact cancellation", () => {
    const published: BrowserPerformanceDiagnosticOperation[] = [];
    const controller = new ElectronBrowserPerformanceDiagnosticsController({
      publish: (operation) => published.push(operation)
    });

    expect(controller.begin()).toEqual({
      operationId: "performance-diagnostic-1",
      phase: "waitingForFocus",
      revision: 1
    });
    controller.cancel("performance-diagnostic-1");

    expect(published).toEqual([
      {
        operationId: "performance-diagnostic-1",
        phase: "waitingForFocus",
        revision: 1
      },
      {
        operationId: "performance-diagnostic-1",
        phase: "cancelled",
        revision: 2
      }
    ]);
  });

  it("terminalizes an active operation before accepting its successor", () => {
    const publish = vi.fn();
    const controller = new ElectronBrowserPerformanceDiagnosticsController({ publish });

    controller.begin();
    expect(controller.begin()).toEqual({
      operationId: "performance-diagnostic-2",
      phase: "waitingForFocus",
      revision: 2
    });

    expect(publish.mock.calls.map(([operation]) => operation)).toEqual([
      {
        operationId: "performance-diagnostic-1",
        phase: "waitingForFocus",
        revision: 1
      },
      {
        operationId: "performance-diagnostic-1",
        phase: "cancelled",
        revision: 2
      },
      {
        operationId: "performance-diagnostic-2",
        phase: "waitingForFocus",
        revision: 2
      }
    ]);
  });

  it("rejects cancellation for a stale or unknown operation identity", () => {
    const controller = new ElectronBrowserPerformanceDiagnosticsController({
      publish: vi.fn()
    });
    controller.begin();

    expect(() => controller.cancel("performance-diagnostic-stale"))
      .toThrowError(expect.objectContaining({
        code: "ELECTRON_PERFORMANCE_DIAGNOSTIC_NOT_FOUND"
      }));
  });
});
