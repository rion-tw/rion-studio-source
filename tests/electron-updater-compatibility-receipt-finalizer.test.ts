import { lstat, readFile, readdir } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { serializeCanonicalJson } from "../scripts/canonicalJson.mjs";
import {
  ELECTRON_UPDATER_COMPATIBILITY_PROVISIONAL_KIND,
  ELECTRON_UPDATER_COMPATIBILITY_TERMINAL_RECEIPT_NAME
} from "../scripts/electronUpdaterCompatibilityReceiptFinalizer.mjs";
import { WINDOWS_ISOLATED_PROFILE_RESULT_NAME } from
  "../scripts/windowsIsolatedProfileResultContract.mjs";
import {
  COMMAND_SHA256,
  createCompatibilityFinalizerFixture,
  finalizeCompatibilityFixture,
  sha256,
  TARGET_SHA,
  TARGET_VERSION
} from "./support/electronUpdaterCompatibilityFinalizerFixture";

describe("Windows Electron updater compatibility receipt finalizer", () => {
  it("rebuilds a canonical terminal receipt only after parent active-zero", async () => {
    const fixture = await createCompatibilityFinalizerFixture();
    try {
      const result = await finalizeCompatibilityFixture(fixture);
      const source = await readFile(result.receiptPath);

      expect(source).toEqual(serializeCanonicalJson(result.receipt));
      expect(result.receipt.status).toBe("verified-after-parent-isolation");
      expect(result.receipt.cutoverEligible).toBe(false);
      expect(result.receipt.target).toMatchObject({
        sourceSha: TARGET_SHA,
        version: TARGET_VERSION,
        artifactName: "Rion.Studio-win.exe",
        artifactBytes: fixture.targetArtifact.length,
        artifactSha256: sha256(fixture.targetArtifact),
        preparedInputReceipt: {
          fileName: "prepared-updater-probe-input.json",
          sha256: fixture.expected.preparedInputReceiptSha256
        }
      });
      expect(result.receipt.source).toMatchObject({
        inputReceipt: {
          fileName: "verified-input-receipt.json",
          sha256: fixture.expected.tauriV22InputReceiptSha256
        },
        publicLineageReceipt: {
          fileName: "tauri-v22-public-lineage-receipt.json",
          sha256: fixture.expected.tauriV22LineageReceiptSha256
        }
      });
      expect(result.receipt.parentIsolation).toMatchObject({
        resultIdentity: {
          fileName: WINDOWS_ISOLATED_PROFILE_RESULT_NAME,
          sha256: sha256(serializeCanonicalJson(fixture.isolationResult))
        },
        result: {
          activeProcessesAfterRootExit: 0,
          cleanupVerified: true,
          commandInvocationSha256: COMMAND_SHA256
        }
      });
      expect(result.receipt.transaction.cases[1]).toEqual({
        isolation: "temporary-local-windows-user-profile-v1",
        outcome: "applied",
        probe: "windows-installed-layout-replacement-and-relaunch",
        sourceRuntime: "tauri-v22",
        sourceVersion: "22.8.0",
        targetVersion: TARGET_VERSION
      });
      expect(result.receipt.transaction.cases[2]).toMatchObject({
        sourceRuntime: "electron-v23",
        sourceVersion: "23.0.0",
        targetVersion: TARGET_VERSION
      });
      expect(await readdir(fixture.sealedOutputRoot)).toEqual([
        ELECTRON_UPDATER_COMPATIBILITY_TERMINAL_RECEIPT_NAME
      ]);
      expect((await lstat(result.receiptPath)).isFile()).toBe(true);
      expect(result.receipt.provisionalReceipt).toMatchObject({
        fileName: "provisional-layout-probe-receipt.json"
      });
      expect(ELECTRON_UPDATER_COMPATIBILITY_PROVISIONAL_KIND).toBe(
        "rion-electron-updater-compatibility-provisional-observations"
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("refuses to reuse a parent-sealed output root", async () => {
    const fixture = await createCompatibilityFinalizerFixture();
    try {
      await finalizeCompatibilityFixture(fixture);
      await expect(finalizeCompatibilityFixture(fixture)).rejects.toThrow(
        "created only after child active-zero"
      );
    } finally {
      await fixture.cleanup();
    }
  });
});
