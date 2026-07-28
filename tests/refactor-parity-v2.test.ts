import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("refactor parity ledger v2", () => {
  it("executes every preserved behavior's exact deterministic evidence", async () => {
    const result = await runVerifier();

    expect(result.code).toBe(0);
    expect(result.output).toMatch(
      /parity v2 maps 475 source cases to \d+ canonical behaviors/
    );
  });

  it("accepts a generated report checked out with Windows line endings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rion-parity-report-"));
    const reportPath = join(directory, "parity.md");
    try {
      const report = await readFile(
        new URL("../docs/v1.37-browser-workspace-parity.md", import.meta.url),
        "utf8"
      );
      await writeFile(reportPath, report.replaceAll(/\r?\n/g, "\r\n"));

      const result = await runVerifier({ RION_STUDIO_PARITY_REPORT_PATH: reportPath });

      expect(result.code).toBe(0);
    } finally {
      await rm(directory, { recursive: true });
    }
  });

  it("forbids metadata-only evidence for every preserved behavior", async () => {
    const ledger = JSON.parse(
      await readFile(new URL("parity/refactor-behavior-ledger-v2.json", import.meta.url), "utf8")
    ) as {
      behaviors: Array<{
        evidence: Array<{ kind: string }>;
        runtimeCritical: boolean;
      }>;
      mappings: unknown[];
      policy: {
        metadataOnlyEvidenceAllowed: boolean;
      };
    };

    expect(ledger.policy).toEqual(expect.objectContaining({
      metadataOnlyEvidenceAllowed: false
    }));
    expect(ledger.policy).not.toHaveProperty("runtimeCriticalRequiresNativeGate");
    expect(ledger.mappings).toHaveLength(475);
    for (const behavior of ledger.behaviors) {
      expect(behavior.evidence.length).toBeGreaterThan(0);
      expect(behavior.evidence.every((evidence) => evidence.kind === "executable-test")).toBe(true);
      expect(behavior).not.toHaveProperty("nativeGate");
    }
  });
});

async function runVerifier(
  environment: Record<string, string> = {}
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/verifyTauriParityLedger.mjs"], {
      cwd: new URL("../", import.meta.url),
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, output }));
  });
}
