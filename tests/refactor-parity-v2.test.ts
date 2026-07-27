import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("refactor parity ledger v2", () => {
  it("executes every preserved behavior's exact evidence and native-gate contract", async () => {
    const result = await runVerifier();

    expect(result.code).toBe(0);
    expect(result.output).toMatch(
      /parity v2 maps 475 source cases to \d+ canonical behaviors/
    );
  });

  it("forbids metadata-only evidence and requires every runtime-critical native gate in CI", async () => {
    const ledger = JSON.parse(
      await readFile(new URL("parity/refactor-behavior-ledger-v2.json", import.meta.url), "utf8")
    ) as {
      behaviors: Array<{
        evidence: Array<{ kind: string }>;
        nativeGate?: string;
        runtimeCritical: boolean;
      }>;
      mappings: unknown[];
      policy: {
        metadataOnlyEvidenceAllowed: boolean;
        runtimeCriticalRequiresNativeGate: boolean;
      };
    };

    expect(ledger.policy).toEqual(expect.objectContaining({
      metadataOnlyEvidenceAllowed: false,
      runtimeCriticalRequiresNativeGate: true
    }));
    expect(ledger.mappings).toHaveLength(475);
    for (const behavior of ledger.behaviors) {
      expect(behavior.evidence.length).toBeGreaterThan(0);
      expect(behavior.evidence.every((evidence) => evidence.kind === "executable-test")).toBe(true);
      if (behavior.runtimeCritical) expect(behavior.nativeGate).toMatch(/^test:native:/);
    }
  });
});

async function runVerifier(): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/verifyTauriParityLedger.mjs"], {
      cwd: new URL("../", import.meta.url),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, output }));
  });
}
