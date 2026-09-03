import { lstat, readFile, readdir } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { serializeCanonicalJson } from "../scripts/canonicalJson.mjs";
import {
  ELECTRON_UPDATER_MACOS_COMPATIBILITY_TERMINAL_RECEIPT_NAME
} from "../scripts/electronUpdaterMacosCompatibilityReceiptFinalizer.mjs";
import {
  MACOS_COMMAND_SHA256,
  MACOS_TARGET_SHA,
  MACOS_TARGET_VERSION,
  createMacosCompatibilityFinalizerFixture,
  finalizeMacosCompatibilityFixture,
  sha256
} from "./support/electronUpdaterMacosCompatibilityFinalizerFixture";

describe("macOS Electron updater compatibility receipt finalizer", () => {
  it("rebuilds a canonical terminal receipt after parent-observed active-zero", async () => {
    const fixture = await createMacosCompatibilityFinalizerFixture();
    try {
      const result = await finalizeMacosCompatibilityFixture(fixture);
      const source = await readFile(result.receiptPath);

      expect(source).toEqual(serializeCanonicalJson(result.receipt));
      expect(result.receipt).toMatchObject({
        schemaVersion: 3,
        status: "verified-after-parent-isolation",
        cutoverEligible: false,
        platform: "darwin-aarch64",
        target: {
          sourceSha: MACOS_TARGET_SHA,
          version: MACOS_TARGET_VERSION,
          artifactName: "Rion.Studio-mac.app.tar.gz",
          artifactBytes: fixture.targetArtifact.length,
          artifactSha256: sha256(fixture.targetArtifact),
          packageVerification: {
            kind: "rion-electron-updater-macos-package-verification",
            expectedVersion: MACOS_TARGET_VERSION,
            artifact: {
              fileName: "Rion.Studio-mac.app.tar.gz",
              sha256: sha256(fixture.targetArtifact)
            }
          },
          preparedInputReceipt: {
            fileName: "prepared-updater-probe-input.json",
            sha256: fixture.expected.preparedInputReceiptSha256
          }
        },
        source: {
          artifactName: "Rion.Studio-mac.app.tar.gz",
          inputReceipt: {
            fileName: "verified-input-receipt.json",
            sha256: fixture.expected.tauriV22InputReceiptSha256
          },
          publicLineageReceipt: {
            fileName: "tauri-v22-public-lineage-receipt.json",
            sha256: fixture.expected.tauriV22LineageReceiptSha256
          },
          runningExecutable: {
            derivation: "macos-exact-archive-member"
          }
        },
        parentIsolation: {
          commandExitCode: 0,
          commandExecutable: {
            bytes: fixture.commandExecutable.length,
            fileName: "node",
            path: fixture.commandExecutablePath,
            sha256: fixture.expected.isolationCommandExecutableSha256
          },
          commandHarness: {
            bytes: fixture.commandHarness.length,
            fileName: "runElectronUpdaterTransactionProbe.mjs",
            path: fixture.commandHarnessPath,
            sha256: fixture.expected.isolationCommandHarnessSha256
          },
          resultIdentity: {
            fileName: "macos-updater-process-isolation-result.json",
            sha256: fixture.expected.isolationResultSha256
          },
          result: {
            activeProcessesAfterCleanup: 0,
            cleanupVerified: true,
            commandInvocationSha256: MACOS_COMMAND_SHA256
          }
        }
      });
      expect(result.receipt.transaction.cases[1]).toEqual({
        isolation: "darwin-seatbelt-detached-cargo-process-group-v1",
        outcome: "applied",
        probe: "macos-bundle-replacement",
        sourceRuntime: "electron-v23",
        sourceVersion: "22.8.0",
        targetVersion: MACOS_TARGET_VERSION
      });
      expect(result.receipt.transaction.cases[2]).toEqual({
        isolation: "darwin-seatbelt-detached-cargo-process-group-v1",
        outcome: "applied",
        probe: "macos-bundle-replacement",
        sourceRuntime: "electron-v23",
        sourceVersion: "23.0.0",
        targetVersion: MACOS_TARGET_VERSION
      });
      expect(result.receipt.transaction.cases[3]).toEqual({
        isolation: "darwin-seatbelt-detached-cargo-process-group-v1",
        outcome: "applied",
        probe: "macos-helper-handoff-and-relaunch",
        sourceRuntime: "tauri-v22",
        sourceVersion: "22.8.0",
        targetVersion: MACOS_TARGET_VERSION
      });
      expect(await readdir(fixture.sealedOutputRoot)).toEqual([
        ELECTRON_UPDATER_MACOS_COMPATIBILITY_TERMINAL_RECEIPT_NAME
      ]);
      expect((await lstat(result.receiptPath)).isFile()).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it("refuses to reuse the parent-only sibling sealed root", async () => {
    const fixture = await createMacosCompatibilityFinalizerFixture();
    try {
      await finalizeMacosCompatibilityFixture(fixture);
      await expect(finalizeMacosCompatibilityFixture(fixture)).rejects.toThrow(
        "created only after child active-zero"
      );
    } finally {
      await fixture.cleanup();
    }
  });
});
