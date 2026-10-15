import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Windows cannot prove Swift compilation or rounding semantics. The macOS unit
// gate compiles the actual helper's pure function without its AX/input entry.
describe.skipIf(process.platform !== "darwin")("Workspace resize Swift endpoint quantization", () => {
  let directory: string | undefined;
  let executable: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "rion-resize-deltas-"));
    executable = join(directory, "resize-deltas");
    await promisify(execFile)("/usr/bin/xcrun", ["swiftc", "-D", "RION_RESIZE_DELTA_TEST",
      resolve("e2e/desktop/support/workspace-window-resize.swift"),
      resolve("tests/fixtures/workspace-window-resize-deltas.swift"), "-o", executable],
    { timeout: 120_000 });
  }, 125_000);
  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("retains ordinary, reversal, half-step, and two-axis endpoint movements in real Swift", async () => {
    const { stdout } = await promisify(execFile)(executable, [], { timeout: 10_000 });
    const result = JSON.parse(stdout) as { status: string; cpuOnly: boolean; caseCount: number; cases: string[] };
    expect(result).toEqual({ status: "passed", cpuOnly: true, caseCount: 21, cases: [
      "ordinary-positive-32", "ordinary-negative-32", "ordinary-positive-48", "ordinary-negative-48",
      "ordinary-positive-half", "ordinary-negative-half", "ordinary-positive-one-and-half",
      "ordinary-negative-one-and-half", "ordinary-positive-half-origin", "ordinary-negative-half-origin",
      "ordinary-crosses-zero", "ordinary-half-origin-same-integer-endpoint", "rapid-positive-32",
      "rapid-negative-32", "rapid-positive-48", "rapid-negative-48", "rapid-positive-half",
      "rapid-negative-half", "independent-axes", "ordinary-and-rapid-round-trips", "stationary-endpoint"
    ] });
  }, 15_000);
});
