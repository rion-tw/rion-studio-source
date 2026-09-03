import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { serializeCanonicalJson } from "../scripts/canonicalJson.mjs";
import {
  ELECTRON_UPDATER_COMPATIBILITY_PROVISIONAL_KIND,
  ELECTRON_UPDATER_COMPATIBILITY_PROVISIONAL_RECEIPT_NAME,
  type ElectronUpdaterCompatibilityCaseObservation,
  writeElectronUpdaterCompatibilityProvisionalReceipt
} from "../scripts/electronUpdaterCompatibilityReceiptFinalizer.mjs";
import {
  PROBE_COMPLETED_AT,
  WINDOWS_CASES
} from "./support/electronUpdaterCompatibilityFinalizerFixture";

describe("Electron updater compatibility provisional receipt", () => {
  it("writes canonical closed observations without recomputable fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "rion-updater-provisional-"));
    try {
      const outputPath = join(
        root,
        ELECTRON_UPDATER_COMPATIBILITY_PROVISIONAL_RECEIPT_NAME
      );
      const result = await writeElectronUpdaterCompatibilityProvisionalReceipt({
        cases: WINDOWS_CASES,
        outputPath,
        platform: "win32",
        probeCompletedAt: PROBE_COMPLETED_AT
      });
      const source = await readFile(outputPath);

      expect(source).toEqual(serializeCanonicalJson(result.receipt));
      expect(result.receipt).toEqual({
        schemaVersion: 2,
        kind: ELECTRON_UPDATER_COMPATIBILITY_PROVISIONAL_KIND,
        status: "provisional-awaiting-parent-isolation",
        platform: "win32",
        cases: WINDOWS_CASES,
        probeCompletedAt: PROBE_COMPLETED_AT
      });
      expect(source.toString("utf8")).not.toContain("sourceVersion");
      expect(source.toString("utf8")).not.toContain("targetVersion");
      expect(source.toString("utf8")).not.toContain("preparedInput");
      await expect(writeElectronUpdaterCompatibilityProvisionalReceipt({
        cases: WINDOWS_CASES,
        outputPath,
        platform: "win32"
      })).rejects.toThrow("create-new");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("binds macOS applied cases to the versions each probe executed", async () => {
    const root = await mkdtemp(join(tmpdir(), "rion-updater-macos-provisional-"));
    try {
      const outputPath = join(
        root,
        ELECTRON_UPDATER_COMPATIBILITY_PROVISIONAL_RECEIPT_NAME
      );
      const result = await writeElectronUpdaterCompatibilityProvisionalReceipt({
        cases: macosCases(),
        outputPath,
        platform: "darwin",
        probeCompletedAt: PROBE_COMPLETED_AT
      });

      expect(result.receipt).toMatchObject({
        schemaVersion: 2,
        platform: "darwin",
        cases: macosCases()
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects a macOS applied case whose target equals its source", async () => {
    const root = await mkdtemp(join(tmpdir(), "rion-updater-macos-self-case-"));
    const cases = macosCases();
    cases[2] = { ...cases[2], targetVersion: cases[2].sourceVersion };
    try {
      await expect(writeElectronUpdaterCompatibilityProvisionalReceipt({
        cases,
        outputPath: join(
          root,
          ELECTRON_UPDATER_COMPATIBILITY_PROVISIONAL_RECEIPT_NAME
        ),
        platform: "darwin",
        probeCompletedAt: PROBE_COMPLETED_AT
      })).rejects.toThrow("strictly newer");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

function macosCases(): ElectronUpdaterCompatibilityCaseObservation[] {
  return [
    {
      outcome: "applied",
      probe: "packaged-artifact-manifest-fail-closed",
      sourceRuntime: "electron-v23"
    },
    {
      outcome: "applied",
      probe: "macos-bundle-replacement",
      sourceRuntime: "electron-v23",
      sourceVersion: "8.4.2",
      targetVersion: "8.6.0"
    },
    {
      outcome: "applied",
      probe: "macos-bundle-replacement",
      sourceRuntime: "electron-v23",
      sourceVersion: "8.5.0",
      targetVersion: "8.6.0"
    },
    {
      outcome: "applied",
      probe: "macos-helper-handoff-and-relaunch",
      sourceRuntime: "tauri-v22",
      sourceVersion: "8.4.2",
      targetVersion: "8.6.0"
    }
  ];
}
