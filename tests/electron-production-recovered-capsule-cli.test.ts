import { describe, expect, it, vi } from "vitest";

import { serializeCanonicalJson } from "../scripts/canonicalJson.mjs";
import {
  ELECTRON_PRODUCTION_RECOVERED_CAPSULE_CLI_SUMMARY_KIND,
  runElectronProductionRecoveredCapsuleCli
} from "../scripts/electronProductionRecoveredCapsuleCli.mjs";
import type {
  ElectronProductionRecoveredCapsuleVerification
} from "../scripts/electronProductionRecoveredCapsule.mjs";

const TRANSACTION_ID = "018f47a0-2d3e-7abc-8def-1234567890ab";
const CAPSULE_PATH =
  "/tmp/readback/electron-production-publication-recovery-capsule.capsule.json";
const STORE_SEAL_PATH =
  "/tmp/readback/electron-production-publication-recovery-store-seal.json";
const OUTPUT_ROOT = "/tmp/recovered-capsule";
const SHA = Object.freeze({
  capsule: "1".repeat(64),
  manifest: "2".repeat(64),
  seal: "3".repeat(64),
  lease: "4".repeat(64),
  intent: "5".repeat(64),
  source: "6".repeat(64),
  target: "7".repeat(64),
  control: "a".repeat(40)
});

describe("Electron production recovered-capsule CLI", () => {
  it("verifies the exact local capsule and seal without remote authority", async () => {
    const verification = verificationFixture();
    const verifyRecovered = vi.fn(async () => verification);
    const outputs: Buffer[] = [];

    const summary = await runElectronProductionRecoveredCapsuleCli([
      "verify-recovered",
      ...commonArguments()
    ], {
      verifyRecovered,
      writeStdout: (source) => {
        outputs.push(source);
      }
    });

    expect(verifyRecovered).toHaveBeenCalledWith(recoveredInput());
    expect(summary).toEqual({
      schemaVersion: 1,
      kind: ELECTRON_PRODUCTION_RECOVERED_CAPSULE_CLI_SUMMARY_KIND,
      command: "verify-recovered",
      status: "verified",
      verification
    });
    expect(outputs).toEqual([serializeCanonicalJson(summary)]);
    expect(Object.isFrozen(summary.verification.publisher)).toBe(true);
  });

  it("materializes only through the tokenless recovered-capsule helper", async () => {
    const verification = verificationFixture();
    const materializeRecovered = vi.fn(async () => ({
      materializedRoot: OUTPUT_ROOT,
      verification
    }));

    const summary = await runElectronProductionRecoveredCapsuleCli([
      "materialize-recovered",
      ...commonArguments(),
      "--output-root", OUTPUT_ROOT
    ], { materializeRecovered, writeStdout: () => undefined });

    expect(materializeRecovered).toHaveBeenCalledWith({
      ...recoveredInput(),
      outputRoot: OUTPUT_ROOT
    });
    expect(summary.command).toBe("materialize-recovered");
    expect(summary.status).toBe("materialized");
  });

  it.each(["token", "owner", "repo", "binding", "source-root"])(
    "rejects forbidden --%s authority before helper invocation",
    async (option) => {
      const verifyRecovered = vi.fn(async () => verificationFixture());
      await expect(runElectronProductionRecoveredCapsuleCli([
        "verify-recovered",
        ...commonArguments(),
        `--${option}`, "forbidden"
      ], { verifyRecovered })).rejects.toThrow(`Unknown verify-recovered option --${option}`);
      expect(verifyRecovered).not.toHaveBeenCalled();
    }
  );
});

function commonArguments() {
  return [
    "--capsule", CAPSULE_PATH,
    "--capsule-sha256", SHA.capsule,
    "--store-seal", STORE_SEAL_PATH,
    "--store-seal-sha256", SHA.seal,
    "--transaction-id", TRANSACTION_ID
  ];
}

function recoveredInput() {
  return {
    capsulePath: CAPSULE_PATH,
    expectedCapsuleSha256: SHA.capsule,
    expectedStoreSealSha256: SHA.seal,
    storeSealPath: STORE_SEAL_PATH,
    transactionId: TRANSACTION_ID
  };
}

function verificationFixture(): ElectronProductionRecoveredCapsuleVerification {
  const file = (fileName: string, sha256: string) => ({
    bytes: 100,
    fileName,
    sha256
  });
  return {
    schemaVersion: 1,
    kind: "rion-electron-production-recovered-capsule-verification",
    status: "verified-store-foundation",
    transactionId: TRANSACTION_ID,
    publisher: {
      repository: "rion-tw/rion-studio-source",
      workflow: ".github/workflows/electron-production-provisional-publish.yml",
      runId: "7001",
      runAttempt: 2,
      controlSha: SHA.control
    },
    capsule: {
      ...file(
        "electron-production-publication-recovery-capsule.capsule.json",
        SHA.capsule
      ),
      fileName: "electron-production-publication-recovery-capsule.capsule.json"
    },
    manifest: {
      ...file(
        "electron-production-publication-recovery-capsule-manifest.json",
        SHA.manifest
      ),
      fileName: "electron-production-publication-recovery-capsule-manifest.json"
    },
    storeSeal: {
      ...file(
        "electron-production-publication-recovery-store-seal.json",
        SHA.seal
      ),
      fileName: "electron-production-publication-recovery-store-seal.json"
    },
    foundation: {
      heldLease: file("electron-production-public-latest-lease.json", SHA.lease),
      publicationIntent: file(
        "electron-production-publication-intent-receipt.json",
        SHA.intent
      ),
      sourceSnapshot: file("source-public-latest-snapshot.json", SHA.source),
      targetSnapshot: file("target-public-latest-projection.json", SHA.target)
    }
  };
}
