import { lstat, open } from "node:fs/promises";
import { basename, dirname, isAbsolute } from "node:path";
import { summarizeNativeProbeError } from "./nativeProbeFailureDiagnostics.mjs";

const FILE_NAME = "packaged-updater-probe-observations.json";

export async function runUpdaterProbeWithDiagnostics({
  run, outputPath, sourceSha, platform, privateValues = []
}) {
  if (!outputPath && !sourceSha) return run();
  if (
    typeof outputPath !== "string" || !isAbsolute(outputPath) ||
    basename(outputPath) !== FILE_NAME || !/^[0-9a-f]{40}$/u.test(sourceSha ?? "") ||
    !["win32", "darwin"].includes(platform)
  ) {
    throw new Error("Updater diagnostics require an absolute fixed output, exact source SHA and native platform.");
  }
  const parent = await lstat(dirname(outputPath));
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new Error("Updater diagnostic output requires a real parent directory.");
  }
  // Reserve the create-new output before any installer or transaction runs.
  // These child observations never replace parent isolation or Core receipts.
  const file = await open(outputPath, "wx", 0o600);
  let observations;
  let primaryError;
  const failures = [];
  try {
    observations = await run();
  } catch (error) {
    primaryError = error;
    failures.push(error);
  }
  try {
    await file.writeFile(JSON.stringify({
      kind: "packaged-updater-probe-diagnostics",
      authoritative: false,
      productionTerminalReceipt: false,
      sourceSha,
      platform,
      status: failures.length === 0 ? "passed" : "failed",
      completedAt: new Date().toISOString(),
      ...(failures.length === 0
        ? { observations }
        : { error: summarizeNativeProbeError(primaryError, privateValues) })
    }, null, 2) + "\n");
    await file.sync();
  } catch (error) {
    failures.push(error);
  }
  try {
    await file.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Updater probe and diagnostic persistence failures.");
  }
  return observations;
}
