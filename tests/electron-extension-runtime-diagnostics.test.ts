import { afterEach, describe, expect, it } from "vitest";

import {
  clearChromiumExtensionRuntimeDiagnosticsForTests,
  recentChromiumExtensionRuntimeDiagnostics,
  recentChromiumExtensionRuntimeFailures,
  recordChromiumExtensionRuntimeDiagnostic
} from "../src/electron/main/chromiumExtensionRuntimeDiagnostics";

afterEach(clearChromiumExtensionRuntimeDiagnosticsForTests);

describe("Chromium extension runtime diagnostics", () => {
  it("retains bounded sanitized metadata and projects failures for export", () => {
    const extensionId = "d".repeat(32);
    recordChromiumExtensionRuntimeDiagnostic({
      api: "member.onRemoved",
      capturedAt: "2026-09-13T01:02:03+00:00",
      code: "ELECTRON_EXTENSION_SERVICE_WORKER_RUNTIME_ERROR",
      column: 1,
      extensionId,
      line: 899,
      relativeFile: "js/background.js",
      roleId: "/Users/person/private-role",
      stage: "bootstrap",
      status: "degraded"
    });

    expect(recentChromiumExtensionRuntimeDiagnostics()).toEqual([{
      api: "member.onRemoved",
      capturedAt: "2026-09-13T01:02:03.000Z",
      code: "ELECTRON_EXTENSION_SERVICE_WORKER_RUNTIME_ERROR",
      column: 1,
      extensionId,
      line: 899,
      relativeFile: "js/background.js",
      roleId: "unknown",
      stage: "bootstrap",
      status: "degraded"
    }]);
    expect(recentChromiumExtensionRuntimeFailures()).toEqual([{
      action: extensionId,
      capturedAt: "2026-09-13T01:02:03.000Z",
      code: "ELECTRON_EXTENSION_SERVICE_WORKER_RUNTIME_ERROR",
      roleId: "unknown",
      stage: "extension-bootstrap",
      subsystem: "effect"
    }]);
  });

  it("rejects invalid extension identities and codes", () => {
    expect(() => recordChromiumExtensionRuntimeDiagnostic({
      capturedAt: "invalid",
      code: "not-safe",
      extensionId: "private",
      roleId: "role",
      stage: "load",
      status: "failed"
    })).toThrow("ELECTRON_EXTENSION_DIAGNOSTIC_IDENTITY_INVALID");
  });
});
