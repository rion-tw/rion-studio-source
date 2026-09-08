import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, expect, it, vi } from "vitest";

import { runUpdaterProbeWithDiagnostics } from "../scripts/electronUpdaterProbeDiagnostics.mjs";

const roots: string[] = [];
const sourceSha = "a".repeat(40);
async function output() {
  const root = await mkdtemp(join(tmpdir(), "rion-updater-observations-"));
  roots.push(root);
  return join(root, "packaged-updater-probe-observations.json");
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each(["win32", "darwin"] as const)("persists %s observations without claiming production terminality", async (platform) => {
  const outputPath = await output();
  const observations = {
    version: "8.5.0", artifactSha256: "b".repeat(64), manifestSha256: "c".repeat(64),
    cases: [{ outcome: "applied", sourceRuntime: "electron-v23" }]
  };
  await expect(runUpdaterProbeWithDiagnostics({
    run: async () => observations, outputPath, sourceSha, platform
  })).resolves.toBe(observations);
  expect(JSON.parse(await readFile(outputPath, "utf8"))).toMatchObject({
    kind: "packaged-updater-probe-diagnostics", status: "passed", sourceSha,
    platform, authoritative: false, productionTerminalReceipt: false, observations
  });
});

it("retains the original failure while recording bounded redacted command output and cause", async () => {
  const outputPath = await output();
  const primary = Object.assign(new Error("cargo failed", { cause: new Error("original Core cause") }), {
    code: "CORE_PRIMARY", stdout: "public output", stderr: "fixture-password " + "x".repeat(20000)
  });
  await expect(runUpdaterProbeWithDiagnostics({
    run: async () => { throw primary; }, outputPath, sourceSha, platform: "win32",
    privateValues: ["fixture-password"]
  })).rejects.toBe(primary);
  const source = await readFile(outputPath, "utf8");
  expect(source).not.toContain("fixture-password");
  const diagnostic = JSON.parse(source);
  expect(diagnostic).toMatchObject({ status: "failed", error: {
    code: "CORE_PRIMARY", message: "cargo failed", stdout: "public output",
    cause: { message: "original Core cause" }
  } });
  expect(diagnostic.error.stderr).toContain("[redacted]");
  expect(diagnostic.error.stderr).toContain("[truncated]");
  expect(diagnostic).not.toHaveProperty("observations");
});

it("reserves create-new output before running a transaction", async () => {
  const outputPath = await output();
  await writeFile(outputPath, "existing evidence", { flag: "wx" });
  const run = vi.fn(async () => ({}));
  await expect(runUpdaterProbeWithDiagnostics({ run, outputPath, sourceSha, platform: "win32" }))
    .rejects.toMatchObject({ code: "EEXIST" });
  expect(run).not.toHaveBeenCalled();
  expect(await readFile(outputPath, "utf8")).toBe("existing evidence");
});

it("rejects partial bindings before running and preserves legacy callers without output", async () => {
  const run = vi.fn(async () => ({ legacy: true }));
  await expect(runUpdaterProbeWithDiagnostics({ run, sourceSha, platform: "win32" }))
    .rejects.toThrow("exact source SHA");
  expect(run).not.toHaveBeenCalled();
  await expect(runUpdaterProbeWithDiagnostics({ run, platform: "darwin" }))
    .resolves.toEqual({ legacy: true });
});

it("bounds recursive aggregate diagnostics while retaining the thrown aggregate", async () => {
  const outputPath = await output();
  let primary: Error = new Error("leaf ".repeat(5000));
  for (let depth = 0; depth < 8; depth++) primary = new AggregateError(Array(8).fill(primary), "branch");
  await expect(runUpdaterProbeWithDiagnostics({
    run: async () => { throw primary; }, outputPath, sourceSha, platform: "win32"
  })).rejects.toBe(primary);
  const source = await readFile(outputPath, "utf8");
  expect(source.length).toBeLessThan(40000);
  expect(source).toContain("[diagnostic limit reached]");
});

it.skipIf(!["win32", "darwin"].includes(process.platform))(
  "records the real CLI preflight failure before any updater transaction is admitted",
  async () => {
    const outputPath = await output();
    await expect(promisify(execFile)(process.execPath, [
      resolve("scripts/runElectronUpdaterTransactionProbe.mjs"),
      "--diagnostics-output", outputPath, "--diagnostics-source-sha", sourceSha
    ], {
      env: { ...process.env, CI: "false", GITHUB_ACTIONS: "false" },
      windowsHide: true, timeout: 8000
    })).rejects.toMatchObject({ code: 1 });
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toMatchObject({
      sourceSha, platform: process.platform, status: "failed",
      error: { message: "The packaged updater transaction probe is restricted to GitHub CI." }
    });
  }
);
