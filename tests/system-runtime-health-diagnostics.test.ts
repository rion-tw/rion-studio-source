import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { readSourceTree } from "./helpers/readSourceTree";

describe("System WebView runtime health diagnostics", () => {
  it("exports a bounded privacy-safe native runtime summary", async () => {
    const [core, runtime, shell, snapshot, diagnostics, failure, generatedIndex] =
      await Promise.all([
        readSourceTree(new URL("../crates/rion-core/src/app.rs", import.meta.url)),
        readSourceTree(new URL("../src-tauri/src/system_runtime.rs", import.meta.url)),
        readSourceTree(new URL("../src-tauri/src/lib.rs", import.meta.url)),
        readFile("src/shared/generated/ApplicationDiagnosticsSnapshotRecord.ts", "utf8"),
        readFile("src/shared/generated/SystemRuntimeDiagnosticsRecord.ts", "utf8"),
        readFile("src/shared/generated/SystemRuntimeFailureRecord.ts", "utf8"),
        readFile("src/shared/generated/index.ts", "utf8")
      ]);

    expect(runtime).toContain("const RECENT_RUNTIME_FAILURE_CAPACITY: usize = 20");
    expect(runtime).toContain('event: "system-runtime.effect-failed"');
    expect(runtime).toContain("pub fn system_runtime_diagnostics(");
    expect(runtime).toContain("SYSTEM_RUNTIME_STATE_LOCK_POISONED");
    expect(runtime).not.toMatch(/SystemRuntimeFailureRecord\s*\{[^}]*message:/s);

    expect(shell).toContain('"nativeRuntime": state.runtime.system_runtime_diagnostics()');
    expect(core).toContain('"nativeRuntime": snapshot.native_runtime');
    expect(snapshot).toContain("nativeRuntime: SystemRuntimeDiagnosticsRecord");
    expect(diagnostics).toContain("snapshotComplete: boolean");
    expect(diagnostics).toContain("recentFailures: Array<SystemRuntimeFailureRecord>");
    expect(failure).toContain('subsystem: "effect"');
    for (const sensitive of ["message", "origin", "token", "url", "webviewLabel"]) {
      expect(failure).not.toContain(`${sensitive}:`);
    }
    expect(generatedIndex).toContain(
      'export type { SystemRuntimeDiagnosticsRecord } from "./SystemRuntimeDiagnosticsRecord";'
    );
    expect(generatedIndex).toContain(
      'export type { SystemRuntimeFailureRecord } from "./SystemRuntimeFailureRecord";'
    );
  });
});
