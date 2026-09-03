import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { finalizeMacosElectronUpdaterCompatibilityReceipt } from
  "../scripts/finalizeMacosElectronUpdaterCompatibilityReceipt.mjs";
import {
  MACOS_TARGET_VERSION,
  createMacosCompatibilityFinalizerFixture
} from "./support/electronUpdaterMacosCompatibilityFinalizerFixture";

const execFileAsync = promisify(execFile);

describe.skipIf(process.platform === "win32")(
  "macOS Electron updater compatibility receipt CLI",
  () => {
  it("maps every explicit path and binding into the parent-only finalizer", async () => {
    const fixture = await createMacosCompatibilityFinalizerFixture();
    try {
      const result = await finalizeMacosElectronUpdaterCompatibilityReceipt([
        "--",
        ...fixtureArguments(fixture)
      ]);

      expect(result.receipt).toMatchObject({
        schemaVersion: 3,
        platform: "darwin-aarch64",
        target: { version: MACOS_TARGET_VERSION },
        parentIsolation: {
          commandExitCode: 0,
          commandExecutable: {
            path: fixture.commandExecutablePath,
            sha256: fixture.expected.isolationCommandExecutableSha256
          },
          commandHarness: {
            path: fixture.commandHarnessPath,
            sha256: fixture.expected.isolationCommandHarnessSha256
          },
          result: {
            activeProcessesAfterCleanup: 0,
            cleanupVerified: true
          }
        }
      });
      expect(result.receiptPath).toBe(
        `${fixture.sealedOutputRoot}/terminal-layout-probe-receipt.json`
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects unknown, duplicate, missing, and malformed options", async () => {
    const fixture = await createMacosCompatibilityFinalizerFixture();
    try {
      const complete = fixtureArguments(fixture);
      await expect(finalizeMacosElectronUpdaterCompatibilityReceipt([
        ...complete,
        "--unknown-option",
        "value"
      ])).rejects.toThrow("unknown");
      await expect(finalizeMacosElectronUpdaterCompatibilityReceipt([
        ...complete,
        "--target-version",
        MACOS_TARGET_VERSION
      ])).rejects.toThrow("duplicated");
      await expect(finalizeMacosElectronUpdaterCompatibilityReceipt(
        complete.slice(0, -2)
      )).rejects.toThrow("incomplete");
      await expect(finalizeMacosElectronUpdaterCompatibilityReceipt([
        "--target-version"
      ])).rejects.toThrow("malformed");
    } finally {
      await fixture.cleanup();
    }
  });

  it("redacts option values and finalizer errors at the executable boundary", async () => {
    const sentinel = "sentinel-macos-secret-that-must-not-leak";
    let failure: unknown;
    try {
      await execFileAsync(process.execPath, [
        "scripts/finalizeMacosElectronUpdaterCompatibilityReceipt.mjs",
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
      "macOS Electron updater compatibility receipt finalization failed.\n"
    );
    expect(stderr).not.toContain(sentinel);
  });
  }
);

function fixtureArguments(
  fixture: Awaited<ReturnType<typeof createMacosCompatibilityFinalizerFixture>>
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
    "--isolation-result-sha256", fixture.expected.isolationResultSha256,
    "--prepared-artifact", fixture.preparedArtifactPath,
    "--prepared-input-receipt", fixture.preparedReceiptPath,
    "--prepared-input-receipt-sha256",
    fixture.expected.preparedInputReceiptSha256,
    "--prepared-fixture-root", fixture.preparedRoot,
    "--prior-v23-version", "23.0.0",
    "--provisional-receipt", fixture.provisionalReceiptPath,
    "--sandbox-profile-sha256", fixture.expected.sandboxProfileSha256,
    "--sealed-output-root", fixture.sealedOutputRoot,
    "--target-source-sha", fixture.expected.targetSourceSha,
    "--target-updater-endpoint",
    "https://updates.example.test/v23/latest.json",
    "--target-version", MACOS_TARGET_VERSION,
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
