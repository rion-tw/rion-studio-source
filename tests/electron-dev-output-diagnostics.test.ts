import { describe, expect, it, vi } from "vitest";

import {
  classifyElectronDevOutput,
  formatElectronDevOutputDiagnosis,
  runElectronDevOutputDiagnostics
} from "../scripts/diagnoseElectronDevOutput.mjs";

const representativeOutput = `warning: failed to parse serde attribute
(node:85214) ExtensionLoadWarning: Warnings loading extension at /tmp/extension:
  Permission 'notifications' is unknown.
2026-09-10 Electron[85214:1] TSM AdjustCapsLockLEDForKeyTransitionHandling - Inhibit
2026-09-10 Electron[85214:1] error messaging the mach port for IMKCFRunLoopWakeUpReliable
Error occurred in handler for 'rion:chromium-role-overlay:v1': RionBridgeError: flyff-caret-diagnostic unavailable
[ELECTRON_MACOS_APPKIT_ACTION_UNSUPPORTED] unsupported
[WORKSPACE_DIVIDER_WINDOW_NOT_SAVED] mismatched receipt
[85215:ERROR:gpu/shared_image_manager.cc:254] SharedImageManager::ProduceSkia: non-existent mailbox.`;

describe("Electron development output diagnostics", () => {
  it("classifies product, toolchain, compatibility, framework, and GPU signatures", () => {
    const diagnosis = classifyElectronDevOutput(representativeOutput);

    expect(diagnosis.status).toBe("action-required");
    expect(diagnosis.exitCode).toBe(1);
    expect(diagnosis.findings.map(({ category, count, id }) => ({
      category,
      count,
      id
    }))).toEqual([
      { category: "product-error", count: 1, id: "retired-flyff-caret-request" },
      { category: "product-error", count: 1, id: "unsupported-appkit-action" },
      { category: "product-error", count: 1, id: "workspace-divider-transient-receipt" },
      { category: "toolchain-regression", count: 1, id: "ts-rs-serde-attribute-warning" },
      { category: "extension-compatibility", count: 1, id: "unsupported-extension-api" },
      { category: "macos-framework-noise", count: 1, id: "macos-imk-run-loop" },
      { category: "macos-framework-noise", count: 1, id: "macos-tsm-caps-lock" },
      { category: "gpu-watch", count: 1, id: "chromium-shared-image-mailbox" }
    ]);
  });

  it("keeps known compatibility and framework output advisory", () => {
    const diagnosis = classifyElectronDevOutput(`
(node:7) ExtensionLoadWarning: Warnings loading extension at /tmp/example:
2026 Electron[7:8] error messaging the mach port for IMKCFRunLoopWakeUpReliable
[7:ERROR:gpu/x] SharedImageManager::ProduceSkia: non-existent mailbox.
`);

    expect(diagnosis).toMatchObject({ exitCode: 0, status: "notes" });
  });

  it("fails closed for an unclassified diagnostic line", () => {
    const diagnosis = classifyElectronDevOutput("Error occurred while opening an unknown lane");

    expect(diagnosis).toMatchObject({ exitCode: 1, status: "action-required" });
    expect(formatElectronDevOutputDiagnosis(diagnosis)).toContain(
      "sample: Error occurred while opening an unknown lane"
    );
  });

  it("reads a named source or stdin through the CLI boundary", async () => {
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const readFile = vi.fn(async (source: string | number) => {
      expect(["dev.log", 0]).toContain(source);
      return "electron main process built successfully";
    });

    await expect(runElectronDevOutputDiagnostics(["dev.log"], {
      readFile,
      stderr,
      stdout
    })).resolves.toBe(0);
    await expect(runElectronDevOutputDiagnostics(["-"], {
      readFile,
      stderr,
      stdout
    })).resolves.toBe(0);
    expect(readFile.mock.calls.map(([source]) => source)).toEqual(["dev.log", 0]);
    expect(stderr.write).not.toHaveBeenCalled();
  });

  it("uses exit code 2 for usage and read failures", async () => {
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };

    await expect(runElectronDevOutputDiagnostics([], {
      readFile: vi.fn(),
      stderr,
      stdout
    })).resolves.toBe(2);
    await expect(runElectronDevOutputDiagnostics(["missing.log"], {
      readFile: vi.fn(async () => { throw new Error("missing"); }),
      stderr,
      stdout
    })).resolves.toBe(2);
    expect(stderr.write).toHaveBeenCalledTimes(2);
  });
});
