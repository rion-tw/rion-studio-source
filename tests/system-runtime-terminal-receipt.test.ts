// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import type { SystemRuntimeOperationSummaryRecord } from "../src/shared/generated";
import {
  SYSTEM_RUNTIME_WARNING_EVENT,
  handleSystemRuntimeReceipt
} from "../src/renderer/src/app/systemRuntimeReceipt";

function receipt(
  status: SystemRuntimeOperationSummaryRecord["status"]
): SystemRuntimeOperationSummaryRecord {
  return {
    acceptedAt: "2026-08-03T00:00:00Z",
    capturedAt: "2026-08-03T00:00:00Z",
    deadlineAt: "2026-08-03T00:00:10Z",
    platform: "windows",
    subsystem: "presentation",
    status,
    stage: "nativePresentation",
    completionScope: "nativeAcknowledgement",
    operationId: `operation-${status}`,
    trigger: "test",
    elapsedMs: 5,
    timeoutMs: 10_000,
    failureCode: status === "applied" || status === "superseded" || status === "cancelled"
      ? undefined
      : `TEST_${status.toUpperCase()}`
  };
}

describe("System Runtime terminal receipt handling", () => {
  it("accepts applied and silently ignores superseded or cancelled receipts", () => {
    expect(handleSystemRuntimeReceipt(receipt("applied")).status).toBe("applied");
    expect(handleSystemRuntimeReceipt(receipt("superseded")).status).toBe("superseded");
    expect(handleSystemRuntimeReceipt(receipt("cancelled")).status).toBe("cancelled");
  });

  it("publishes degraded receipts as non-blocking warnings", () => {
    const listener = vi.fn();
    window.addEventListener(SYSTEM_RUNTIME_WARNING_EVENT, listener);
    const degraded = handleSystemRuntimeReceipt(receipt("degraded"));
    window.removeEventListener(SYSTEM_RUNTIME_WARNING_EVENT, listener);

    expect(degraded.status).toBe("degraded");
    expect(listener).toHaveBeenCalledOnce();
    expect((listener.mock.calls[0]?.[0] as CustomEvent).detail.code).toBe("TEST_DEGRADED");
  });

  it("throws stable codes for failed and restart guidance for indeterminate", () => {
    expect(() => handleSystemRuntimeReceipt(receipt("failed"))).toThrow();
    try {
      handleSystemRuntimeReceipt(receipt("failed"));
    } catch (error) {
      expect(error).toMatchObject({ code: "TEST_FAILED" });
    }
    try {
      handleSystemRuntimeReceipt(receipt("indeterminate"));
      throw new Error("expected an indeterminate receipt to throw");
    } catch (error) {
      expect(error).toMatchObject({
        code: "TEST_INDETERMINATE",
        message: expect.stringContaining("Restart Rion Studio")
      });
    }
  });
});
