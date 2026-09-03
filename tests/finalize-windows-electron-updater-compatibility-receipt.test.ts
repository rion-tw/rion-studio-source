import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { finalizeWindowsElectronUpdaterCompatibilityReceipt } from
  "../scripts/finalizeWindowsElectronUpdaterCompatibilityReceipt.mjs";
import {
  createCompatibilityFinalizerFixture,
  TARGET_VERSION
} from "./support/electronUpdaterCompatibilityFinalizerFixture";

const execFileAsync = promisify(execFile);

describe("Windows Electron updater compatibility receipt CLI", () => {
  it("maps every explicit binding into the parent-only finalizer", async () => {
    const fixture = await createCompatibilityFinalizerFixture();
    try {
      const result = await finalizeWindowsElectronUpdaterCompatibilityReceipt([
        "--",
        ...fixtureArguments(fixture)
      ]);

      expect(result.receipt).toMatchObject({
        schemaVersion: 2,
        status: "verified-after-parent-isolation",
        platform: "windows-x86_64",
        target: { version: TARGET_VERSION },
        parentIsolation: {
          result: {
            activeProcessesAfterRootExit: 0,
            cleanupVerified: true,
            commandExitCode: 0
          }
        }
      });
      expect(result.receiptPath).toBe(join(
        fixture.sealedOutputRoot,
        "terminal-layout-probe-receipt.json"
      ));
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects unknown, duplicate, missing, and malformed options", async () => {
    const fixture = await createCompatibilityFinalizerFixture();
    try {
      const complete = fixtureArguments(fixture);
      await expect(finalizeWindowsElectronUpdaterCompatibilityReceipt([
        ...complete,
        "--unknown-option",
        "value"
      ])).rejects.toThrow("unknown");
      await expect(finalizeWindowsElectronUpdaterCompatibilityReceipt([
        ...complete,
        "--target-version",
        TARGET_VERSION
      ])).rejects.toThrow("duplicated");
      await expect(finalizeWindowsElectronUpdaterCompatibilityReceipt(
        complete.slice(0, -2)
      )).rejects.toThrow("incomplete");
      await expect(finalizeWindowsElectronUpdaterCompatibilityReceipt([
        "--target-version"
      ])).rejects.toThrow("malformed");
    } finally {
      await fixture.cleanup();
    }
  });

  it("redacts parser values and finalizer errors at the executable boundary", async () => {
    const sentinel = "sentinel-secret-value-that-must-not-leak";
    let failure: unknown;
    try {
      await execFileAsync(process.execPath, [
        "scripts/finalizeWindowsElectronUpdaterCompatibilityReceipt.mjs",
        "--unknown-private-option",
        sentinel
      ], {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH },
        maxBuffer: 1024 * 1024
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: 1, stdout: "" });
    const stderr = String((failure as { stderr?: string })?.stderr ?? "");
    expect(stderr).toBe(
      "Windows Electron updater compatibility receipt finalization failed.\n"
    );
    expect(stderr).not.toContain(sentinel);
  });
});

function fixtureArguments(
  fixture: Awaited<ReturnType<typeof createCompatibilityFinalizerFixture>>
) {
  return [
    "--child-output-root", fixture.childOutputRoot,
    "--isolation-attempt-nonce", fixture.expected.isolationAttemptNonce,
    "--isolation-command-executable", fixture.commandExecutablePath,
    "--isolation-command-executable-sha256",
    fixture.expected.isolationCommandExecutableSha256,
    "--isolation-command-harness", fixture.commandHarnessPath,
    "--isolation-command-harness-sha256",
    fixture.expected.isolationCommandHarnessSha256,
    "--isolation-command-invocation-sha256",
    fixture.expected.isolationCommandInvocationSha256,
    "--isolation-result", fixture.isolationResultPath,
    "--prepared-artifact", fixture.preparedArtifactPath,
    "--prepared-input-receipt", fixture.preparedReceiptPath,
    "--prepared-input-receipt-sha256",
    fixture.expected.preparedInputReceiptSha256,
    "--prepared-fixture-root", fixture.preparedRoot,
    "--prior-v23-version", "23.0.0",
    "--provisional-receipt", fixture.provisionalReceiptPath,
    "--sealed-output-root", fixture.sealedOutputRoot,
    "--target-source-sha", fixture.expected.targetSourceSha,
    "--target-updater-endpoint",
    "https://updates.example.test/v23/latest.json",
    "--target-version", TARGET_VERSION,
    "--tauri-v22-asset-directory", fixture.v22Root,
    "--tauri-v22-input-receipt", fixture.inputReceiptPath,
    "--tauri-v22-input-receipt-sha256",
    fixture.expected.tauriV22InputReceiptSha256,
    "--tauri-v22-lineage-receipt", fixture.lineageReceiptPath,
    "--tauri-v22-lineage-receipt-sha256",
    fixture.expected.tauriV22LineageReceiptSha256,
    "--updater-public-key-sha256",
    fixture.expected.updaterPublicKeySha256
  ];
}
