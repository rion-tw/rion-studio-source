import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { throwPackagedSmokeFailureWithDiagnostics } from
  "../scripts/packagedElectronSmokeFailureDiagnostics.mjs";

const roots: string[] = [];
const packageHashes = { archiveSha256: "a".repeat(64), executableSha256: "b".repeat(64), addonSha256: "c".repeat(64) };
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "rion-packaged-failure-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it.each(["darwin", "win32"] as const)("persists %s stage and bounded primary error without changing rejection", async platform => {
  const artifactDirectory = await directory();
  const error = Object.assign(new Error("native launch failed", { cause: new Error("original native cause") }), {
    code: 1, stdout: "public observation", stderr: "fixture-secret " + "x".repeat(20000)
  });
  await expect(throwPackagedSmokeFailureWithDiagnostics({
    artifactDirectory, platform, stage: "visible-role-launch", processId: 1234,
    packageHashes, error, cleanupErrors: [], privateValues: ["fixture-secret"]
  })).rejects.toBe(error);
  const source = await readFile(join(artifactDirectory, "packaged-smoke-failure.json"), "utf8");
  expect(source).not.toContain("fixture-secret");
  expect(JSON.parse(source)).toMatchObject({
    kind: "packaged-electron-smoke-failure-diagnostics", verdict: "failed",
    authoritative: false, productionTerminalReceipt: false, platform,
    stage: "visible-role-launch", processId: 1234, packageHashes,
    error: { code: "1", message: "native launch failed", cause: { message: "original native cause" } }
  });
  expect(JSON.parse(source).error.stderr).toContain("[redacted]");
  expect(JSON.parse(source).error.stderr).toContain("[truncated]");
  await expect(readFile(join(artifactDirectory, "packaged-smoke-report.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("retains primary and cleanup errors in order without mutating their identities", async () => {
  const artifactDirectory = await directory();
  const primary = new Error("primary UI failure");
  const cleanup = new Error("native cleanup failure");
  const cleanupErrors = [cleanup];
  const result = await throwPackagedSmokeFailureWithDiagnostics({
    artifactDirectory, platform: "win32", stage: "visible-role-content",
    packageHashes, error: primary, cleanupErrors
  }).catch(error => error);
  expect(result).toBeInstanceOf(AggregateError);
  expect(result.errors).toEqual([primary, cleanup]);
  expect(result.errors[0]).toBe(primary);
  expect(cleanupErrors).toEqual([cleanup]);
  const report = JSON.parse(await readFile(join(artifactDirectory, "packaged-smoke-failure.json"), "utf8"));
  expect(report.error.errors.map((error: { message: string }) => error.message))
    .toEqual(["primary UI failure", "native cleanup failure"]);
});

it("does not overwrite earlier evidence and retains the original failure when persistence fails", async () => {
  const artifactDirectory = await directory();
  const path = join(artifactDirectory, "packaged-smoke-failure.json");
  await writeFile(path, "existing receipt", { flag: "wx" });
  const primary = new Error("primary failure");
  const result = await throwPackagedSmokeFailureWithDiagnostics({
    artifactDirectory, platform: "darwin", stage: "seed-core-fixture",
    packageHashes, error: primary, cleanupErrors: []
  }).catch(error => error);
  expect(result.errors[0]).toBe(primary);
  expect(result.errors[1].cause.code).toBe("EEXIST");
  expect(await readFile(path, "utf8")).toBe("existing receipt");
});

it("refuses a non-directory destination while preserving the primary error", async () => {
  const root = await directory();
  const artifactDirectory = join(root, "file");
  await writeFile(artifactDirectory, "existing file");
  const primary = new Error("original failure");
  const result = await throwPackagedSmokeFailureWithDiagnostics({
    artifactDirectory, platform: "win32", stage: "spawn-packaged-application",
    packageHashes, error: primary, cleanupErrors: []
  }).catch(error => error);
  expect(result.errors[0]).toBe(primary);
  expect(result.errors[1].cause.message).toContain("real artifact directory");
  expect(await readFile(artifactDirectory, "utf8")).toBe("existing file");
});
