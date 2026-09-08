import { lstat, open } from "node:fs/promises";
import { basename, dirname, isAbsolute } from "node:path";

const FILE_NAME = "packaged-updater-probe-observations.json";
const MAX_TEXT_CHARACTERS = 8192;

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
        : { error: summarizeError(primaryError, privateValues) })
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

function summarizeError(error, privateValues, depth = 0, budget = { nodes: 32, text: 32768 }) {
  if (budget.nodes-- <= 0 || budget.text <= 0) {
    return { message: "[diagnostic limit reached]" };
  }
  const text = (value) => {
    let result = typeof value === "string" ? value : String(value);
    for (const secret of privateValues) {
      if (typeof secret === "string" && secret.length > 0) {
        result = result.replaceAll(secret, "[redacted]");
      }
    }
    const maximum = Math.min(MAX_TEXT_CHARACTERS, budget.text);
    budget.text -= Math.min(result.length, maximum);
    return result.length > maximum
      ? result.slice(0, maximum) + " [truncated]" : result;
  };
  if (!(error instanceof Error)) return { message: text(error) };
  return {
    name: text(error.name),
    ...(error.code !== undefined ? { code: text(error.code) } : {}),
    message: text(error.message),
    ...(error.stdout !== undefined ? { stdout: text(error.stdout) } : {}),
    ...(error.stderr !== undefined ? { stderr: text(error.stderr) } : {}),
    ...(error.cause !== undefined && depth < 3
      ? { cause: summarizeError(error.cause, privateValues, depth + 1, budget) }
      : {}),
    ...(error instanceof AggregateError && depth < 3
      ? { errors: error.errors.slice(0, 8).map((item) =>
        summarizeError(item, privateValues, depth + 1, budget)) }
      : {})
  };
}
