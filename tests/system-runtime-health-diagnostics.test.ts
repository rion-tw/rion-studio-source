import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { readSourceTree } from "./helpers/readSourceTree";

describe("System WebView runtime health diagnostics", () => {
  it("exports a bounded privacy-safe native runtime summary", async () => {
    const [core, runtime, shell, snapshot, diagnostics, failure, activeFence, fenceEvent, operation, capabilityEvidence, generatedIndex] =
      await Promise.all([
        readSourceTree(new URL("../crates/rion-core/src/app.rs", import.meta.url)),
        readSourceTree(new URL("../src-tauri/src/system_runtime.rs", import.meta.url)),
        readSourceTree(new URL("../src-tauri/src/lib.rs", import.meta.url)),
        readFile("src/shared/generated/ApplicationDiagnosticsSnapshotRecord.ts", "utf8"),
        readFile("src/shared/generated/SystemRuntimeDiagnosticsRecord.ts", "utf8"),
        readFile("src/shared/generated/SystemRuntimeFailureRecord.ts", "utf8"),
        readFile("src/shared/generated/SystemRuntimeInputFenceRecord.ts", "utf8"),
        readFile("src/shared/generated/SystemRuntimeInputFenceEventRecord.ts", "utf8"),
        readFile("src/shared/generated/SystemRuntimeOperationSummaryRecord.ts", "utf8"),
        readFile("src/shared/generated/EngineCapabilityEvidenceRecord.ts", "utf8"),
        readFile("src/shared/generated/index.ts", "utf8")
      ]);

    expect(runtime).toContain("const RECENT_RUNTIME_FAILURE_CAPACITY: usize = 20");
    expect(runtime).toContain("const RECENT_INPUT_FENCE_EVENT_CAPACITY: usize = 40");
    expect(runtime).toContain("const RECENT_NATIVE_OPERATION_CAPACITY: usize = 80");
    expect(runtime).toContain('event: "system-runtime.effect-failed"');
    expect(runtime).toContain("pub fn system_runtime_diagnostics(");
    expect(runtime).toContain("SYSTEM_RUNTIME_STATE_LOCK_POISONED");
    expect(runtime).not.toMatch(/SystemRuntimeFailureRecord\s*\{[^}]*message:/s);

    expect(shell).toContain("state.core.macro_input_diagnostics().ok()");
    expect(core).toContain('"nativeRuntime": snapshot.native_runtime');
    expect(snapshot).toContain("nativeRuntime: SystemRuntimeDiagnosticsRecord");
    expect(diagnostics).toContain("snapshotComplete: boolean");
    expect(diagnostics).toContain("recentFailures: Array<SystemRuntimeFailureRecord>");
    expect(diagnostics).toContain("activeInputFences: Array<SystemRuntimeInputFenceRecord>");
    expect(diagnostics).toContain("contractVersion: number");
    expect(diagnostics).toContain(
      "recentOperations: Array<SystemRuntimeOperationSummaryRecord>"
    );
    expect(diagnostics).toContain(
      "capabilityEvidence: Array<EngineCapabilityEvidenceRecord>"
    );
    expect(diagnostics).toContain(
      "recentInputFenceEvents: Array<SystemRuntimeInputFenceEventRecord>"
    );
    expect(failure).toContain('subsystem: "effect"');
    for (const sensitive of ["message", "origin", "token", "url", "webviewLabel"]) {
      expect(failure).not.toContain(`${sensitive}:`);
      expect(activeFence).not.toContain(`${sensitive}:`);
      expect(fenceEvent).not.toContain(`${sensitive}:`);
      expect(operation).not.toContain(`${sensitive}:`);
    }
    expect(operation).toContain(
      'status: "applied" | "superseded" | "cancelled" | "degraded" | "failed" | "indeterminate"'
    );
    expect(operation).toContain("completionScope:");
    expect(capabilityEvidence).toContain("contractVersion: number");
    expect(generatedIndex).toContain(
      'export type { SystemRuntimeDiagnosticsRecord } from "./SystemRuntimeDiagnosticsRecord";'
    );
    expect(generatedIndex).toContain(
      'export type { SystemRuntimeFailureRecord } from "./SystemRuntimeFailureRecord";'
    );
    expect(generatedIndex).toContain(
      'export type { SystemRuntimeInputFenceRecord } from "./SystemRuntimeInputFenceRecord";'
    );
    expect(generatedIndex).toContain(
      'export type { SystemRuntimeInputFenceEventRecord } from "./SystemRuntimeInputFenceEventRecord";'
    );
    expect(generatedIndex).toContain(
      'export type { SystemRuntimeOperationSummaryRecord } from "./SystemRuntimeOperationSummaryRecord";'
    );
    expect(generatedIndex).toContain(
      'export type { EngineCapabilityEvidenceRecord } from "./EngineCapabilityEvidenceRecord";'
    );
  });
});
